# Cabinet Contributor And Agent Guide

This file is persistent implementation guidance for coding agents and contributors working on Kredlit Cabinet. Read `README.md` and the relevant source before changing behavior. Internal product-planning documents may exist locally, but the public project must remain understandable without them.

## Project Context

Cabinet is a Telegram-first inventory system for small retailers. A Telegram group maps to one tenant and may optionally map to one location. Physical shops, warehouses, websites, and marketplaces all use the same location and stock model. Neon Postgres is the inventory source of truth.

MVP scope includes general inventory, unit conversion, thresholds, confirmations, daily summaries, and Excel export. Marketplace synchronization, manufacturing, F&B, field service, a web dashboard, unlinking groups, and admin-only command gating are out of scope unless explicitly requested.

System-generated copy is English. User intent may be expressed in any language.

## Architecture

- Hono owns `GET /health` and `POST /telegram/webhook`.
- Telegram updates are validated before routing.
- Read tools execute synchronously.
- Every write intent from Telegram goes through `INTENT_QUEUE`.
- `adjust_stock` additionally goes through `PendingActionWorkflow` confirmation.
- Postgres.js executes runtime SQL through Neon/Hyperdrive.
- Drizzle declares schema and generates migrations; it is not the runtime query abstraction.
- Flue generates Durable Object session infrastructure and registers tools, but the current webhook uses `parseIntent()` directly to preserve Queue interception.
- `CABINET_MODEL` selects one of four model/provider combinations without a rebuild.

## Non-Negotiable Invariants

### Inventory Correctness

- Never read stock and then write it in separate unguarded statements.
- Every `stock_levels` decrease must use an atomic guard such as `UPDATE ... WHERE quantity >= requested RETURNING ...`.
- Additions must use an atomic increment/upsert.
- Transfers must debit, credit, and write both ledger legs in one database transaction.
- Never permit negative base-unit stock.
- Store stock in whole base units; reject conversions that are not safe integers.
- Keep `stock_transactions` append-only. Do not add retention or purge behavior.
- Check effective thresholds after every decrease, including transfer sources and downward adjustments.
- Treat Queue delivery as at-least-once. Do not assume ordering or retries provide database correctness.

### Tenant Isolation

- Scope every item, location, stock, history, and export query by `tenantId`.
- Verify IDs belong to the requesting tenant; possession of a UUID is not authorization.
- Never leak another tenant's names, quantities, transactions, or files.
- Any idempotency key must be tenant-aware unless the upstream identifier is globally guaranteed.

### Trust Boundaries

- Hono is the only HTTP router.
- Valibot is the only application validation library; do not add Zod.
- Validate Telegram updates, Queue messages, Workflow input/events, model output, and every tool input/output at their boundaries.
- Do not replace validation with TypeScript casts.
- Verify Telegram callback ownership by pending action, tenant, chat, user, status, and expiry.

### Worker Safety

- Await every promise.
- Do not mutate request-shared global state.
- Close postgres.js clients in `finally`.
- Do not leave response or request streams open.
- Keep Queue and Workflow handlers retry-safe.
- Do not perform live provider calls in automated tests.
- Keep `/health` cheap; if dependency health is needed, add a separately protected diagnostic.

## Security And Secrets

- Never read, print, log, commit, or include actual secret values in patches, command output, tests, fixtures, screenshots, or documentation.
- Secret files include `.dev.vars`, `.env*`, registry credentials, service-account files, private keys, certificates, and generated deployment output.
- Keep `.env.example` empty of real values. Use obvious placeholders only in comments.
- Keep `wrangler.jsonc` free of `account_id` and real Hyperdrive IDs in public commits.
- The Azure provider key belongs only in AI Gateway BYOK. The Worker receives only `CF_AIG_TOKEN`.
- Use `wrangler secret put` or `secret bulk` for production secrets.
- Build public archives from Git-tracked files, never from the whole workspace.
- Before publication, inspect staged files and Git history for tokens, connection strings, account IDs, and generated `.dev.vars` copies.
- If a secret enters Git history or a shared artifact, remove it and rotate it; deleting the current file is insufficient.

## Model Configuration

Supported `CABINET_MODEL` values:

- `worker-kimi`
- `worker-deepseek`
- `azure-kimi`
- `azure-deepseek`

Do not add separate provider/model switches. One selector is intentional.

Azure selections require `AZURE_GATEWAY_BASE_URL` and `CF_AIG_TOKEN`. The base URL is stable across the two Azure deployments; model selection appends the deployment path. Do not put the Azure provider key in Worker configuration.

Adding another model should be one mapping entry when its protocol is already supported. Add another provider branch only when the wire protocol truly differs.

## Database And Migrations

- Edit `src/db/schema.ts` first.
- Generate migrations with `pnpm db:generate`.
- Review generated SQL before applying it.
- Preserve partial indexes for active pending actions and external-order idempotency.
- Use parameterized postgres.js tagged templates; never concatenate SQL input.
- Run migrations from a trusted machine or CI against the direct Neon URL, not from the Worker.
- Never run destructive tests against production or a shared branch.

