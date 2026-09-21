# Kaizen Decisions Log

Declined proposals and corrected premises. `kaizen-research` and `kaizen-review-prep`
**must not re-propose** anything here without *materially new context* (a new capability,
a changed upstream constraint, or a new exploit/failure path). Each entry records what
the new context would have to be to re-open it.

---

### [2026-05-18] Declined — Add Reddit `.rss` or Reddit MCP to `kaizen-research`
- **Origin**: review-queue.md (open since 2026-05-10) ▸ research/2026-05-10.md Risks; recommended Decline in reviews/2026-05-15.md ▸ Retirement Candidates.
- **Decision**: Decline.
- **Reasoning**: research/2026-05-15.md confirmed Reddit is blocked at the **domain level** via WebFetch — not just the HTML path. The proposal as scoped (add a Reddit `.rss` source to the research skill) is infeasible with current tooling.
- **Re-open only if**: a Reddit MCP server becomes available, or a `curl`-via-Bash path with a custom User-Agent header is whitelisted. Absent one of those, do not re-surface.

### [2026-05-18] Premise corrected — "Close #266 / #267 as phantom tech debt"
- **Origin**: review-queue.md (open since 2026-05-10) ▸ reviews/2026-05-15.md ▸ Proposal #7 ("close phantom tech debt; features already in our Strands 1.39 pin"). Actioned via PR #338.
- **Decision**: Premise rejected. Issues **#266** (large tool-result offload) and **#267** (context-window lookup fallback) are **not** phantom debt — they are live, well-specified Strands adoption/wiring tasks whose 1.39 precondition is now met. PR #338 posted "unblocked, keep open" comments on both rather than closing them.
- **Reasoning**: The kaizen review assumed the upstream features being present in our pinned Strands version made the issues obsolete. They are not obsolete — they track the *wiring* work to actually adopt those features. Closing them would have silently dropped real, scoped backlog.
- **Re-open only if**: never re-propose *closing* #266/#267 on the "already in our pin" basis. They are valid open work; treat as normal backlog, not kaizen retirement candidates. (Proposing to *implement* them is fine — that is the opposite of this decision.)

### [2026-05-18] Scope note — "Adopt Strands built-in proactive compression, retire our custom `TurnBasedSessionManager` compaction"
- **Origin**: the review-queue Strands-bump entry framed Strands 1.40 proactive compression (PR #2239) as a "library-native subtraction" reducing our custom session-manager compaction surface. Surfaced concretely in PR #340's "Subtraction opportunity (noted, NOT acted on)".
- **Decision**: **Not a drop-in replacement.** Do not propose retiring our custom compaction on a bare "Strands now does this" basis.
- **Reasoning**: Strands' built-in proactive compression operates on `ConversationManager` and only summarizes. Our `TurnBasedSessionManager` compaction additionally does: (1) tool-content truncation, (2) AgentCore-Memory long-term-summary retrieval, (3) DynamoDB-persisted checkpoint state — and drives the PR #243 `compaction` SSE event. The built-in managers do none of (1)–(3).
- **Re-open only if**: a concrete migration design accounts for tool-content truncation, LTM summary retrieval, DynamoDB checkpoint persistence, and the `compaction` SSE-once invariant. A bare "adopt the built-in, delete ours" proposal is out of scope and should not be re-surfaced.

### [2026-09-21] Declined — the POC-comment feedback loop in both kaizen skills
- **Origin**: review-queue.md ▸ [2026-09-04] "Retire the POC-comment feedback mechanism from both kaizen skills"; recommended Ship or Decline in reviews/2026-08-14, 08-28, 09-04, 09-11 (▸ #8) and 09-18 (▸ #4). Five cycles, zero keystrokes.
- **Decision**: **Decline permanently.** The loop is retired from both skills, not merely unused.
- **Reasoning**: the mechanism the skills describe — Phil comments POC findings on the previous week's research PR, review-prep lifts them, and "tested outranks untested" breaks ranking ties — **has never once fired in seven cycles**. #926, #1045 and #1046 each carry 0 comments and 0 reviews. Over the same period 6 of 9 proposals converted through merged PRs, the channel no skill instruction described. The substitute is also demonstrably better: the deepest analysis of the document-offload epic arrived as a `review-queue.md` entry on PR #1147's own unmerged branch, and it **corrected** the 2026-09-18 review's first draft. A feedback channel that has never been used is not underused; it is wrong about where the feedback comes from.
- **What replaced it** (`kaizen-research` and `kaizen-review-prep` SKILL.md, this commit): review-prep opens with a **scorecard of the prior review's proposals** resolved against git and disk, and is now required to read **open PR branches** for `docs/kaizen/` entries before ranking. The `POC findings` proposal field became `Evidence` (measured / verified on disk / asserted), and the tiebreak became measured-over-asserted.
- **Re-open only if**: a kaizen PR actually accumulates review comments across a cycle without the skill asking for them. Absent that, do not re-propose a comment-based channel.

### [2026-09-21] Declined — wire per-tool `duration_ms` into the `tool_result` SSE event
- **Origin**: review-queue.md ▸ [2026-05-15]; recommended DROP in reviews/2026-07-03 and Decline in 08-14, 08-28, 09-04, 09-11, 09-18. Eleventh cycle, five decline recommendations, zero keystrokes.
- **Decision**: **Decline.**
- **Reasoning**: superseded by what shipped. `agent_status` carries Strands' own measured `durationMs` on its `tool_end` phase, which is the timing this item wanted, on a channel that costs nothing against the prompt. The deliberate non-persistence of those durations is a recorded decision in `CLAUDE.md`, so putting a duration on `tool_result` would re-open it by the back door.
- **Re-open only if**: a concrete consumer needs per-tool timing **persisted and replayed** on `GET /messages`, with an answer to why a reloaded conversation showing timings is better than one that does not — the question `agent_status` already settled.

### [2026-09-21] Declined — audit the `oauth_required` SSE flow against the ref-repo's mid-tool-call 401/403 handling
- **Origin**: review-queue.md ▸ [2026-05-10], deferred to 2026-05-24 and surfaced in eight reviews since; reviews/2026-08-14 said it "must not carry a fifth review" and it then carried three more.
- **Decision**: **Decline as scoped.** An open-ended audit against a reference repo is not a kaizen item.
- **Reasoning**: ~17 weeks overdue with no entry point and no failure ever named. Meanwhile the flow was hardened repeatedly by work that started from concrete failures instead — pre-flight `oauth_required` for unregistered tools, vault warm-up before emitting, the `agentcore_424_destroys_consent_409` fix, and the MCP-App-call bypass fix. That is the pattern that works here: a named symptom, not a comparative read.
- **Re-open only if**: a specific `oauth_required` failure is observed — name the entry point and the symptom. That is ordinary bug work and welcome; the standing audit is not.

### [2026-09-21] Settled — dormant-skill flagging for `cors-deployment` and `frontend-design`
- **Origin**: flagged as retirement candidates in six consecutive research runs on days-since-modified alone; reviews/2026-09-04 settled it as **keep** and the verdict was never written down, so it kept resurfacing.
- **Decision**: **Keep both skills. Stop flagging them.**
- **Reasoning**: age is not dormancy for a reference skill. Both encode conventions that are still correct and still load-bearing — which is exactly why neither has needed an edit. The listing was a metric finding a fact about the file system, not about the repo.
- **Re-open only if**: a skill's *content* is contradicted by the code it describes. Do not re-flag either skill on days-since-modified.
