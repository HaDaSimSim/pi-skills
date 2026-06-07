// file-guards — an always-on, general-purpose file safety guard. Applies to every session.
//
// Ports OmO's write-existing-file-guard + edit-error-recovery to pi.
// Both follow the principle of "don't trust the AI's self-report; block dangerous file operations in code."
//
// (5) write-existing-file-guard:
//     When `write` tries to wholesale overwrite a file that "already exists but hasn't been read this session,"
//     block it at the tool_call stage. This prevents the model from blind-clobbering a file whose contents it
//     doesn't know. Allowed if the file was read first, is a new file, or is one we just let through.
//
// (6) edit-error-recovery:
//     When `edit` fails (oldText not found / ambiguous), append a corrective instruction to the tool_result:
//     "re-read the file, confirm the exact oldText, then retry." This reduces the model burning tokens by
//     repeating the same mistake.
//
// Install: ~/.pi/agent/extensions/file-guards/ (symlinked by make install)

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Absolute paths of files whose contents we learned this session (via read, or a write/edit we let through).
  const knownFiles = new Set<string>();

  const abs = (cwd: string, p: string): string => (isAbsolute(p) ? p : resolve(cwd, p));

  // Reset tracking when the session changes (so read records from another session don't leak in).
  pi.on("session_start", async () => {
    knownFiles.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    const cwd = ctx.cwd;

    // read → record that we "know" that file.
    if (event.toolName === "read") {
      const p = (event.input as { path?: string }).path;
      if (p) knownFiles.add(abs(cwd, p));
      return;
    }

    // edit → treat the target file as effectively known too (you must know oldText to edit it).
    if (event.toolName === "edit") {
      const p = (event.input as { path?: string }).path;
      if (p) knownFiles.add(abs(cwd, p));
      return;
    }

    // write → guard.
    if (event.toolName === "write") {
      const p = (event.input as { path?: string }).path;
      if (!p) return;
      const full = abs(cwd, p);

      // Creating a new file is always allowed.
      if (!existsSync(full)) {
        knownFiles.add(full); // It's now a file we created, so allow subsequent overwrites.
        return;
      }
      // Allow if already read (= contents known), or if it's a file we let through.
      if (knownFiles.has(full)) return;

      // Exists + not known → block the blind clobber.
      return {
        block: true,
        reason:
          `file-guards: refusing to overwrite existing file you haven't read this session: ${p}. ` +
          `Read it first (so you don't clobber content you can't see), then use edit for a targeted change, ` +
          `or write again if a full rewrite is truly intended.`,
      };
    }
  });

  // Inject corrective instructions when edit fails.
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "edit" || !event.isError) return;
    const p = (event.input as { path?: string }).path ?? "the file";
    const existing = event.content ?? [];
    return {
      content: [
        ...existing,
        {
          type: "text" as const,
          text:
            `\n\n[file-guards] The edit failed. Before retrying:\n` +
            `1. Re-read ${p} to see its CURRENT exact contents (it may differ from what you assumed).\n` +
            `2. Copy oldText VERBATIM from the file — exact whitespace, indentation, and newlines. ` +
            `pi's edit matches oldText literally and it must be unique in the file.\n` +
            `3. If the region appears more than once, include enough surrounding context to make oldText unique.\n` +
            `Do not retry the same oldText blindly — that will fail again.`,
        },
      ],
    };
  });
}
