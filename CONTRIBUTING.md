# How To Contribute To Cabinet

Cabinet uses [GitHub Discussions](https://github.com/repaera/kredlit-cabinet/discussions) for feature ideas, configuration questions, and reports that are not yet clearly reproducible. The [issue tracker](https://github.com/repaera/kredlit-cabinet/issues) is reserved for agreed, actionable work.

Cabinet is part of the Kredlit product family and is maintained by Repaera. For general project communication outside GitHub, contact [hey@repaera.com](mailto:hey@repaera.com).

This keeps open issues useful: each issue should describe work that is approved, ready to implement, or already in progress.

## Start In The Right Place

### If You Found A Bug

1. Search existing discussions, issues, and pull requests.
2. If you have reliable reproduction steps, open a discussion with those steps and sanitized diagnostics.
3. If the behavior is uncertain or environment-specific, open a discussion and ask for help reproducing it.
4. A maintainer will move an accepted, well-understood bug into the issue tracker.

Security vulnerabilities are different: report them privately according to `SECURITY.md`.

### If You Have A Feature Idea

Open a discussion before writing code. Explain the operational problem, intended user behavior, inventory and tenant-safety impact, and alternatives considered.

Do not open a speculative implementation pull request before the behavior and scope are agreed.

### If You Need Setup Help

Read the README setup and troubleshooting sections, search existing discussions, then open a discussion with your Cabinet version, environment, reproduction steps, and redacted errors.

Never post credentials, database URLs, account IDs, chat IDs, private keys, production inventory, or unredacted logs.

## Work On An Approved Issue

1. Choose an open issue that is not already marked or described as in progress.
2. Comment that you intend to work on it.
3. Ask questions on the issue as you go rather than guessing about product behavior.
4. Keep the pull request limited to that issue.

## Fork And Clone

Fork the repository on GitHub, then clone your fork:

```sh
git clone https://github.com/<your-account>/kredlit-cabinet.git
cd kredlit-cabinet
git remote add upstream https://github.com/repaera/kredlit-cabinet.git
git remote -v
```

Synchronize your local `main`:

```sh
git switch main
git fetch upstream
git merge --ff-only upstream/main
git push origin main
```

Create one focused branch:

```sh
git switch -c fix/short-description
```

Use `fix/`, `feat/`, `docs/`, `test/`, or `chore/` prefixes where useful.

## Set Up Development

```sh
pnpm install
cp .env.example .dev.vars
chmod 600 .dev.vars
```

Configure separate development and disposable test databases:

```dotenv
DATABASE_URL=postgresql://<development-direct-url>
TEST_DATABASE_URL=postgresql://<disposable-test-direct-url>
CABINET_ALLOW_DB_RESET=1
```

Apply migrations to the disposable test database before database-backed tests:

```sh
DATABASE_URL="<disposable-test-direct-url>" pnpm db:migrate
```

`pnpm test` and `pnpm test:e2e` truncate all Cabinet tables in `TEST_DATABASE_URL`. Never use production or shared data.

## Make The Change

Read `AGENTS.md` before changing application behavior. In particular:

- scope every query and ID to the tenant;
- keep stock decreases atomic and non-negative;
- keep transfers and intent receipts transactional;
- preserve Queue retry idempotency;
- validate every trust boundary with Valibot;
- keep the stock ledger append-only;
- never expose internal IDs or raw tool JSON to users.

For a bug fix, add a focused failing regression test first. For a feature, test validation, database invariants, Telegram routing, failure paths, and user-facing output at the appropriate levels.

For schema changes:

```sh
pnpm db:generate
```

Review generated SQL and test it against a disposable database. Never edit a migration that has already shipped.

## Run The Checks

Before opening a pull request:

```sh
CABINET_ALLOW_DB_RESET=1 pnpm test
CABINET_ALLOW_DB_RESET=1 pnpm test:e2e
pnpm test:runtime
pnpm typecheck
pnpm build
git diff --check
git status --short --ignored
```

Confirm ignored credentials and generated output are not staged, and `dist/cabinet/.dev.vars` does not exist after the build.

## Commit And Push

Use concise, imperative commit messages:

```text
fix: prevent duplicate queue mutation
feat: validate stock reservation input
docs: clarify Telegram group onboarding
```

Then synchronize and push your branch:

```sh
git fetch upstream
git rebase upstream/main
git push --force-with-lease origin HEAD
```

Use `--force-with-lease` only for your own rebased branch, never shared branches or `main`.

## Open The Pull Request

Open a pull request against `main`:

```sh
gh pr create --base main --fill
```

The pull request description must include:

- the approved issue, using `Fixes #<number>` when appropriate;
- the problem and chosen behavior;
- a concise list of changes;
- exact test commands and results;
- migration and deployment order, when applicable;
- new variables, bindings, permissions, or operational behavior;
- known limitations and follow-up work.

Include screenshots or Telegram copy only when behavior is user-visible, and redact all real names, IDs, and inventory data.

Maintainers may request smaller scope, stronger tests, migration changes, or documentation. Passing tests alone does not guarantee acceptance; correctness, security, maintainability, and project direction also apply.

## License And AI Assistance

Contributions are accepted under the repository's AGPL-3.0-only license.

AI-assisted contributions are welcome, but the contributor remains responsible for every line, test, and license implication. Never provide repository secrets or private production data to an external model.
