# Agent Instructions

## Product boundary

This repository owns a portable household-finance intake and reasoning service plus a generic Compose example. Site-specific production deployment configuration belongs in a separate private deployment repository. Nextcloud Files owns immutable original documents. Namespaced Actual notes own canonical receipt facts, items, provenance, and discard state; Actual transaction notes own receipt-link tokens; and Actual transactions own the financial ledger. Finance-bot SQLite is limited to signed queues, audit records, and rebuildable projections.

The model is an unprivileged parser and reasoning component. It never receives shell, database, Docker, unrestricted filesystem, WebDAV, bank, or raw Actual access. Deterministic code validates typed proposals and performs permitted writes.

## Safety defaults

- Use fake or synthetic financial data unless the repository owner explicitly authorizes a private fixture or live-data operation.
- Never commit or print receipts, statements, model payloads, account identifiers, card digits, credentials, private fixture paths, or live database content.
- Keep private fixtures under an ignored `fixtures/private/` or outside the repository; never alter their originals.
- Model transmission, Actual writes, bank connections, Nextcloud administration, and production deployment require their explicit activation gate.
- Store money as integer minor units.
- Preserve idempotency, the transactional outbox, immutable source documents, extraction provenance, and model/write separation.
- Do not mount the Docker socket, Notes vault, home directory, or Nextcloud data directory.

## Engineering

- Use Node 24, TypeScript ESM, and pnpm.
- Prefer a single finance-bot process until measured load or isolation requirements justify another service.
- Keep configuration typed and fail closed when allowlists, secrets, or activation flags are inconsistent.
- Preserve user-owned work and never force-push or discard unrelated changes.

Expected checks:

```sh
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm verify:compose
docker build -t household-finance-bot:local .
```
