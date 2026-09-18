# Kredlit Cabinet

Kredlit Cabinet is a Telegram-first inventory agent for small retailers. Staff manage items, stock, locations, transfers, adjustments, alerts, and Excel reports from a Telegram group instead of a separate dashboard.

The application runs on Cloudflare Workers and stores its inventory ledger in Neon Postgres. Natural-language intent parsing can use either native Workers AI or Azure models through Cloudflare AI Gateway BYOK.

The product and package name are **Kredlit Cabinet** / `cabinet`. Existing Cloudflare deployment resources retain the legacy `postal` slug for compatibility: Worker, Queue, Workflow, Hyperdrive, deployed URL, and generated `dist/postal` path.

> Project status: functional MVP. The core inventory path is deployed and smoke-tested, but the items in [Remaining Work](#remaining-work) should be resolved before treating it as a mature production system.

## Features

- Telegram webhook with secret verification and per-chat rate limiting
- Tenant onboarding with `/start`
- Location-linked groups with `/link <location>`
- Physical, own-website, and marketplace inventory locations
- Item-specific units such as `pcs`, `dus`, and `karton`
- Atomic stock additions and guarded removals
- Transactional location-to-location transfers
- External-order deduplication for online and marketplace sales
- Reorder thresholds and low-stock detection
- Confirmation Workflow for destructive stock adjustments
- Location-disambiguation Workflow with inline Telegram buttons
- Tenant-validated linked, explicit, remembered, and sequential transfer location resolution
- Daily scheduled summaries
- In-memory Excel export sent directly to Telegram
- Workers AI and Azure AI Gateway BYOK model selection

## Architecture

```text
Telegram
   |
   v
Hono webhook
   |-- commands and pending-action replies
   |-- Valibot validation and rate limiting
   |-- LLM intent parsing
   |
   |-- read intent ----------------------> Neon through Hyperdrive
   |
   `-- write intent --> Cloudflare Queue --> atomic SQL / transaction
                              |
                              `-- adjust_stock --> Cloudflare Workflow
                                                    |
                                                    `-- confirm/cancel/timeout

Cloudflare Cron --> daily summary --> Telegram
Flue --> generated Durable Object for agent session infrastructure
```

Neon is the source of truth. Marketplace and website stock are allocation pools represented by ordinary locations; Cabinet does not call marketplace APIs.

## Technology

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (`workerd`) |
| Language | TypeScript, strict mode |
| HTTP | Hono |
| Agent tooling | Flue 2 |
| Validation | Valibot |
| Database | Neon Postgres through Hyperdrive and postgres.js |
| Schema and migrations | Drizzle ORM and drizzle-kit |
| Async writes | Cloudflare Queues |
| Durable confirmation | Cloudflare Workflows |
| Session infrastructure | Flue-generated Durable Object |
| Models | Workers AI or Azure through AI Gateway BYOK |
| Reports | SheetJS (`xlsx`) |
| Tests | Vitest |
| Package manager | pnpm |

## Repository Layout

```text
src/
  agents/       Flue agent registration
  db/           Postgres client, Drizzle schema, migrations
  http/         Hono router and Telegram commands
  lib/          Small domain helpers
  llm/          Model selection and intent parsing
  queue/        Write-intent consumer
  scheduled/    Daily summary handler
  telegram/     Telegram schemas and API client
  tools/        Eleven inventory tool implementations and registry
  types/        Valibot contracts and inferred TypeScript types
  workflows/    Pending-action Workflow
test/
  unit/         Pure helpers and provider configuration
  integration/  Real-Postgres concurrency and isolation checks
  workflow/     Pending-action decision checks
  e2e/          Story-level and webhook tests
```

Security invariants in `AGENTS.md` and current tested code are authoritative. Product planning and architecture context are maintained privately and are not required to build or operate the public project.

## Requirements

- Node.js 24 or newer
- pnpm 11 or newer
- A disposable Neon branch for development and tests
- A Cloudflare account for deployment
- A Telegram bot for live operation
- Azure AI Gateway BYOK only when using an `azure-*` model

## Development Setup

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Create local configuration:

   ```sh
   cp .env.example .dev.vars
   ```

3. Set `DATABASE_URL` to the direct, non-pooled connection string used for local development and migrations.

4. Set `TEST_DATABASE_URL` to a different disposable Neon branch and acknowledge destructive resets:

   ```dotenv
   TEST_DATABASE_URL=postgresql://...
   CABINET_ALLOW_DB_RESET=1
   ```

5. Apply migrations to both development and test targets as needed. `pnpm db:migrate` reads `DATABASE_URL`:

   ```sh
   pnpm db:migrate
   ```

6. Run checks:

   ```sh
   pnpm typecheck
   pnpm test
   pnpm test:e2e
   pnpm build
   ```

7. Start local Cloudflare development:

   ```sh
   pnpm dev
   ```

### Test Safety

`pnpm test` and `pnpm test:e2e` run database-backed suites that execute `TRUNCATE tenants CASCADE`. They fail closed unless `TEST_DATABASE_URL` is set to a different database target and `CABINET_ALLOW_DB_RESET=1` is present. Never point either database variable at production or a shared development database.

Tests mock or inject model parsing and do not require live Workers AI, Azure, Telegram, Queue, or Workflow access.

## Configuration

Start from `.env.example`. Never commit `.dev.vars`, `.env*`, provider keys, bot tokens, database URLs, private keys, or generated deployment output.

| Variable | Required | Secret | Purpose |
|---|---|---|---|
| `DATABASE_URL` | Development/migrations | Yes | Direct Neon connection string |
| `TEST_DATABASE_URL` | Integration/E2E tests | Yes | Separate disposable Postgres/Neon target |
| `CABINET_ALLOW_DB_RESET` | Integration/E2E tests | No | Must equal `1` to permit destructive reset |
| `TELEGRAM_BOT_TOKEN` | Live runtime | Yes | Telegram Bot API access |
| `TELEGRAM_WEBHOOK_SECRET` | Live runtime | Yes | Verifies inbound Telegram requests |
| `CABINET_MODEL` | Optional | No | Selects the model; defaults to `worker-kimi` |
| `AZURE_GATEWAY_BASE_URL` | Azure models | Account-specific configuration | AI Gateway path ending at the Azure resource |
| `CF_AIG_TOKEN` | Azure models | Yes | Authenticated AI Gateway token with Run permission |
| `CLOUDFLARE_ACCOUNT_ID` | CI | No | Selects the Cloudflare account |
| `CLOUDFLARE_API_TOKEN` | CI | Yes | Wrangler deployment authentication |
| `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` | Optional | Yes | Local Hyperdrive connection override |

### Model Selection

One variable selects both provider and model:

| `CABINET_MODEL` | Provider | Runtime model/deployment |
|---|---|---|
| `worker-kimi` | Workers AI | `@cf/moonshotai/kimi-k2.6` |
| `worker-deepseek` | Workers AI | `@cf/deepseek-ai/deepseek-v4-pro-0813` |
| `azure-kimi` | Azure BYOK | `Kimi-K2.6` |
| `azure-deepseek` | Azure BYOK | `DeepSeek-V4-Pro` |

Azure also requires a stable base URL:

```dotenv
AZURE_GATEWAY_BASE_URL=https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-id>/azure-openai/<azure-resource>
```

Cabinet appends the selected deployment and `/chat/completions?api-version=2024-10-21`. A complete DeepSeek or Kimi endpoint is also accepted for compatibility and is normalized to the selected model at runtime.

The Azure provider key stays in the AI Gateway BYOK vault. Never add it to Worker configuration.

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Start the Vite/Cloudflare development server |
| `pnpm build` | Build the Worker and remove copied local secrets from output |
| `pnpm typecheck` | Run strict TypeScript checks |
| `pnpm db:generate` | Generate a migration from `src/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL` |
| `pnpm db:studio` | Open Drizzle Studio |
| `pnpm test:unit` | Run non-database unit and lightweight workflow tests |
| `pnpm test` | Run unit, integration, and lightweight workflow tests |
| `pnpm test:e2e` | Run database-backed story and webhook tests |
| `pnpm test:runtime` | Run tests inside Cloudflare workerd |
| `pnpm audit:wiring <url>` | Run non-mutating live Worker/Telegram/Cloudflare/model checks |
| `pnpm telegram:set-webhook <url>` | Register `<url>/telegram/webhook` with Telegram |

## Testing Guide

Use the narrowest test that proves the behavior first, then expand verification according to the kind of change. Automated tests must not call live model providers, Telegram, or production Cloudflare resources.

### Test Levels

| Level | Use for | Examples |
|---|---|---|
| Unit | Pure logic, parsing, formatting, validation, provider selection | Units, thresholds, callback data, confirmation classification, Telegram templates |
| Integration | SQL behavior and invariants against real disposable Postgres | Concurrency, rollback, tenant isolation, idempotency, stock mutation |
| Service/E2E | Request routing and complete domain stories with mocked external calls | Telegram updates, commands, Queue interception, US-00 through US-12 |
| Build | Worker bundling, generated bindings, TypeScript compatibility | Flue/Vite Worker build |
| Live smoke | Deployed binding and provider wiring | Telegram, Hyperdrive, Queue, Workflow, selected model, Excel upload |

### Bug Fixes

1. Reproduce the bug with one focused regression test that fails before the fix.
2. Trace all callers and fix the shared root cause rather than one reported path.
3. Run the focused test while iterating:

   ```sh
   pnpm exec vitest run test/unit/messages.test.ts
   pnpm exec vitest run test/integration/tools.test.ts -t "never oversells"
   ```

4. Run `pnpm typecheck` and the affected suite.
5. Run `pnpm build` for changes touching Worker code, bindings, Flue, providers, or configuration.
6. Before merging, run the full database-backed suites against a disposable database when the fix can affect inventory, tenancy, routing, Queue, or Workflow behavior.

A bug fix is incomplete without a runnable check that would fail if the bug returned.

### Feature Additions

1. Identify the trust boundaries and add or update Valibot schemas first.
2. Add unit tests for pure branches and output formatting.
3. Add real-Postgres integration tests for writes, constraints, concurrency, rollback, idempotency, or tenant isolation.
4. Add webhook/service coverage for user-visible routing and Telegram payloads.
5. Mock model output; do not make live provider calls in automated tests.
6. For schema changes, generate and review the migration before applying it:

   ```sh
   pnpm db:generate
   pnpm db:migrate
   ```

7. Run the complete pre-merge sequence:

   ```sh
   pnpm typecheck
   pnpm test
   pnpm test:e2e
   pnpm build
   ```

Inventory features must prove non-negative stock, transaction atomicity, tenant isolation, and retry behavior where applicable.

### Deployment Validation

Before deployment:

1. Set `TEST_DATABASE_URL` to a disposable branch, set `CABINET_ALLOW_DB_RESET=1`, and run all automated checks. Keep production `DATABASE_URL` separate.
2. Review migrations and apply them to production in the required order.
3. Confirm `wrangler.jsonc` contains no account ID and public commits retain the Hyperdrive placeholder.
4. Run `git diff --check` and inspect `git status --short --ignored` for credentials or generated output.
5. Build and inspect the generated binding list.

After deployment:

1. Check `GET /health` for Worker liveness.
2. Tail Worker logs while running the smoke flow.
3. Verify `/start`, location/item creation, add/remove/check stock, adjustment confirmation, and Excel export.
4. Verify Queue consumption, Workflow completion, Hyperdrive access, and the selected model path.
5. Check Telegram `getWebhookInfo` for pending updates or delivery errors.
6. For changes to timeout or scheduling, observe the real timeout/cron branch before declaring the wiring audit complete.

Record the deployment version, migration, test commands, and smoke result in the pull request or release record. Never use production inventory as automated test data.

### Test Database Warning

Database-backed suites read only `TEST_DATABASE_URL` and execute `TRUNCATE tenants CASCADE`. They also require `CABINET_ALLOW_DB_RESET=1` and reject a test URL that targets the same host/database as `DATABASE_URL`. Use a dedicated disposable Neon branch; the acknowledgement is a guardrail, not permission to use shared data.

## Deployment

### Preparation

1. Create a production Neon database and retain its direct, non-pooled URL for migrations and Hyperdrive creation.
2. Create a Telegram bot with `@BotFather`.
3. Disable the bot's group privacy through `@BotFather` -> `/setprivacy`; otherwise Telegram sends commands but withholds ordinary group messages.
4. Generate `TELEGRAM_WEBHOOK_SECRET` with `openssl rand -hex 32`.
5. For Azure, configure the provider key in AI Gateway BYOK and create an authenticated Gateway token with `AI Gateway Run` permission.
6. Authenticate Wrangler with `pnpm exec wrangler login`, or provide `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in CI.

A CI deployment token needs these account permissions:

- Workers Scripts Edit
- Queues Edit
- Hyperdrive Edit
- Workers AI Read
- Account Settings Read
- AI Gateway Read when deployment automation inspects Gateway configuration

Cloudflare currently has no separate Workflow token permission; Workflow deployment is part of the Worker script deployment.

### Provision And Deploy

1. Apply production migrations:

   ```sh
   pnpm db:migrate
   ```

2. Create Hyperdrive:

   ```sh
   pnpm exec wrangler hyperdrive create postal-db \
     --connection-string="<neon-direct-url>"
   ```

3. Temporarily replace `REPLACE_WITH_YOUR_HYPERDRIVE_ID` in `wrangler.jsonc` with the returned ID. Do not commit an account-specific ID to the public repository.

4. Create the Queue:

   ```sh
   pnpm exec wrangler queues create postal-intent-queue
   ```

5. Build and deploy:

   ```sh
   pnpm build
   pnpm exec wrangler deploy --config dist/postal/wrangler.json
   ```

6. Upload runtime secrets and configuration. `CABINET_MODEL` and `AZURE_GATEWAY_BASE_URL` are not inherently secret, but storing all runtime values through Wrangler keeps account-specific deployment data out of the repository:

   ```sh
   pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
   pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
   pnpm exec wrangler secret put CABINET_MODEL
   pnpm exec wrangler secret put AZURE_GATEWAY_BASE_URL
   pnpm exec wrangler secret put CF_AIG_TOKEN
   ```

7. Register Telegram:

   ```sh
   pnpm telegram:set-webhook https://<worker-host>
   ```

8. Restore the Hyperdrive placeholder before committing or publishing.

### Smoke Test

In a new Telegram group:

1. Send `/start`.
2. Create a location.
3. Create an item with a unit conversion.
4. Receive stock.
5. Remove stock and verify the resulting quantity.
6. Check stock.
7. Request an adjustment and confirm it.
8. Export an Excel report and open the delivered file.

Check Cloudflare logs during the test:

```sh
pnpm exec wrangler tail postal --format pretty
```

## Operations And Maintenance

### Database Changes

1. Edit `src/db/schema.ts`.
2. Run `pnpm db:generate`.
3. Review generated SQL manually, especially indexes and destructive changes.
4. Test against a disposable branch.
5. Run `pnpm db:migrate` against production before deploying code that depends on it.

Ledger rows are never automatically deleted. The 90-day limit applies only to one Excel export window.

### Model Switching

Update the deployed `CABINET_MODEL` value. No source change or rebuild is required. Azure selections continue to use the stored Gateway base URL and token.

### Observability

- `GET /health` is a liveness check only; it does not verify dependencies.
- Use `pnpm exec wrangler tail postal --format pretty` for live Worker and Queue logs.
- Use `pnpm exec wrangler workflows instances list postal-pending-action` for Workflow state.
- Use `pnpm audit:wiring https://<worker-host>` for a non-mutating live dependency check.
- Use Telegram `getWebhookInfo` to inspect webhook delivery errors.
- Inspect Neon transaction and stock rows when reconciling inventory.

## Troubleshooting

### Commands Work But Normal Messages Do Not

Disable Telegram group privacy with `@BotFather` -> `/setprivacy`, then remove and re-add the bot to the group. `getMe.can_read_all_group_messages` must be `true`.

### Webhook Returns 401

Re-register the webhook using the same `TELEGRAM_WEBHOOK_SECRET` stored on the Worker.

### Database Or Hyperdrive Errors

Confirm migrations are applied, the Hyperdrive ID is real in the deployment build, and the Hyperdrive origin uses Neon's direct connection string.

### Azure Returns 401 Or 403

Confirm the Azure key exists in AI Gateway BYOK and `CF_AIG_TOKEN` has `AI Gateway Run` permission. Do not send the Azure provider key from the Worker.

### Azure Returns 404

Confirm `AZURE_GATEWAY_BASE_URL` ends at the Azure resource, not at a deployment or `chat/completions`. Cabinet also accepts a complete DeepSeek/Kimi URL, but the Gateway ID, provider slug, resource, and deployment must exist.

### Messages Queue But No Reply Arrives

Check Worker logs and Queue consumer bindings. Tool validation failures are logged with the Queue message ID. Telegram delivery failure after a database write can currently cause a retry; see [Remaining Work](#remaining-work).

### Health Is Green But A Dependency Is Broken

`/health` returns process liveness only. Test Telegram, Hyperdrive, Queue, Workflow, and the selected model separately.

## Security

- Never commit `.dev.vars`, `.env*`, Wrangler state, generated `dist/`, provider keys, database URLs, bot tokens, private keys, or service-account files.
- `pnpm build` removes the `.dev.vars` copy emitted by Cloudflare tooling from `dist/postal`.
- Build public source archives from tracked files with `git archive`, not by zipping the workspace.
- Keep local secret files readable only by their owner: `chmod 600 .dev.vars`.
- Validate all Telegram, Queue, Workflow, and tool data at trust boundaries.
- Report vulnerabilities through GitHub's private security advisory feature rather than a public issue.

## Roadmap

Cabinet evolves in three gated stages. Later stages are direction, not a commitment to speculative tables or APIs; each begins only after the previous stage's correctness and operational guarantees are complete.

### Cabinet 1: Inventory Core

This is the current product:

- locations, items, and item-specific units;
- stock levels and an append-only movement ledger;
- atomic receive, remove, transfer, and adjustment operations;
- reorder thresholds, history, summaries, and Excel export;
- Telegram commands, Queue writes, and Workflow confirmation.

The correctness and coverage items in [Remaining Work](#remaining-work) must be completed before Cabinet 2 begins.

### Cabinet 2: Stock Control

Cabinet 2 will add the primitives needed to control stock before physical outbound movement:

- reservations, release, and commit;
- available-to-promise (`on_hand - reserved`);
- stock conditions such as available, damaged, and quarantine;
- stock-count and cycle-count sessions with reviewed variance;
- physical transfer lifecycle: create, dispatch, in transit, receive, and discrepancy.

The existing immediate `transfer_stock` remains useful for channel allocation pools such as Website or Shopee. Physical transfers require a separate lifecycle because destination stock must not increase before receipt.

### Cabinet 3: Fulfillment Ops

Cabinet 3 will add physical execution around inbound and outbound merchandise:

- expected receipt references, partial receipts, damage, and receiving discrepancies;
- fulfillment reservation, pick, pack, dispatch, and exceptions;
- expected returns, receipt, inspection, restock, damaged disposition, and write-off.

Cabinet 3 remains scoped to merchandise state and physical stock workflows. Broader business integrations are outside this roadmap and will be specified separately if needed.

## Remaining Work

Product and test completeness:

- Expand daily summaries to match intended product behavior.
- Add CI against an isolated disposable database.

Project publication:

- Add contribution and code-of-conduct files if outside contributions are accepted.

## Contributing

Before opening a pull request:

1. Read `AGENTS.md` and the relevant product flow.
2. Keep changes within MVP scope unless the issue explicitly expands it.
3. Add the smallest regression test that proves non-trivial behavior.
4. Run `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, and `pnpm build` against a disposable database.
5. Confirm `git status --short --ignored` does not expose local credentials or generated output.

Do not include secrets, live database data, account-specific resource IDs, or generated deployment artifacts in issues or pull requests.

## License

Cabinet is licensed under the GNU Affero General Public License v3.0 only. See `LICENSE`.
