# superpi — spec-graph 기반 페이즈 파이프라인

superpi 는 **헤비한 멀티페이즈 과제** 전용 자율 오케스트레이터다. 가벼운 작업은
대상이 아니다(그건 그냥 메인 에이전트가 한다). 무거운 과제를 spec-graph 의 타입
그래프 위에서 페이즈 단위로 쪼개 — 각 페이즈를 계획·구현·검증 게이트로 통과시키며
끝까지 자율 전진한다.

## 두 개의 강제 축 (왜 spec-graph + superpi 인가)

| 축 | 강제 주체 | 강제 내용 |
|---|---|---|
| **구조/의미** | spec-graph CLI | 미해결 question·미완화 risk 없이는 phase 종료 불가(`gates`, exit 2). 영속 그래프, impact 분석, covers/delivers 추적, plan_coverage. |
| **순서/증거** | superpi 전이 툴 | 페이즈 순서(setActiveTools 게이팅), 실제 빌드·테스트 실행, reviewer subagent 사인오프. |

둘은 상호보완이다. **CLI 실측(v0.3.4)으로 확인된 한계**: `gates` 체크는 phase
resolved 를 실제로 차단하지만 `delivery_completeness` 는 "covered 인데 delivers 0"
을 못 잡는다(빈 검증 통과). 그래서 spec-graph 단독으로는 검증 진위를 보증 못 한다 —
superpi 가 reviewer + 빌드/테스트로 그 구멍을 메운다.

## 결합 강도 (사용자 확정: 무조건 강제)

superpi 실행 시 `.spec-graph/` 가 없으면 **자동 init + spec-planner 로 그래프 생성**
한다. spec-graph 없이는 superpi 가 돌지 않는다. 헤비 전제라 이 비용은 정당하다.

## 페이즈 모델 (사용자 확정: A — superpi 가 phase 루프)

spec-graph 는 한 PLN 안에 PHS 여러 개(PHS-001, 002, …)를 둔다. superpi 는 그
PHS 들을 **바깥에서 순회**하면서, 각 PHS 마다 내부 PLAN→WORK→VERIFY 를 돈다.

```
                         ┌──────────── SETUP (1회) ───────────┐
 /superpi <objective> ─▶ │ .spec-graph/ 없으면 init           │
                         │ spec-planner 위임 → PLN+PHS+covers │
                         │ 3-layer validate 통과              │
                         └──────────────┬─────────────────────┘
                                        ▼
                  ┌──────── OUTER LOOP: spec-graph phase next ────────┐
                  │  (eligible PHS 활성화, scope 조회)                 │
                  ▼                                                   │
   ┌─────────┐ plan_ready  ┌──────────────┐ approved  ┌──────┐       │
   │  PLAN   │───────────▶ │ PLAN_REVIEW  │─────────▶ │ WORK │       │
   │(executor│             │(reviewer +   │           │(coord│       │
   │ scope)  │◀──replan────│ graph valid) │           │ +    │       │
   └─────────┘             └──────────────┘           │ exec)│       │
                                                       └──┬───┘       │
                          ┌──── verify_fail ◀────┐    work_done       │
                          ▼                       │       ▼           │
                     (WORK 복귀)                  │  ┌─────────┐      │
                                                  └──│ VERIFY  │      │
                                          verify_pass│(verifier│      │
                                            ┌────────│ +build/ │      │
                                            │        │ test +  │      │
                                            ▼        │reviewer)│      │
                            spec-graph entity update └─────────┘      │
                            PHS-XXX --status resolved (CLI gate)      │
                                            │                         │
                                  성공 ─────┴── phase next ───────────┘
                                            │
                                    no eligible phase
                                            ▼
                                         🏁 DONE
```

### 각 페이즈가 하는 일 (spec-graph 스킬 1:1 대응)
- **SETUP** (최초 1회): `.spec-graph/` 없으면 `spec-graph init`. 그 후
  spec-planner 스킬 절차로 REQ/DEC/ACT/RSK + PLN/PHS + covers 등록, 3-layer
  validate. superpi 는 이걸 메인에게 시키되(읽기전용 도구 + spawn_subagents),
  검증은 `spec-graph validate` exit code 로 확인.
- **PLAN** (per PHS): `spec-graph phase next --activate` 로 다음 PHS 활성화 →
  `spec-graph query scope <PHS>` 로 그 페이즈가 cover 하는 arch 엔티티 파악 →
  그 범위에 대한 구체 실행계획 수립(plan 프리셋 위임). edit 비활성.
- **PLAN_REVIEW**: reviewer 프리셋이 플랜 검증 + `spec-graph validate --layer
  arch --check unresolved` 로 미해결 항목 확인. 통과 시 WORK, 아니면 replan.
