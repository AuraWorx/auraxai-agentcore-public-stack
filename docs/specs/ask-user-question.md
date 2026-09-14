# Structured clarifying questions (`ask_user_question`)

Status: **PR-1 (backend), PR-2 (picker) and PR-3 (rehydration) landed. PR-4 open.**

The agent pauses mid-turn to ask the user one to four multiple-choice
questions, the SPA renders a picker, and the turn continues in place with the
user's answer as the tool's result.

## Why this shape

The mechanism already existed. Per-tool approval (`MCPExternalApprovalHook`) is
this same thing with one question and two fixed options: a Strands interrupt
pauses the turn, an SSE event drives an inline prompt, and the user's decision
POSTs back as an `interrupt_responses` entry. Generalizing the payload was
cheaper than inventing a second pause mechanism, and it inherits the paused-turn
snapshot, the resume guard and the reload breadcrumbs for free.

Two alternatives were considered and rejected:

- **An MCP App (`ui_resource`).** App frames render *alongside* a running turn;
  they do not pause it. Building the handshake inside an iframe would reinvent
  the interrupt protocol and inherit the sandbox-origin dependency — an empty
  `sandboxOrigin` means the SPA cannot frame the App at all.
- **A client-side heuristic** that detects ambiguity and prompts without the
  model asking. The model is the only party that knows what it is blocked on.

## The one real risk, and how it was closed

Every interrupt shipped before this one is raised from a `BeforeToolCallEvent`
hook. `ask_user_question` raises its own from `ToolContext` (which implements
`_Interruptible`, `strands/types/tools.py`), because here the pause *is* the
tool. The resume path — `PausedTurnSnapshot` → rebuilt agent → restored
`_interrupt_state` → `pending_tool_execution` replayed — was built and proven
against the hook flavor only.

`tests/agents/main_agent/session/test_user_question_interrupt_integration.py`
drives the real Strands event loop (real `Agent`, real `@tool`, scripted model
only) and proves the tool-scoped flavor behaves identically: the turn pauses,
`pending_tool_execution` is captured, the interrupt id is
`v1:tool_call:{toolUseId}:{uuid5(name)}`, resuming feeds the response back into
the *same* tool call, and the tool is not re-invoked.

## Contract

**Tool input** (hand-written `inputSchema`; Strands' generated schema drops
`$defs`, which would leave nested models as dangling `$ref`s):

```jsonc
{ "questions": [ {
    "header": "Scope",             // <= 12 chars, the chip label AND the answer key
    "question": "How much should this cover?",
    "multiSelect": false,
    "options": [ { "label": "Just the API", "description": "Routes only" } ]
} ] }
```

1–4 questions, 2–4 options each. The model must **not** supply "Other" or
"Skip" options — the picker always offers both.

**SSE**: `user_question_required`, payload `{type, interruptId, toolUseId,
questions}`. See the event table in `CLAUDE.md`.

**Reload**: the event fires once and never re-streams, so a refresh mid-prompt
would otherwise orphan the turn — picker gone, agent still paused. `GET
/messages` replays the `PendingInterrupt` breadcrumb (`kind: "user_question"`,
questions JSON-encoded) and `hydratePendingInterrupts` re-renders the picker.
Both paths validate questions through the same `validateUserQuestions`, so the
live and replayed prompts cannot drift.

**Abandonment**: a breadcrumb that outlives its `pausedTurn` snapshot renders a
prompt the user can no longer answer — the resume route 400s on an interrupt id
the rebuilt agent never saw, so Submit is a guaranteed error. Nothing used to
clear them: the two `remove_pending_interrupts` call sites are resume cleanup
and the explicit dismiss endpoint, neither of which a user reaches by simply
typing something else. `clear_pending_interrupts` is now called beside
`clear_paused_turn` at the head of every non-resume turn. It is deliberately a
separate function rather than folded into `clear_paused_turn`, which clears only
the snapshot on purpose (`test_paused_turn_independent_of_pending_interrupts`)
and is also called on the resume-success and expired-snapshot paths where the
narrower cleanup is already right.

**Resume**: `POST /invocations` with

```jsonc
{ "session_id": "...", "message": "",
  "interrupt_responses": [ { "interruptId": "v1:tool_call:...",
    "response": { "answers": { "Scope": { "selected": ["Everything"], "text": null } } } } ] }
```

`response` must **never be null**. `ToolContext.interrupt` only treats a
non-None response as an answer, so a null re-raises the interrupt forever.
"Skip" sends `{"skipped": true}`.

`parse_answers` also accepts a positional list, a bare string, and label-only
lists. That tolerance is deliberate: this payload is the user's only route out
of a paused turn, so a shape mismatch must never be able to strand them. The
inverse asymmetry applies to `normalize_questions`, which is strict — a prompt
the SPA cannot draw would pause the turn with nothing on screen, so it is
rejected at the tool boundary while the model still has a turn left to fix it.

## Cost

- The tool spec is a **constant** in `toolConfig` — registered once at startup,
  never injected per-turn, so it sits in the stable cacheable prefix. **Do not
  make its presence conditional on conversation state**; a flag that flipped
  mid-session would re-write a 30k–150k-token prefix at the cache-write premium.
- It is a **static registry tool, not an `extra_tools` injection** — it captures
  no session/user identity, so it does not touch the injected-tool agent-cache
  bypass (`agent-cache-extra-tools-bypass.md` §6).
- Questions ride the SSE channel, not the prompt. Only the compact formatted
  answer block re-enters the conversation, which is why `format_answers` writes
  one line per question instead of echoing the option catalog back.

## Flag

`ASK_USER_QUESTION_ENABLED`, default on with a kill switch (house style). While
off the tool is never registered, so the model cannot pause a turn behind a
prompt no client is listening for; it falls back to asking in prose. The tool
re-checks the flag at call time so a registry built before a flip cannot pause.

The catalog seed ships `enabledByDefault: False` until PR-2 lands the renderer —
a paused turn with no picker is a worse failure than a guessed assumption.

## Remaining work

| PR | Scope |
|----|-------|
| ~~1~~ | ~~Tool, interrupt, SSE event, `PendingInterrupt` kind, integration proof~~ |
| ~~2~~ | ~~`UserQuestionService`, stream-parser wiring, the picker (pager + multi-select + Other + Skip), object-carrying resume~~ |
| ~~3~~ | ~~Reload rehydration, and clearing breadcrumbs for abandoned prompts~~ |
| 4 | Flip `enabledByDefault`, **trigger-rate work**, RBAC grants. |

### PR-4 is not polish

Measured against real Bedrock: the model reaches for the tool **4/4** when it is
the only tool under the real default system prompt, **1–2/4** once `browse_web`
and `calculator` sit beside it, and **0/4** through the full app (which also
injects the artifact/Office/workspace tools). Temperature is not the variable —
0.0, 0.7 and 1.0 behave identically. Richly-described "do the work" tools
crowd it out.

So the feature is correct end to end but rarely fires on its own. Getting it
called reliably is the remaining work, and a tool description alone may not be
enough — a clause in the system prompt is the other lever.

Open decisions for PR-2/3:

- **Typing instead of answering** should resume with the typed text as a
  free-text answer, not start a new turn. A new turn hits
  `reset_stale_interrupt_state`, discards the paused tool call and re-sends the
  whole prompt — more expensive, and it routes through the abandoned-pause path.
- **Steering interplay.** A follow-up queued during the pause and an answer can
  land together; the `carried steering` path on the resume request already
  exists, so this is a UX decision about ordering, not new plumbing.
