// Shared session lock protocol (exclusive + forced takeover model).
//
// Principles:
//   - A single session file can be written by exactly one holder, always, without exception.
//   - pi (TUI/CLI) locks via an extension, pi-web via the backend, both using the "same protocol".
//   - No automatic expiry (stale timeout). Ownership changes only when the holder explicitly
//     releases, or the other side performs a "force takeover".
//   - A takeover simply overwrites with a new record. The existing holder knows it has lost
//     ownership on its own because "the token on disk is no longer my token" (no separate revoke marker needed).
//
// Since pi does not place an OS file lock on the session jsonl (concurrent writes = data loss),
// this advisory lock fills that gap. It's only valid when both sides honor the protocol.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface LockRecord {
  /** Absolute path of the session file the lock protects */
  sessionPath: string;
  /** Holder type */
  owner: "pi" | "pi-web";
  /** PID of the holding process */
  pid: number;
  /** Machine hostname */
  host: string;
  /** Human-readable label ("TUI", "pi-web", session name, etc.) */
  label?: string;
  /** Acquisition time (epoch ms) */
  since: number;
  /**
   * Unique token for this holding instance.
   * Decision criterion — if the disk token differs from my token, "it's not my lock".
   */
  token: string;
}

export type LockState =
  | { state: "free" } // nobody holds it
  | { state: "mine"; record: LockRecord } // I hold it
  | { state: "lost"; record?: LockRecord }; // I held it but it's no longer mine
//   (someone took it over or the lock vanished → signal to downgrade to read-only. no record means it vanished)

function defaultLockDir(): string {
  const agentDir =
    process.env.PI_AGENT_DIR ||
    join(process.env.HOME || process.env.USERPROFILE || ".", ".pi", "agent");
  return join(agentDir, "locks");
}

function keyFor(sessionPath: string): string {
  return createHash("sha1").update(sessionPath).digest("hex").slice(0, 16);
}

function newToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * An exclusive lock on a single session file.
 * Instantiated identically on both the extension and pi-web sides.
 */
export class SessionLock {
  private readonly file: string;
  private readonly dir: string;
  private readonly sessionPath: string;
  private readonly owner: "pi" | "pi-web";
  private readonly label?: string;
  /** Token for this holding instance. Issued on acquire/takeover. */
  private myToken: string | null = null;

  constructor(
    sessionPath: string,
    owner: "pi" | "pi-web",
    label?: string,
    lockDir: string = defaultLockDir(),
  ) {
    this.sessionPath = sessionPath;
    this.owner = owner;
    this.label = label;
    this.dir = lockDir;
    this.file = join(lockDir, `${keyFor(sessionPath)}.json`);
  }

  /** Read the current lock record from disk (null if absent, null if corrupt). */
  private read(): LockRecord | null {
    if (!existsSync(this.file)) return null;
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as LockRecord;
    } catch {
      return null;
    }
  }

  /**
   * Lock state from my perspective.
   * - free : nobody holds it
   * - mine : the disk token matches my token (I hold it)
   * - lost : everything else — I acquired it at some point (have myToken) but the disk is
   *          empty or the token changed. "It's not mine" is enough as a single category.
   *
   * If there's no myToken (never acquired), it resolves only to free or lost (= held by someone else).
   */
  state(): LockState {
    const rec = this.read();
    if (!this.myToken) {
      // Never acquired yet: free if empty, lost (= held) if someone is there
      return rec ? { state: "lost", record: rec } : { state: "free" };
    }
    // Acquired before: only mine if the disk token equals mine
    if (rec && rec.token === this.myToken) return { state: "mine", record: rec };
    return { state: "lost", record: rec ?? undefined };
  }

  /**
   * Attempt to acquire the lock. No automatic takeover.
   * - If free, acquire it.
   * - If already my lock, refresh (label, etc.) and succeed.
   * - If someone else holds it, fail and return the current holder's record.
   *   To force it, takeover() must be called explicitly.
   */
  tryAcquire(): { acquired: boolean; current?: LockRecord } {
    const rec = this.read();
    // Dead (orphan) lock — one left behind by a crashed process is auto-reacquired (no force needed).
    if (rec && !(this.myToken && rec.token === this.myToken) && !isStaleRecord(rec)) {
      return { acquired: false, current: rec };
    }
    this.myToken = newToken();
    this.write({
      sessionPath: this.sessionPath,
      owner: this.owner,
      pid: process.pid,
      host: hostname(),
      label: this.label,
      since: rec?.since ?? Date.now(),
      token: this.myToken,
    });
    return { acquired: true };
  }

  /**
   * Force takeover. Overwrites with a new record regardless of who the existing holder is.
   * On its next state() check, the existing holder sees the disk token has changed and
   * concludes "lost" on its own.
   */
  takeover(): { takenFrom?: LockRecord } {
    const prev = this.read();
    this.myToken = newToken();
    this.write({
      sessionPath: this.sessionPath,
      owner: this.owner,
      pid: process.pid,
      host: hostname(),
      label: this.label,
      since: Date.now(),
      token: this.myToken,
    });
    return { takenFrom: prev ?? undefined };
  }

  /** One-shot check of whether I lost the lock (taken over or vanished). */
  isLost(): boolean {
    return this.state().state === "lost";
  }

  /** Check whether it's my lock. */
  isMine(): boolean {
    return this.state().state === "mine";
  }

  /** Release the lock. Removes it only if it's my lock (doesn't touch others'/taken-over locks). */
  release() {
    const st = this.state();
    if (st.state === "mine") {
      try {
        rmSync(this.file, { force: true });
      } catch {
        /* best-effort */
      }
    }
    this.myToken = null;
  }

  private write(rec: LockRecord) {
    mkdirSync(this.dir, { recursive: true });
    // Atomic write: write to temp then rename
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec));
    renameSync(tmp, this.file);
  }
}

/** Surveys all locks (for pi-web dashboard's "who holds what" display). */
// Whether the PID is still alive (relative to the same host). If undeterminable, assume alive (safe).
function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = check existence only
    return true;
  } catch (e: unknown) {
    return (e as { code?: string })?.code === "EPERM"; // EPERM=alive, ESRCH=gone
  }
}

/** Whether it's a dead (orphan) lock — same host but the holding PID is already dead. */
export function isStaleRecord(rec: LockRecord): boolean {
  let host = "";
  try {
    host = hostname();
  } catch {
    /* ignore */
  }
  if (rec.host && host && rec.host !== host) return false; // different machine → undeterminable
  return !pidAlive(rec.pid);
}

export function listLocks(lockDir: string = defaultLockDir()): LockRecord[] {
  if (!existsSync(lockDir)) return [];
  const out: LockRecord[] = [];
  for (const f of readdirSync(lockDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(lockDir, f), "utf8")) as LockRecord;
      if (isStaleRecord(rec)) {
        // Quietly clean up dead orphan lock files (prevents fake "live" entries left by a crashed backend).
        try {
          rmSync(join(lockDir, f), { force: true });
        } catch {
          /* ignore */
        }
        continue;
      }
      out.push(rec);
    } catch {
      /* skip corrupted locks */
    }
  }
  return out;
}
