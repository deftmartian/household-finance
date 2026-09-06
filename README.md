# Household Finance

A self-hosted household assistant using Nextcloud Talk, an existing Actual Budget ledger, and a bounded model API. One application image, one SQLite work database, one scheduler, and one serialized Actual writer.

The assistant accepts text and receipt photos, PDFs, JSON, CSV, TSV, and XLSX. Known Amazon exports use deterministic extraction. Voice is unsupported and receives a request to send text without transcription or archiving.

Purchase records live in namespaced Actual notes. Transactions show readable item details and preserve handwritten memos. Original files remain in Nextcloud. The application never provisions accounts, relinks banks, creates imported transactions, or changes balances. Existing Actual rules take precedence; ambiguous matches or unsupported split arithmetic require a conversational clarification.

Household context lives in the application's SQLite database, with attribution, explicit/inferred status, scope, revision checks, and forgetting. SQLite full-text search and bounded history retrieval are sufficient for the initial deployment; there is no QMD dependency. Fresh financial facts come from Actual, not memory.

## Development

Use Node 24 and pnpm. Run `pnpm install --frozen-lockfile`, then `pnpm verify`. Build the image with `docker build --target finance-runtime -t household-finance:local .` and run `bash scripts/verify-container.sh household-finance:local`.

Configuration is a private JSON file modeled on [the example](config/finance.example.json). Credentials are separate read-only files. Activation and model access default to disabled. The daily model budget uses USD ticks (10 billion ticks per dollar). Reservations conservatively account for uncertain requests; an underestimated reservation stops model processing rather than silently continuing beyond the configured assumptions.

## Deployment

See [deployment and recovery](docs/deployment.md). The generic Compose example contains only the application and Actual Server. Site-specific network, secret, and release settings belong in a private deployment repository. Preserve an existing Actual volume and budget identity during replacement.

The signed webhook endpoint is `/talk/webhook`. The bot identity and room remain stable. Room-history backfill recovers webhook gaps, and replies reconcile by reference ID before retrying. A history window exceeded during a long outage can still produce a rare duplicate notification; ledger operations have a separate durable journal.

## Boundaries

The model has no shell, credentials, raw database handle, unrestricted filesystem, or network tools. Deterministic code validates its typed proposals. Combining the former reader and writer into one process means application code holds both credentials; this is a deliberate simplification, not process-level isolation between those roles.

Documents run in a child namespace without network, secrets, host process visibility, or application state, with CPU, memory, file-size, page, and image limits. Both the local build and deployed container must pass this boundary test.

Zero-data-retention is checked with a synthetic probe before household interpretation and on every provider response. Missing assurance stops processing. No raw financial or model payloads belong in logs, source control, or issue reports.
