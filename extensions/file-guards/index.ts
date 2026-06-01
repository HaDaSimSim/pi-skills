// file-guards — 항상 켜진 범용 파일 안전 가드. superpi 와 무관하게 모든 세션에 적용.
//
// OmO 의 write-existing-file-guard + edit-error-recovery 를 pi 로 이식한다.
// 둘 다 "AI 의 자기보고를 안 믿고, 위험한 파일 조작을 코드로 막는다"는 정신.
//
// (5) write-existing-file-guard:
//     `write` 가 "이미 존재하는데 이번 세션에서 읽지 않은" 파일을 통째로 덮어쓰려 하면
//     tool_call 단계에서 차단한다. 모델이 파일 내용을 모른 채 blind clobber 하는 사고를
//     막는다. 먼저 read 한 파일이거나, 새 파일이거나, 직전에 우리가 통과시킨 파일이면 허용.
//
// (6) edit-error-recovery:
//     `edit` 가 실패(oldText 못 찾음/모호)하면, tool_result 에 "파일을 다시 읽고 정확한
//     oldText 를 확인한 뒤 재시도하라"는 교정 지침을 덧붙인다. 모델이 같은 실수를 반복하며
//     토큰을 태우는 걸 줄인다.
//
// 설치: ~/.pi/agent/extensions/file-guards/ (make install 이 symlink)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export default function (pi: ExtensionAPI) {
  // 이번 세션에서 read(또는 우리가 통과시킨 write/edit 로) 내용을 알게 된 파일 절대경로.
  const knownFiles = new Set<string>();

  const abs = (cwd: string, p: string): string => (isAbsolute(p) ? p : resolve(cwd, p));

  // 세션이 바뀌면 추적 초기화 (다른 세션의 read 기록이 새지 않게).
  pi.on("session_start", async () => {
    knownFiles.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    const cwd = ctx.cwd;

    // read → 그 파일을 "안다"고 기록.
    if (event.toolName === "read") {
      const p = (event.input as { path?: string }).path;
      if (p) knownFiles.add(abs(cwd, p));
      return;
    }

    // edit → 대상 파일도 사실상 내용 인지 상태로 본다(편집하려면 oldText 를 알아야 하므로).
    if (event.toolName === "edit") {
      const p = (event.input as { path?: string }).path;
      if (p) knownFiles.add(abs(cwd, p));
      return;
    }

    // write → 가드.
    if (event.toolName === "write") {
      const p = (event.input as { path?: string }).path;
      if (!p) return;
      const full = abs(cwd, p);

      // 새 파일 생성은 항상 허용.
      if (!existsSync(full)) {
        knownFiles.add(full); // 이제 우리가 만든 파일이므로 이후 덮어쓰기 허용.
        return;
      }
      // 이미 읽었거나(=내용 인지), 우리가 통과시킨 파일이면 허용.
      if (knownFiles.has(full)) return;

      // 존재 + 미인지 → blind clobber 차단.
      return {
        block: true,
        reason:
          `file-guards: refusing to overwrite existing file you haven't read this session: ${p}. ` +
          `Read it first (so you don't clobber content you can't see), then use edit for a targeted change, ` +
          `or write again if a full rewrite is truly intended.`,
      };
    }
  });

  // edit 실패 시 교정 지침 주입.
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
