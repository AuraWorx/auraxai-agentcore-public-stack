# Agent state feedback

**Status:** PR-1 SHIPPED (#1159, 2026-09-19). PR-2 in review. PR-3 designed, not started.
**Not yet validated against a live backend** — every claim below about wall-clock
timing is pinned by tests against fake streams, not by a turn on dev.
**Follow-up to:** `d2ee13e2` (emit agent_status and tool-batch summaries), `9bc9bc6b` / `5f0cd52a` / `67234329` (loading-indicator series)
**Related:** `docs/specs/mid-turn-steering.md` (the other consumer of the drain), CLAUDE.md § SSE Event Types → `agent_status`

## Problem

The live indicator shipped in `9bc9bc6b` replaced twenty invented phrases with
facts, and that was the right trade. But it settled at two states — `Thinking…`
and `Running <tool>…` — and a turn has more shape than that. Time the user
currently cannot account for:

* **Agent build.** Tool-registry assembly, MCP `tools/list` pre-flight round
  trips, session restore from AgentCore Memory, Runtime cold start. On an
  agent-cache miss this is the longest unexplained pause in the product.
* **Head-of-turn context work.** `apply_pending_compaction` and
  `apply_document_offload` both run before the first model call
  (`stream_coordinator.py:283`). The `compaction` SSE that describes them fires
  *after* `metadata`, purely retrospectively.
* **Model generation vs. tool execution.** Both read `Thinking…` today unless
  the content stream happens to carry an unresolved `toolUse` block.
* **Reasoning.** A reasoning block's header is the static string `Thinking`
  with no duration, live or afterwards.
* **Queued behind the single-flight lease.** Indistinguishable from a hang.

## What already exists — and is thrown away

Two findings shape everything below.

**1. `thinking` and `tool_start` cross the wire and are dropped on the floor.**
`ToolInsightService.recordStatus` writes every `agent_status` transition into a
`statusBySession` signal. Nothing reads it — `statusFor()` has zero callers in
the SPA. Only `tool_end` is consumed, for the per-tool durations on the rail.
The loader's label is derived from the *content* stream instead
(`message-list.component.ts:331`).

**2. That is not a style choice. It is a latency bug.**
`_drain_agent_status_events` runs between yields of the agent stream
(`stream_coordinator.py:1051`). During tool execution Strands yields nothing, so
a `tool_start` sits queued for exactly the silence it exists to explain, and
arrives bundled with its own `tool_end`. The measurement recorded in
`message-list.component.ts:313` — a three-tool browse turn — read `Thinking` for
all 4.5s and never showed a tool name.

**Every phase added through `AgentStatusHook` inherits this.** Decoupling the
drain is therefore a precondition for PR-3, not a cleanup task.

## Non-goals

* **A `responding` phase.** The SPA knows text is streaming from the deltas
  first-hand. A backend-derived duplicate would only disagree at the edges.
  (Already settled in `agent_status.py`; restated here so it is not re-litigated.)
* **"Almost done thinking…".** Claude can say this because it knows the
  thinking budget and how much is spent. Deriving it from elapsed time is an
  inference wearing a fact's clothes. The existing stall ladder — `Still
  working…` → `…longer than usual` — gives the same reassurance and claims only
  what it knows.
* **Per-tool invented phrasing** ("Searching the catalog…", "Browsing…").
  A tool's own name is the most accurate label available and invents nothing.
* **Persisting durations.** Unchanged from the `agent_status` contract: a
  reloaded conversation shows summaries without timings rather than a number
  the user cannot trust.

## Cost

Nothing in this spec reaches the model. No phase, label, or duration is appended
to the conversation, so the cacheable prefix is untouched — the same standing
this feature has had since `d2ee13e2`. PR-2 adds SSE frames but no model tokens.

## PR-1 — "Thought for 17s" (SHIPPED, #1159)

**Scope:** SPA only. No backend change, no dependency on the drain fix.

The reasoning block header (`reasoning-content.component.ts:48`) says `Thinking`
forever, including on a block that finished nine minutes ago. It becomes
`Thought for 17s` the moment the model stops reasoning.

**Measurement.** Client-observed, first-hand: the span from the first reasoning
delta to the moment the model demonstrably switched to output. This differs from
the tool durations on the rail, which are measured inside Strands' event loop
and shipped over `agent_status`. It is stated as such in the code, because the
two are not the same kind of number and should not be presented as though they
were.

**Why a client-side span is sound here.** The agent loop starts a new Bedrock
message at every tool round trip (`assistant-message.component.ts:310`), and
`handleReasoning` merges into the first reasoning block of the *current*
message. A reasoning block therefore never spans a tool call, so first-delta to
last-output-switch cannot silently absorb tool time. The undercount is the
reasoning's own time-to-first-token plus the trailing gap before output — both
sub-second, both absorbed by whole-second rounding.

**End of reasoning** is stamped at the first of:
1. a non-reasoning `content_block_start` in the same message,
2. a non-reasoning `content_block_delta` in the same message,
3. `message_stop`.

(1) and (2) are the accurate moments; (3) is the backstop for a cycle that
produced reasoning and nothing else.

**Live-only, by construction.** The duration rides `ContentBlock`, which only
the stream parser populates. `GET /messages` never sets it, so a reloaded
conversation falls back to `Thinking` with no extra code and no persisted
number — the same posture as the tool rail's `totalDurationMs`.

**Placement on the model.** `reasoningDurationMs` sits at the top level of the
SPA's `ContentBlock`, deliberately *not* inside `reasoningContent`. That nested
object is Bedrock's Converse shape; a display string there would be the mistake
CLAUDE.md calls out for `tool_group_summary`.

**Formatting.** `<1s`, `3s`, `17s`, `1m 12s`. Never rounds a sub-second block up
to `1s`.

## PR-2 — decouple the drain, then trust `agent_status` (in review)

**Backend.** `AgentStatusHook` pushes to an `asyncio.Queue` instead of a list,
and the coordinator merges that queue with the agent stream rather than polling
it between yields. The queue caps (`_MAX_QUEUED_STATUSES`) and the
per-turn reset at `BeforeInvocationEvent` carry over unchanged; the reset is
what keeps an interrupted turn's transitions out of the next one.

**SPA.** Wire the loader's label to the now-live `statusFor()`:

| Phase | Label |
|-------|-------|
| `thinking` | `Waiting for the model…` |
| `tool_start` | `Running <tool>…` |
| batch of >1 | `Running <tool> and 2 more…` |

**Also fixes parallel batches.** `loaderStatusTool` returns the *first*
unresolved `toolUse` on the streaming message, so three tools in flight names
one of them arbitrarily. With a trustworthy `tool_start`/`tool_end` pair the
count is known.

**Keep the content-stream derivation as the fallback.** It is strictly more
current when it fires, and it is the only source that works if a future SDK
change starves the queue.

**Found while building it.** The loader stays mounted for the WHOLE turn —
`isChatLoading` clears at stream close, not at the first token — so a label
keyed on the `thinking` phase would contradict text the user can already read.
"Waiting for the model" is therefore gated on the answer still being silent,
falling back to the previous wording once text arrives. The existing
`loaderStatus` docstring asserts the loader "is gone anyway" at that point;
that comment is wrong about the code and was deliberately left alone rather
than widen this PR. Worth revisiting on its own: the right fix is probably that
the loader should stop being mounted under a streaming answer at all, which is
a change to when it renders, not to what it says.

## PR-3 — the phases ahead of the event loop

These are not Strands hook events; they happen before the loop exists, so they
need emit points in the invocation path.

| Phase | Label | Emit point |
|-------|-------|------------|
| Agent build | `Getting ready…` | inference-api chat route, around `_create_agent` |
| MCP pre-flight | `Connecting tools…` | around the pre-flight `tools/list` |
| Head-of-turn context work | `Reorganizing context…` | `stream_coordinator.py:283–300` |
| Queued behind the lease | `Finishing your previous message…` | single-flight acquire |

`Connecting tools…` is worth its own label rather than folding into `Getting
ready…`: it is the phase that fails (401, timeout) and a user who saw it named
has a chance of connecting the notice that follows to the pause that preceded it.

**Open question for PR-3.** These precede `message_start`, and the SPA's loader
currently starts on the request's falling edge. Whether they arrive as
`agent_status` frames with new phase values or as a distinct pre-turn event is
not yet decided; `agent_status` is preferred if the drain refactor in PR-2 makes
a pre-loop emitter practical.

## Turn recap (deferred)

`Thought for 17s · 4 tools · 2.1s` as a turn-level footer. The rail already
computes `totalDurationMs`; only the turn-level line is missing. Deferred
because it is the one item here that would be materially better persisted, and
that is a separate argument from the rest of this spec.
