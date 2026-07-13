# hook-coordinator — Registration contract

Other pi extensions contribute prompt sections and continuation intents
through this coordinator. Only ONE extension (the coordinator) registers the
raw `before_agent_start` and `agent_end` handlers — everyone else uses the
event-bus contracts below.

## before_agent_start: Prompt sections

### Events

#### `hook-coordinator:register-section` (emit)

Payload (`SectionRegistration`):

```ts
{
  name: string;          // unique identifier; re-registration overwrites
  priority: number;      // lower = appended earlier (appears first after base prompt)
  getText: () => string | undefined;  // called at each before_agent_start
}
```

A section whose `getText()` returns `undefined` or `""` is skipped — no blank
line is injected.

### Recommended contributor pattern

```ts
const section = {
  name: "my-extension",
  priority: 200,
  getText: () => buildMyPrompt(),
};

// Immediate attempt (works if coordinator already loaded).
pi.events.emit("hook-coordinator:register-section", section);

// Fallback for late coordinator: re-emit when coordinator signals ready.
pi.events.on("hook-coordinator:ready", () => {
  pi.events.emit("hook-coordinator:register-section", section);
});
```

Double-emission is harmless — the coordinator deduplicates by `name`.

---

## agent_end: Continuation intents (C2)

### Events

#### `hook-coordinator:register-continuation` (emit)

Payload (`ContinuationIntent`):

```ts
{
  name: string;              // unique identifier; re-registration overwrites
  priority: number;          // lower = higher priority (checked first)
  decide: () => ContinuationDescriptor | undefined;
}
```

`ContinuationDescriptor`:

```ts
{
  prompt: string;            // the user message to inject (next turn's prompt)
  deliverAs?: "followUp";    // optional: queue if still streaming
}
```

`decide()` is called at each `agent_end`. Return `undefined` to abstain
(no continuation wanted this turn). Return a `ContinuationDescriptor` to
request continuation.

**The arbiter injects EXACTLY ONE continuation per agent_end** — the
first non-abstaining intent by priority order wins.

### Subagent hold

While background subagents are running (tracked via the `subagents:running`
event broadcast by the subagents extension), the arbiter HOLDS all
continuation injection. When the last subagent finishes, the
"[subagent finished]" message creates a new turn, and at that turn's
`agent_end` (running==0) the arbiter resumes naturally. No separate resume
kick is needed.

### Recommended contributor pattern

```ts
const intent = {
  name: "my-loop",
  priority: 200,
  decide: () => {
    if (myLoopActive) return { prompt: "[loop] continue..." };
    return undefined;
  },
};

// Immediate attempt.
pi.events.emit("hook-coordinator:register-continuation", intent);

// Fallback for late coordinator.
pi.events.on("hook-coordinator:ready", () => {
  pi.events.emit("hook-coordinator:register-continuation", intent);
});
```

---

## Shared: `hook-coordinator:ready` (listen)

The coordinator emits `hook-coordinator:ready` once ALL registries are set up.
Contributors listen for this signal and re-emit their registrations to handle
the race where a contributor loaded before the coordinator.

---

## Priority conventions

| Range  | Category                  |
|--------|---------------------------|
| 0–99   | system-critical (reserved)|
| 100–199| persona / agent identity  |
| 200–299| loop engines (ultrawork, ralph) |
| 300–399| feature extensions        |
| 400+   | informational / user      |

## Ordering rule

For prompt sections: sorted by ascending `priority`. Ties broken by
registration order (earlier-registered sections appear first).

For continuation intents: checked in ascending `priority` order at each
`agent_end`. The first non-abstaining intent wins. Ties broken by
registration order.

Re-registration overwrites the previous entry for the same `name` (and resets
its tie-break order).
