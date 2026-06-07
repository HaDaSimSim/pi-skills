// 공유 세션 락 규약 (배타 + 강제 탈취 모델).
//
// 원칙:
//   - 한 세션 파일은 "항상, 무조건" 한 점유자만 쓸 수 있다.
//   - pi(TUI/CLI) 는 extension 으로, pi-web 은 백엔드로, "같은 규약"으로 락을 건다.
//   - 자동 만료(stale timeout) 없음. 점유자가 명시적으로 release 하거나,
//     다른 쪽이 "강제 탈취(force takeover)" 할 때만 주인이 바뀐다.
//   - 탈취는 그냥 새 레코드로 덮어쓴다. 기존 점유자는 "디스크의 토큰이 더 이상
//     내 토큰이 아니다"로 스스로 잃었음을 안다 (별도 revoke 표식 불필요).
//
// pi 는 세션 jsonl 에 OS 파일 락을 걸지 않으므로(동시 쓰기 = 데이터 손실),
// 이 어드바이저리 락이 그 사각지대를 메운다. 양쪽이 규약을 지킬 때만 유효하다.

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
  /** 락이 보호하는 세션 파일 절대경로 */
  sessionPath: string;
  /** 점유자 종류 */
  owner: "pi" | "pi-web";
  /** 점유 프로세스 PID */
  pid: number;
  /** 머신 호스트명 */
  host: string;
  /** 사람이 읽을 라벨 ("TUI", "pi-web", 세션 이름 등) */
  label?: string;
  /** 점유 시각 (epoch ms) */
  since: number;
  /**
   * 이 점유 인스턴스의 고유 토큰.
   * 판정 기준 — 디스크 토큰이 내 토큰과 다르면 "내 락이 아니다".
   */
  token: string;
}

export type LockState =
  | { state: "free" } // 아무도 안 잡음
  | { state: "mine"; record: LockRecord } // 내가 잡고 있음
  | { state: "lost"; record?: LockRecord }; // 내가 잡았었지만 더 이상 내 것이 아님
//   (남이 탈취했거나 락이 사라짐 → 읽기전용으로 강등 신호. record 없으면 사라진 것)

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
 * 한 세션 파일에 대한 배타 락.
 * extension 과 pi-web 양쪽에서 동일하게 인스턴스화한다.
 */
export class SessionLock {
  private readonly file: string;
  private readonly dir: string;
  private readonly sessionPath: string;
  private readonly owner: "pi" | "pi-web";
  private readonly label?: string;
  /** 이번 점유 인스턴스의 토큰. acquire/takeover 시 발급된다. */
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

  /** 디스크의 현재 락 레코드를 읽는다 (없으면 null, 손상 시 null). */
  private read(): LockRecord | null {
    if (!existsSync(this.file)) return null;
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as LockRecord;
    } catch {
      return null;
    }
  }

  /**
   * 내 관점에서의 락 상태.
   * - free : 아무도 안 잡음
   * - mine : 디스크 토큰이 내 토큰과 일치 (내가 보유)
   * - lost : 그 외 전부 — 한 번이라도 잡았다가(myToken 보유) 디스크가 비었거나
   *          토큰이 바뀐 경우. "내 게 아니다"는 하나로 충분하다.
   *
   * myToken 이 없으면(아직 안 잡아봄) free 또는 lost(=남이 점유)로만 갈린다.
   */
  state(): LockState {
    const rec = this.read();
    if (!this.myToken) {
      // 아직 잡아본 적 없음: 비었으면 free, 누가 있으면 lost(=held)
      return rec ? { state: "lost", record: rec } : { state: "free" };
    }
    // 잡아본 적 있음: 디스크 토큰이 내 것과 같아야만 mine
    if (rec && rec.token === this.myToken) return { state: "mine", record: rec };
    return { state: "lost", record: rec ?? undefined };
  }

  /**
   * 락을 시도한다. 자동 탈취 없음.
   * - free 이면 잡는다.
   * - 이미 내 락이면 갱신(라벨 등) 후 성공.
   * - 남이 잡고 있으면 실패하고 현재 점유자 레코드를 돌려준다.
   *   강제로 가져오려면 takeover() 를 명시적으로 호출해야 한다.
   */
  tryAcquire(): { acquired: boolean; current?: LockRecord } {
    const rec = this.read();
    // 죽은(orphan) 락—크래시한 프로세스가 남긴 건 자동 재획득 (force 불필요).
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
   * 강제 탈취. 기존 점유자가 누구든 새 레코드로 덮어쓴다.
   * 기존 점유자는 다음 state() 확인 때 디스크 토큰이 바뀐 걸 보고
   * 스스로 "lost" 로 판정한다.
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

  /** 내가 락을 잃었는지 1회 확인 (탈취당했거나 사라짐). */
  isLost(): boolean {
    return this.state().state === "lost";
  }

  /** 내 락인지 확인. */
  isMine(): boolean {
    return this.state().state === "mine";
  }

  /** 락 해제. 내 락일 때만 제거한다 (남의/탈취된 락은 안 건드림). */
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
    // 원자적 쓰기: temp 에 쓰고 rename
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec));
    renameSync(tmp, this.file);
  }
}

/** 모든 락을 조망한다 (pi-web 대시보드의 "누가 뭘 점유 중" 표시용). */
// PID 가 아직 살아있는지 (같은 호스트 기준). 판정 불가면 살아있다고 본다(안전).
function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0); // 시그널 0 = 존재 여부만 확인
    return true;
  } catch (e: unknown) {
    return (e as { code?: string })?.code === "EPERM"; // EPERM=살아있음, ESRCH=없음
  }
}

/** 죽은(orphan) 락인지 — 같은 호스트인데 점유 PID 가 이미 죽은 경우. */
export function isStaleRecord(rec: LockRecord): boolean {
  let host = "";
  try {
    host = hostname();
  } catch {
    /* ignore */
  }
  if (rec.host && host && rec.host !== host) return false; // 다른 머신 → 판정 불가
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
        // 죽은 orphan 락 파일은 조용히 정리 (크래시한 백엔드가 남긴 가짜 "라이브" 방지).
        try {
          rmSync(join(lockDir, f), { force: true });
        } catch {
          /* ignore */
        }
        continue;
      }
      out.push(rec);
    } catch {
      /* 손상된 락은 건너뜀 */
    }
  }
  return out;
}