## Telegram And Routing

- Preserve routing precedence for callback queries, commands, pending replies, and new intents.
- Group commands may arrive as `/command@BotUsername`; normalize command mentions.
- Telegram group privacy must be disabled for ordinary text messages.
- Always answer callback queries to clear Telegram's loading state.
- Keep callback data under Telegram's 64-byte limit.
- Read tools bypass the Queue; write tools do not.
- Only `adjust_stock` requires confirmation unless the product decision changes explicitly.
- Explicit cancel and silent timeout must have different user-facing copy.

## Queue And Workflow Rules

- Validate the Queue envelope before dispatching a tool.
- Acknowledge only after durable work is complete.
- Log failures with the Queue message ID, never with credentials or full sensitive payloads.
- Keep at most one pending action per chat/user; rely on the partial unique index, not a race-prone precheck.
- Validate parked intents again before Workflow execution.
- Workflow steps must be deterministic and individually named.
- Keep Telegram notification failures from causing duplicate committed inventory mutations.
- Keep Queue intent receipts and inventory mutations in the same database transaction.

## Coding Conventions

- Use TypeScript ESM and explicit `.ts` imports.
- Keep strict typing; do not use `any` to bypass a boundary.
- Prefer small functions and existing helpers over new abstractions.
- Use single quotes and semicolons.
- Use camelCase in TypeScript and snake_case for SQL identifiers and tool names.
- Put tool schemas and inferred types in `src/types/tools.ts`.
- Keep tool execution centralized unless splitting materially improves reuse or safety.
- Format Telegram results through `src/telegram/messages.ts`; never expose internal IDs or raw tool JSON to users.
- Add comments only for non-obvious constraints, not line-by-line narration.
- Do not add dependencies when the standard library or installed packages suffice.
- Do not add speculative compatibility layers or extension points.

## Testing

Standard checks:

```sh
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Important: `pnpm test` and `pnpm test:e2e` truncate Cabinet tables through `TRUNCATE tenants CASCADE`. They require a separate disposable `TEST_DATABASE_URL` and `CABINET_ALLOW_DB_RESET=1`. Never alias the test URL to `DATABASE_URL` or run either command against production/shared data.

Test requirements:

- Mock model calls; tests must pass without live Cloudflare or model-provider access.
- Keep one focused regression test for each non-trivial branch or bug.
- Test stock concurrency against real Postgres.
- Test transaction rollback, tenant isolation, idempotency, and output validation.
- Do not replace database correctness tests with mocked repositories.
- Avoid broad snapshot tests for user-facing behavior; assert meaningful fields and copy.

### Testing By Change Type

Bug fixes:

1. Add a focused failing regression test first.
2. Fix the root cause at the shared path after checking all callers.
3. Run the focused test, affected suite, typecheck, and build.
4. Run database-backed suites when inventory, tenancy, Queue, Workflow, or routing behavior can be affected.

Feature additions:

1. Test validation and pure logic at unit level.
2. Test writes, constraints, concurrency, rollback, idempotency, and tenant isolation against real disposable Postgres.
3. Test user routing and outbound payloads at webhook/service level with external calls mocked.
4. Generate and inspect migrations for schema changes.
5. Run all standard checks before merge.

Deployment changes:

1. Run all automated checks against a disposable database before deployment.
2. Review migration order, generated bindings, staged files, and ignored secret artifacts.
3. After deployment, verify health, Telegram, Hyperdrive, Queue, Workflow, the selected model, and document delivery as applicable.
4. Observe real timeout/cron behavior when those paths changed; deployment success alone is not evidence.
5. Record commands and results in the pull request or release record.

## Change Checklist

Before editing:

1. Trace the request from Telegram or scheduled handler to its database writes and outbound response.
2. Search all callers of the function being changed.
3. Check whether an existing helper, platform primitive, or database constraint solves the problem.

Before finishing:

1. Run the narrowest relevant test first.
2. Run typecheck and build.
3. Run database-backed suites only against a disposable database.
4. Inspect generated migrations.
5. Check `git diff --check` and `git status --short --ignored`.
6. Confirm no secret-bearing file is staged.
7. Document new variables, commands, operational behavior, and known limitations.

## Do Not Build Without Explicit Scope

- Marketplace API synchronization
- Manufacturing, recipe, BOM, batch, expiry, or field-service modules
- Web dashboard
- Group unlink command
- Admin-only `/link`
- Per-tenant localization
- Ledger deletion or retention jobs
- Custom cache, ORM repository layer, event bus, or provider abstraction beyond a concrete need

## Known Gaps

Do not describe these as completed until fixed and tested:

- Workflow tests do not execute the real Cloudflare runtime.
- Daily summaries are narrower than intended product behavior.

## Source Of Truth

Use this priority when documents disagree:

1. Security and data-integrity invariants in this file
2. Current tested code and database migrations
3. README operational guidance
4. The issue or decision record that explicitly scopes the change

When implementation and product intent differ, do not silently choose one. Preserve safety, make the mismatch explicit, and update tests and documentation with the agreed resolution.
