# Platform cost visibility

Brings the AWS infrastructure bill into the admin cost dashboard, alongside the
per-user inference ledger it already had.

## Why

The dashboard measured Bedrock token spend, and measured it well. Against
prod's September 1–21 bill our ledger came within **0.50%** of Cost Explorer's
model SKUs ($1,076.03 vs $1,081.44). What it could not see was anything that
is not a token:

| Prod, Sept 1–21 2026 | Amount | Share |
|---|---|---|
| Inference (Bedrock model SKUs) | $1,081.44 | 61.2% |
| **Infrastructure** | **$685.96** | **38.8%** |
| **Total** | **$1,767.41** | |

`Amazon Bedrock AgentCore` alone was **$201.54/month** — the second-largest
line item in the account, on no screen anywhere. (It is also the line that
would have surfaced the idle-reaper regression, #827.)

With 1,807 active users that month:

| Basis | Per user / month |
|---|---|
| Inference only (what the card used to show) | $0.60 |
| All-in | $0.98 |

The old "Avg Cost/User" understated true unit cost by **1.64×**.

Dev is the mirror image: August was **$736.32** of which only **$13.56** was
inference. Dev is ~98% fixed infrastructure, a standing cost unrelated to
usage.

## How it works

```
EventBridge (daily 07:10 UTC)
  └─> platform-cost-sync Lambda      infrastructure/lambda-assets/platform-cost-sync/
        ├─ 1 Cost Explorer call per period (current month + previous)
        └─ writes system-cost-rollup:  PLATFORM#MONTHLY          / SK=<YYYY-MM>
                                       PLATFORM#SERVICE#<YYYY-MM> / SK=<service>
                                                │
  GET /admin/costs/platform  ────────────────────┘  (app-api, reads DynamoDB only)
        └─> "Platform" tab + the all-in Total Cost / Avg Cost/User cards
```

**Scheduled, never live.** Cost Explorer bills **$0.01 per request**. A screen
that queried it on load would cost ~$10/month per thousand page loads to
display costs. `ce:GetCostAndUsage` is granted to the Lambda role and
deliberately **not** to app-api's, so no request path can spend billing
dollars however often it is called. Steady-state cost is ~$0.02/day.

**No new infra.** Platform rows use their own `PLATFORM#*` PK namespace in the
existing `system-cost-rollup` table — no new table, no new GSI, no migration.

**Two sources, never added twice.** `inferenceCost` comes from our ledger
(per-user and per-session, where Cost Explorer is per-account only);
`platformCost` comes from Cost Explorer. CE's own inference figure rides along
as `ceInferenceCost` **only** to reconcile the two — adding it to a total
would count every token twice. The Platform tab surfaces that comparison as a
**pricing regression test**: a widening delta means the rates in
`curated-models.ts` have drifted from what AWS actually charged, which
CLAUDE.md names as a live risk.

## Enabling it

Opt-in, against this repo's usual default-on-with-a-kill-switch posture —
this one reads the account's billing data, needs an IAM action an SCP may
deny, against a Cost Explorer that may not be enabled, and costs money per
call. Only the literal `true` enables; an unset workflow variable (which
arrives as an empty string) leaves it off.

```bash
CDK_PLATFORM_COSTS_ENABLED=true   # platform.yml (CDK) deploy
```

While off, the construct produces zero resources and the dashboard reports
inference cost only — the Platform tab explains that rather than rendering a
`$0.00` that would read as "the infrastructure is free".

To backfill history after enabling, invoke the function directly:

```bash
aws lambda invoke --function-name <prefix>-platform-cost-sync \
  --payload '{"periods":["2026-08","2026-07","2026-06"]}' /dev/stdout
```

## Attribution: a service allowlist, and why not tags

`applyStandardTags` already puts `Project` / `Environment` / `Version` on every
resource the stack creates, which *should* make this exact. It does not, yet:

- **No cost allocation tag is activated** in either account. Grouping by
  `Project` returns a single `Project$` bucket holding the entire bill.
- Activation is an **org-management-account** action. A Control Tower linked
  account (dev-ai) gets `AccessDeniedException` merely listing them.
- Activation is **not retroactive**, so every day of delay is a day of
  attribution that cannot be reconstructed later.

Meanwhile the accounts are shared — `bsu-prod-backend` / `bsu-dev-backend` run
an Aurora Serverless cluster we do not provision and must not bill to our
users. So attribution is by service, in three buckets:

| Bucket | Contents |
|---|---|
| `inference` | `… (Amazon Bedrock Edition)` model SKUs. Reconciliation only. |
| `excluded` | Another team's resources (RDS), plus account-level charges no single application causes: Support (a % of spend), the Control Tower baseline (Config, CloudTrail, Security Hub, GuardDuty), and Cost Explorer itself. |
| `platform` | Everything else. The number the dashboard adds. |

`excluded` rows are **persisted and displayed**, not silently dropped: an
operator can only trust a total if they can see what was held out of it.

> ⚠️ **Known limitation — account scope.** Infrastructure is measured per AWS
> account. dev-ai hosts **five** deployments (`beta-boisestateai-dev`,
> `boisestateai-v2-dev`, `bsu-agentcore`, `dev-boisestateai-v2`,
> `nightly-mv`), so dev's platform figure and its reconciliation cover all of
> them. Prod is a dedicated account with one deployment, so its figures are
> sound apart from the excluded Aurora. The UI states this on the panel.
> Activating the `Project` tag is what fixes it; the row shape does not change
> when it does — only the query swaps to `GROUP BY TAG Project`.

## Gotchas worth keeping

- **`PLATFORM_COST_EXCLUDED_SERVICES` overrides, and an empty value is
  ignored.** The default list lives in the handler; the env var is not set by
  CDK at all. An unset variable silently emptying a load-bearing list is how
  the browser URL blocklist broke, and here it would bill another team's
  database to our users with nothing but a slightly high total to show for it.
- **A month keeps settling after it ends**, so the sync always re-reads the
  previous month too. Syncing only the current month would freeze every
  December at whatever it looked like on the 1st.
- **CE rejects a future end date.** An in-progress month ends "tomorrow" and
  is flagged `partialMonth`, which the UI renders as a *Month to date* badge.
- **Costs persist as `Decimal`.** DynamoDB rejects floats, and that failure
  only shows up in cloud.