- **WORK**: spec-executor 절차 — impact 분석, 구현(general 위임 우선), 발견된
  API/STT/TST/QST 등록, 완료분 `delivers` 추가. edit/write 활성.
- **VERIFY**: spec-verifier 절차 — 빌드/테스트 실제 실행, reviewer 최종 사인오프,
  `delivers` 정확성 확인. 통과하면 `phase_verify_pass` 가 **superpi 내부에서
  `spec-graph entity update <PHS> --status resolved` 를 직접 shell-out** 한다.
  CLI 가 exit 2 로 막으면(미해결 gate) phase_verify_pass 는 거부되고 VERIFY 에
  머문다. edit 비활성.

### 게이트 신뢰 (사용자 확정: CLI 게이트 + 실제 검증 병행)
`phase_verify_pass` 가 통과하려면 **셋 다** 충족:
1. reviewer subagent 사인오프 (runId 필수 파라미터).
2. 빌드/테스트 증거 (evidence 필수 파라미터).
3. `spec-graph entity update <PHS> --status resolved` 가 exit 0 (CLI gate 통과).
   → 이건 superpi 가 직접 실행해 exit code 로 판정. 모델 주장 아님.

## PLAN 인터뷰 + 사람 승인 게이트 (OmO Prometheus 이식)

OmO 의 plan(Prometheus)이 헤비 과제의 성패를 가른다는 통찰을 이식했다. 두 축:

1. **PLAN 인터뷰** — PLAN 페이즈가 단발 위임이 아니라, 모델이 `ask_question`
   (없으면 `questionnaire`)으로 **사용자에게 직접 질문**해 모호성을 없앤 뒤에야
   제출하게 한다. clearance checklist(핵심 목표/스코프 IN·OUT/critical 모호성/
   기술 접근/테스트 전략)가 전부 YES 여야 `phase_plan_ready` 가능. "의도가
   불확실하면 묻고, 합리적 기본값은 적용 후 공개". 산출 plan 은 병렬-wave 태스크
   그래프 + 태스크별 관찰가능 검증을 담는다(OmO planner.md 구조).

2. **사람 승인 게이트** — AI reviewer(PLAN_REVIEW)가 통과해도 **WORK 직행 금지**.
   `phase_plan_approved` 가 `ctx.ui.select` 로 사용자에게 plan 을 제시하고
   3택을 받는다:
   - **Approve & start work** → WORK 진입.
   - **Refine the plan** → `ctx.ui.input` 으로 수정 방향을 받아 PLAN 으로 복귀
     (reviewHistory 에 `[user-refine]` 누적).
   - **Block** (또는 UI 취소=undefined) → BLOCKED, 루프 정지.
   UI 없는 print 모드에선 select 가 undefined → **자율 진행(WORK)** 으로 폴백
   (비대화형에서 멈추지 않게). 즉 대화형에서만 사람 게이트가 실제로 작동한다.

reviewer 프리셋은 2-모드로 갱신: PLAN 리뷰는 **approval-bias**(blocker-finder,
max 3 issue — 무한 replan 방지), CHANGE 리뷰(VERIFY)는 기존대로 adversarial.

## spec-graph CLI 연동 (pi.exec)

전이 툴 `execute()` 안에서:
```ts
const r = await pi.exec("spec-graph", ["entity","update",phsId,"--status","resolved"], { cwd: ctx.cwd, timeout: 30000 });
// r.code === 0 → 게이트 통과. r.code === 2 → blocked, r.stdout JSON 의 issues[] 를 모델에 환류.
```
- cwd 는 `ctx.cwd` (프로젝트 루트). spec-graph 는 `.spec-graph/` 를 cwd 기준 탐색.
- JSON stdout 파싱. `phase next` 의 "all resolved" 는 exit 0 + `{error:{code:"INVALID_INPUT"}}` 이므로 stdout JSON 으로 판정(DONE 신호).
- CLI 미설치/`.spec-graph/` 부재는 SETUP 단계에서 처리.

## 상태 (PipelineState 확장)

기존 PLAN/WORK/VERIFY 에 더해:
- `phase: "SETUP" | "PLAN" | ...` — SETUP 추가.
- `phsId?: string` — 현재 작업 중인 spec-graph PHS id (phase next 결과).
- spec-graph 연동은 전부 `ctx.cwd` 기준 `pi.exec`.

## 루프/subagent 공존 (기존 유지)

- subagent in-flight 턴(spawn_subagents 호출됨)에는 continuation 재투입 억제.
- 전이 툴 호출 턴에는 중복 kick 방지.
- 자식(PI_SUBAGENT)에서 superpi 미등록.
- abort(Esc)/pause/resume/clear/budget — goal 식 그대로.

