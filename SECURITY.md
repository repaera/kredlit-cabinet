# Security

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/repaera/kredlit-cabinet/security/advisories/new). Do not disclose vulnerabilities, credentials, production data, or exploit details in public issues or discussions.

Cabinet is pre-1.0 software. Security fixes are provided for the latest minor release line only.

## Trust Model

Cabinet is self-hosted. The deployment operator already controls the Cloudflare account, Worker secrets, Telegram bot, Hyperdrive configuration, and database. Behavior requiring that infrastructure-level access generally grants nothing the operator does not already possess and is not, by itself, a vulnerability.

We do want reports of:

- cross-tenant access or data disclosure;
- stock mutation without an authorized tenant/chat/user context;
- negative-stock, transaction-integrity, or idempotency bypass;
- callback, webhook-secret, Queue, or Workflow ownership bypass;
- credential disclosure through source, logs, builds, exports, or releases;
- model/tool boundary validation that enables unauthorized operations;
- dependency issues with a demonstrated Cabinet impact.

## Intentional Behavior

- A person who can add the bot to a new Telegram group and send `/start` can initialize a new tenant.
- Registered tenant members can perform inventory operations; Telegram-admin role enforcement is not part of the current release.
- The self-hosting operator can inspect and modify the database and Worker configuration.
- Telegram message text and configured location names may be sent to the selected model provider for intent parsing.
- Queue and Telegram notification delivery are at-least-once; inventory mutation is protected by persisted intent idempotency.

These behaviors may deserve product changes, but reports that assume a trusted operator or registered tenant member has no such access should explain the additional security boundary being crossed.

## Reporting Details

Include the affected version, deployment context, impact, reproduction steps, and suggested mitigation when available. Redact tokens, database URLs, account IDs, chat IDs, and tenant data.

Maintainers aim to acknowledge reports within 3 business days and provide an initial assessment within 7 business days. These are targets, not a service-level agreement. Please allow reasonable time for coordinated remediation before public disclosure.

If private vulnerability reporting is unavailable, email [hey@repaera.com](mailto:hey@repaera.com) with the subject `Cabinet security report`. Do not include live credentials; arrange a secure exchange if sensitive evidence is required.
