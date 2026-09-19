# Kredlit Cabinet

Kredlit Cabinet is a Telegram-first inventory agent for small retailers. Staff manage items, stock, locations, transfers, adjustments, alerts, and Excel reports from a Telegram group instead of a separate dashboard.

The application runs on Cloudflare Workers and stores its inventory ledger in Neon Postgres. Natural-language intent parsing can use either native Workers AI or Azure models through Cloudflare AI Gateway BYOK.

The product and package name are **Kredlit Cabinet** / `cabinet`. Default Cloudflare resources use the `cabinet` slug; deployers may choose different names in `wrangler.jsonc`.

> Project status: Cabinet 1 Inventory Core is implemented, deployed, and verified. The [roadmap](#roadmap) describes later stock-control and fulfillment capabilities.

## Rename Notice

This project was previously developed under the name **Postal**. Cabinet v0.5.0 establishes the new product, package, environment-variable, and default Cloudflare resource names. Earlier Git history may retain the former name; that history is preserved intentionally rather than rewritten. Existing deployments are not renamed automatically, so operators upgrading an older deployment must either keep their existing resource names in a private Wrangler configuration or provision the new Cabinet defaults before deploying.

## Ownership And Contact

Cabinet is part of the **Kredlit** product family, a Repaera Labs product unit. The open-source project is owned and maintained by **Repaera**.

For general project communication, contact [hey@repaera.com](mailto:hey@repaera.com). Use [GitHub Discussions](https://github.com/repaera/kredlit-cabinet/discussions) for public feature ideas, bug triage, setup questions, and community support. Report security vulnerabilities privately according to [SECURITY.md](SECURITY.md).

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

## Production Setup: Start To Team Access

Follow this sequence for a fresh installation. At the end, Cabinet will be available to registered staff in the chosen Telegram group. Resource names shown below are defaults and may be changed consistently in `wrangler.jsonc` and deployment commands.

### 1. Prepare Accounts And Tools

You need:

- Node.js 24 or newer and pnpm 11 or newer;
- a Cloudflare account with Workers enabled;
- a Neon project with separate production and disposable test branches;
- a Telegram account that can create a bot and add it to the chosen group;
- an Azure AI Gateway BYOK configuration only for an `azure-*` model.

Install the project:

```sh
pnpm install
cp .env.example .dev.vars
chmod 600 .dev.vars
```

### 2. Create And Configure The Telegram Bot

In Telegram, open `@BotFather`:

1. Run `/newbot`, choose the **Kredlit Cabinet** display name, and choose an available bot username.
2. Save the returned token as `TELEGRAM_BOT_TOKEN` in `.dev.vars`.
3. Run `/setprivacy`, select the bot, and choose **Disable**. Cabinet needs ordinary group messages, not commands only.
4. If privacy was changed after the bot joined a group, remove and re-add the bot before testing.
5. Generate a webhook verification secret locally:

   ```sh
   openssl rand -hex 32
   ```

6. Store it as `TELEGRAM_WEBHOOK_SECRET` in `.dev.vars`.

Do not use the bot token as the webhook secret.

### 3. Prepare Production And Test Databases

Create two isolated Neon branches or databases:

- production: used by the deployed Worker;
- test: disposable and used only by automated tests.

Use direct, non-pooled connection strings:

```dotenv
DATABASE_URL=postgresql://<production-direct-url>
TEST_DATABASE_URL=postgresql://<test-direct-url>
CABINET_ALLOW_DB_RESET=1
```

`pnpm test` and `pnpm test:e2e` truncate all Cabinet tables in `TEST_DATABASE_URL`. The test guard rejects the same database target as `DATABASE_URL`, but the operator must still verify both values.

Apply migrations to the test branch and run all checks:

```sh
DATABASE_URL="<test-direct-url>" pnpm db:migrate
CABINET_ALLOW_DB_RESET=1 pnpm test
CABINET_ALLOW_DB_RESET=1 pnpm test:e2e
pnpm test:runtime
pnpm typecheck
pnpm build
```

Apply the same reviewed migrations to production:

```sh
pnpm db:migrate
```

### 4. Select The Model

Set one model selector in `.dev.vars`:

```dotenv
CABINET_MODEL=worker-kimi
```

Choose one value from [Model Selection](#model-selection).

For `worker-*`, no provider API key is required. For `azure-*`:

1. Store the Azure provider key in Cloudflare AI Gateway BYOK.
2. Create an authenticated Gateway token with `AI Gateway Run` permission.
3. Set:

   ```dotenv
   CABINET_MODEL=azure-deepseek
   AZURE_GATEWAY_BASE_URL=https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-id>/azure-openai/<azure-resource>
   CF_AIG_TOKEN=<gateway-run-token>
   ```

Never put the Azure provider key in Worker configuration.

### 5. Authenticate Cloudflare

For an interactive deployment:

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
```

For CI, configure `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The token needs:

- Workers Scripts Edit;
- Queues Edit;
- Hyperdrive Edit;
- Workers AI Read;
- Account Settings Read;
- AI Gateway Read only when automation inspects Gateway configuration.

Cloudflare currently has no separate Workflow token permission; Workflow deployment is part of the Worker script deployment.

### 6. Provision Hyperdrive And Queue

Create Hyperdrive with the production direct URL:

```sh
pnpm exec wrangler hyperdrive create cabinet-db \
  --connection-string="<production-neon-direct-url>"
```

Temporarily replace `REPLACE_WITH_YOUR_HYPERDRIVE_ID` in `wrangler.jsonc` with the returned ID. The real ID is deployment-specific and must not be committed to the public repository.

Create the Queue:

```sh
pnpm exec wrangler queues create cabinet-intent-queue
```

The Workflow, rate limiter, cron trigger, Workers AI binding, and Flue Durable Object are deployed from the generated Worker configuration; they do not need separate create commands.

### 7. Build And Deploy The Worker

```sh
pnpm build
pnpm exec wrangler deploy --config dist/cabinet/wrangler.json
```

The first deployment creates the Worker and its bindings. Record the resulting HTTPS Worker URL.

### 8. Upload Runtime Secrets And Model Configuration

Upload the values used by the deployed Worker:

```sh
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm exec wrangler secret put CABINET_MODEL
```

For Azure selections also run:

```sh
pnpm exec wrangler secret put AZURE_GATEWAY_BASE_URL
pnpm exec wrangler secret put CF_AIG_TOKEN
```

`CABINET_MODEL` and `AZURE_GATEWAY_BASE_URL` are configuration rather than provider credentials, but storing them with Wrangler keeps account-specific deployment values outside the repository. Secret changes create a new Worker version automatically.

### 9. Register And Verify The Telegram Webhook

Register the deployed endpoint:

```sh
pnpm telegram:set-webhook https://<worker-host>
```

Then run the non-mutating wiring audit:

```sh
pnpm audit:wiring https://<worker-host>
```

The audit verifies Worker health, Telegram bot privacy and webhook state, Queue, Hyperdrive, Workflow registration, and the configured Azure model when selected. Telegram should report zero pending updates and no webhook delivery error.

### 10. Connect The Chosen Main Group

1. Create or open the Telegram group that should become the main inventory group.
2. Add the Cabinet bot to that group and ensure group permissions allow it to send messages and documents.
3. Send `/start`. In groups, Telegram may render it as `/start@BotUsername`; Cabinet supports both forms.
4. Confirm the **Welcome to Kredlit Cabinet** reply.

No `TELEGRAM_CHAT_ID` or manually copied room ID is required. Telegram includes `message.chat.id` and the group title in the webhook update. On the first `/start`, Cabinet atomically creates:

- a tenant named from the Telegram group title;
- the `telegram_chats` mapping for that chat ID;
- a tenant user for the sender.

Subsequent messages resolve the tenant through this stored mapping. Repeating `/start` in the same group is safe and does not create another tenant.

### 11. Register The Team

Each staff member who will use Cabinet must register once for the tenant:

1. join the chosen main Telegram group;
2. send `/start` once from their own Telegram account in that main group;
3. confirm that Cabinet reports the group is already set up.

For an existing group, `/start` only registers the sender as a tenant member. It does not reset inventory or create another tenant. Until registered, that staff member's ordinary messages receive a prompt to run `/start`.

Current access model:

- anyone who can add the bot to a new group and send `/start` can initialize a new tenant;
- Telegram group membership plus Cabinet user registration is the access boundary;
- every registered member may perform inventory operations;
- `/link` is not restricted to Telegram administrators;
- role-based or Telegram-admin authorization is not implemented yet.

Only add trusted staff and the Cabinet bot to inventory groups.

### 12. Configure Initial Inventory

From the main group:

1. Add locations, for example `lokasi: Toko A, Gudang A, Website, Shopee`.
2. Create items with base units and optional conversions.
3. Receive initial stock into the correct location.
4. Configure reorder thresholds where needed.
5. Check stock and confirm names, units, and quantities.

The main group is tenant-wide by default and can access every tenant location.

### 13. Connect Optional Location-Specific Groups

To dedicate another group to one location:

1. Ensure the person configuring it already sent `/start` in the main group.
2. Add the bot to the additional Telegram group.
3. Send `/link <location name>`, for example `/link Toko A`.
4. Confirm the **Group linked** reply.
5. Confirm that staff already registered in the main group can use Cabinet from the linked group.

Cabinet obtains the new group's chat ID from Telegram automatically. `/link` succeeds only when the sender belongs to exactly one Cabinet tenant; users belonging to multiple tenants currently require manual resolution.

There is no Telegram unlink command in the current release. Correct an accidental link directly in the database.

### 14. Run The Live Smoke Test

Keep Worker logs open:

```sh
pnpm exec wrangler tail cabinet --format pretty
```

From Telegram, verify:

1. `/start` and staff registration;
2. create a location and item with a unit conversion;
3. receive stock;
4. remove stock and verify the remaining quantity;
5. check all locations;
6. transfer stock between two locations;
7. request an adjustment, then test confirm and cancel;
8. allow one test confirmation to expire and verify stock is unchanged;
9. lower stock below a threshold and verify alert routing;
10. export an Excel report and open the delivered file.

Run the wiring audit again after the smoke test and check Telegram webhook status for errors.

### 15. Restore Public Configuration And Hand Off

Before committing or publishing:

1. restore `"id": "REPLACE_WITH_YOUR_HYPERDRIVE_ID"` in `wrangler.jsonc`;
2. remove generated `dist/` output;
3. verify `.dev.vars`, `.wrangler/`, private planning files, and debug files are ignored;
4. run `git diff --check` and inspect `git status --short --ignored`;
5. record migrations, test commands, Worker version, and smoke-test evidence in the release record.

Operationally, the team now accesses Cabinet entirely through the selected Telegram groups. No staff member needs Cloudflare, Neon, webhook, or chat-ID access for normal inventory work.

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
- Use `pnpm exec wrangler tail cabinet --format pretty` for live Worker and Queue logs.
- Use `pnpm exec wrangler workflows instances list cabinet-pending-action` for Workflow state.
- Use `pnpm audit:wiring https://<worker-host>` for a non-mutating live dependency check.
- Use Telegram `getWebhookInfo` to inspect webhook delivery errors.
- Inspect Neon transaction and stock rows when reconciling inventory.

## Troubleshooting

### Commands Work But Normal Messages Do Not

Disable Telegram group privacy with `@BotFather` -> `/setprivacy`, then remove and re-add the bot to the group. `getMe.can_read_all_group_messages` must be `true`.

### A Staff Member Is Told To Run `/start`

Every Telegram account must send `/start` once in the tenant's main group. Membership is tenant-wide, so the user can then operate from that tenant's linked groups without registering again. In an unlinked new group, `/start` creates a new tenant; use `/link <location>` first when attaching an additional group to an existing tenant.

### `/link` Cannot Determine The Tenant

The sender must first register in the main group. `/link` currently requires the sender to belong to exactly one Cabinet tenant; users belonging to multiple tenants need the target chat mapping corrected directly in the database.

### A Group Was Converted To A Supergroup

Telegram may assign a new chat ID when a group is migrated to a supergroup. Cabinet does not currently process Telegram's migration update automatically. Stop inventory operations, obtain the new chat ID from the Telegram update/Worker logs, and update `telegram_chats` so the new ID points to the existing tenant and optional location. Do not run `/start` first unless creating a separate tenant is intentional.

Telegram forum topics share a group chat ID. Cabinet does not currently maintain separate inventory context per topic/thread.

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
- `pnpm build` removes the `.dev.vars` copy emitted by Cloudflare tooling from `dist/cabinet`.
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

## Release Guide

GitHub releases and Cloudflare deployments are separate operations. A GitHub release publishes a tagged source revision; it does not deploy or modify a Worker. The example below prepares the planned `v0.5.0` release; substitute the next semantic version for later releases.

### 1. Finalize The Repository Name

If the GitHub repository still uses its former name, rename it to `kredlit-cabinet` in **GitHub -> Settings -> General -> Repository name** before creating the release.

Update the local remote afterward:

```sh
git remote set-url origin https://github.com/repaera/kredlit-cabinet.git
git remote -v
```

GitHub normally redirects the former URL, but release documentation and clone commands should use the Cabinet URL.

In repository settings, also enable **Discussions** and **Private vulnerability reporting**. The contribution and security links depend on those GitHub features.

### 2. Prepare `main`

Start from `main`, inspect the current worktree, and fetch remote state before tagging:

```sh
git switch main
git fetch origin
git status --short --branch
git log --oneline HEAD..origin/main
```

Do not run `git pull` with uncommitted release work. If `main` is behind, either synchronize before making release changes or commit the reviewed release work and rebase it onto `origin/main` before pushing. Do not continue if unrelated changes, generated output, or secret-bearing files appear.

### 3. Set The Version

The package currently uses a pre-release development version. Set the release version without creating an automatic tag:

```sh
pnpm version 0.5.0 --no-git-tag-version
pnpm install --lockfile-only
```

Verify `package.json` contains:

```json
{
  "name": "cabinet",
  "version": "0.5.0",
  "license": "AGPL-3.0-only"
}
```

### 4. Run The Release Test Matrix

Confirm `.dev.vars` points to a disposable test database that is different from production, then run:

```sh
CABINET_ALLOW_DB_RESET=1 pnpm test
CABINET_ALLOW_DB_RESET=1 pnpm test:e2e
pnpm test:runtime
pnpm typecheck
pnpm build
```

Expected release baseline:

- core/integration/workflow tests pass;
- all Telegram-update E2E tests pass;
- exact-date workerd runtime test passes;
- TypeScript passes;
- the Worker builds under `dist/cabinet`;
- `dist/cabinet/.dev.vars` does not exist after the build script finishes.

Do not run database-backed tests against production or a shared branch.

### 5. Review Migrations And Public Files

Review migrations in order and confirm no unreviewed destructive SQL exists:

```sh
ls src/db/migrations
git diff --check
git status --short --ignored
git add --dry-run --all
```

The release staging set must exclude:

- `.dev.vars` and `.env*` except `.env.example`;
- `.wrangler/` and generated `dist/` output;
- private planning/context files;
- debug files, credentials, database URLs, private keys, and account-specific resource IDs.

Keep the Hyperdrive placeholder in the committed `wrangler.jsonc`:

```json
"id": "REPLACE_WITH_YOUR_HYPERDRIVE_ID"
```

Never attach the workspace or `dist/` directory to a public release. GitHub automatically generates source archives from the tagged commit.

### 6. Prepare Release Notes

The v0.5.0 notes should include:

```markdown
## Cabinet v0.5.0

First public Cabinet Inventory Core release.

### Highlights
- Telegram-first multi-location inventory
- Atomic stock receive, sale, transfer, and adjustment flows
- Durable confirmation and location workflows
- Queue retry idempotency and tenant isolation
- Unit conversion, thresholds, alerts, history, and Excel export
- Workers AI and Azure AI Gateway BYOK support

### Rename Notice
This project was previously developed under another name. Git history retains
that history intentionally. Fresh deployments use Cabinet package, environment,
and Cloudflare resource defaults. Existing deployments are not renamed
automatically.

### Upgrade Notes
- Use `CABINET_MODEL` for model selection.
- Use `CABINET_ALLOW_DB_RESET=1` only with a disposable `TEST_DATABASE_URL`.
- Review and apply migrations `0000` through `0003` in order.
- Existing deployments must preserve their current private resource mapping or
  provision the Cabinet defaults before deploying.
```

Save the reviewed GitHub release notes outside the repository, for example `/tmp/cabinet-v0.5.0-notes.md`.

### 7. Create The Release Commit

Stage only intended public files and inspect them before committing:

```sh
git add --all
git diff --cached --check
git diff --cached --stat
git status --short
git commit -m "release: Cabinet v0.5.0"
```

Confirm the release commit contains no secrets:

```sh
docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:latest \
  git --redact --no-banner /repo
```

If the scan reports a real credential, remove it from the commit and history, rotate it, and rerun the checks. Do not publish first and clean up later.

### 8. Push `main` And Create The Tag

Push the reviewed commit:

```sh
git push origin main
```

Create and push an annotated tag pointing to that exact commit:

```sh
git tag -a v0.5.0 -m "Cabinet v0.5.0"
git show --stat v0.5.0
git push origin v0.5.0
```

Do not move or recreate a published release tag. Publish a new patch version if a correction is required later.

### 9. Create The GitHub Release

Using GitHub CLI:

```sh
gh release create v0.5.0 \
  --title "Cabinet v0.5.0" \
  --notes-file /tmp/cabinet-v0.5.0-notes.md \
  --verify-tag
```

Alternatively, create a release from tag `v0.5.0` in **GitHub -> Releases -> Draft a new release** and paste the reviewed notes.

This repository is marked `private` in `package.json`, so this process creates a GitHub source release only; it does not publish an npm package.

### 10. Verify The Published Release

```sh
gh release view v0.5.0
git ls-remote --tags origin v0.5.0
```

From a clean temporary directory, download or clone the tag and confirm:

```sh
git clone --branch v0.5.0 --depth 1 https://github.com/repaera/kredlit-cabinet.git
cd kredlit-cabinet
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:unit
pnpm build
```

Verify the source archive contains no ignored local files and that README links, license information, setup commands, and rename notice render correctly on GitHub.

### 11. Deploy Separately If Required

Releasing v0.5.0 does not deploy Cabinet. To deploy the tagged version, follow [Production Setup: Start To Team Access](#production-setup-start-to-team-access), record the deployed Worker version, and run:

```sh
pnpm audit:wiring https://<worker-host>
```

### Release Rollback

If the GitHub release metadata is wrong but the tag is correct, edit the release notes instead of replacing the tag.

If the tag points to the wrong commit and has not been consumed yet:

```sh
gh release delete v0.5.0 --yes
git push origin --delete v0.5.0
git tag --delete v0.5.0
```

Fix the release commit and create a new tag. Once users may have consumed `v0.5.0`, do not rewrite it; publish `v0.5.1` instead.

## Contributing

Contributions are welcome. Read the [contributing guide](CONTRIBUTING.md) for the discussion-first workflow, forking, local setup, tests, commits, and pull requests. Report vulnerabilities privately according to the [security policy](SECURITY.md).

Before opening a pull request:

1. Read `CONTRIBUTING.md`, `AGENTS.md`, and the relevant source.
2. Keep changes within the current Cabinet 1 scope unless the issue explicitly expands it.
3. Add the smallest regression test that proves non-trivial behavior.
4. Run `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, and `pnpm build` against a disposable database.
5. Confirm `git status --short --ignored` does not expose local credentials or generated output.

Do not include secrets, live database data, account-specific resource IDs, or generated deployment artifacts in issues or pull requests.

## License

Cabinet is licensed under the GNU Affero General Public License v3.0 only. See `LICENSE`.