## 정직한 경계

- spec-graph `delivery_completeness` 게이트가 빈 검증을 통과시키므로(실측),
  "phase resolved" 자체가 구현 완성을 보증하진 않는다. reviewer 사인오프 +
  빌드/테스트가 그 보강이다. 그래도 "모델이 reviewer 를 진짜 띄웠는지"는 여전히
  못 본다(runId 필수화로 위조 비용만 ↑).
- spec-planner/executor/verifier 스킬 절차는 superpi 가 프롬프트로 모델에게
  수행시키는 것이지, superpi 가 그 스킬 로직을 코드로 재구현하는 게 아니다.
  superpi 가 코드로 강제하는 건 (a) 페이즈 순서·도구 게이팅, (b) phase resolved
  의 CLI exit code 게이트뿐.

## 파일

```
extensions/superpi/index.ts        (spec-graph 연동 추가)
extensions/superpi/DESIGN.md       (이 문서)
extensions/superpi/harness.test.ts (spec-graph exec 모킹 보강)
extensions/superpi/run-harness.sh  (유지)
extensions/superpi/package.json    (유지)
```

Makefile 글로벌 승격은 실험·검증 후 사용자 승인. 현재는 superpi-test 로컬 로드만.

## evidence / notes / decisions 규율 (OmO notepad/evidence 이식)

"AI 가 말로 때우는 것"을 막기 위해 셋을 디스크/그래프에 박는다:

- **decisions → spec-graph DEC 엔티티**: WORK 에서 아키텍처 선택 시 `spec-graph
  entity add --type decision`(rationale + 영향 REQ 에 `constrained_by`). 마크다운
  파일이 아니라 타입 그래프에 — impact 분석에 걸리고 영속.
- **evidence → 파일 + 기계 검증**: `phase_verify_pass` 가 `evidencePath` 필수.
  superpi 가 그 파일 존재를 `existsSync(ctx.cwd 기준)` 로 확인하고, 없으면 게이트
  거부(VERIFY 유지). 모델 주장이 아니라 디스크에 증거가 있어야 통과.
- **notes → append-only 노트패드**: `superpi_note` 툴(kind=learnings/issues/
  decisions/problems)이 `.superpi/notes/<slug>/<kind>.md` 에 append. write/edit 로
  그 경로를 건드리면 tool_call 가드(notepad-write-guard)가 차단 — 덮어쓰기 방지.
  과거 notes 는 매 페이즈 프롬프트에 주입돼 페이즈·세션 간 이월.

## 추가 강제 (OmO 이식)

- **mandatory task decomposition** (start-work 게이트): PLAN 산출 plan 이 파일/함수
  단위 sub-step 까지 분해돼야 함. "implement the feature" 같은 모호 task 금지.
- **continuous verification**: WORK 에서 매 wave 후 빌드/테스트 확인, 깨지면 STOP.
  VERIFY 에만 몰지 않음.
- **parallel final review (F1–F4)**: VERIFY 의 최종 리뷰를 reviewer 여러 명 병렬로
  — F1 plan-compliance / F2 code-quality / F3 real-QA / F4 scope-fidelity, 전원 승인.

## file-guards (별도 글로벌 익스텐션, superpi 와 독립)

OmO write-existing-file-guard + edit-error-recovery 를 이식한 항상-켜진 가드:
- `write` 가 "존재 + 이번 세션 미read" 파일을 덮어쓰려 하면 tool_call 차단(blind
  clobber 방지). read/edit 한 파일이거나 신규 파일이면 허용.
- `edit` 실패(oldText 못 찾음) 시 tool_result 에 "파일 재read 후 정확한 oldText 로
  재시도" 교정 지침 주입.
`extensions/file-guards/`, ALL_EXTENSIONS 등록(글로벌).

## 검증 계획

- `make check` (tsc) 통과.
- 하니스: 페이즈 게이팅 + spec-graph exec 모킹(phase next/resolved gate/scope)으로
  - SETUP→PLAN 전이가 `.spec-graph/` 유무에 맞게,
  - phase_verify_pass 가 `spec-graph ... resolved` exit 2(blocked)면 거부되고 VERIFY 유지,
  - exit 0 이면 DONE 또는 phase next 로 다음 PHS,
  - phase next 가 "all resolved" JSON 이면 DONE,
  를 단언.
- 라이브: 실제 `.spec-graph/` 있는 임시 프로젝트에서 `/superpi` 로 전이별 CLI
  호출이 맞는 cwd 로 나가는지(스모크).
