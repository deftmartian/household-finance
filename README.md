# Household Finance

Household Finance is the bookkeeping assistant I wanted for my own home: send
it a receipt, ask where the money went, or tell it how a transaction should be
categorized without opening another dashboard.

I had used YNAB and other budgeting software before, but I wanted something
self-hosted that could work with the tools I already had and that I could talk
to normally. Actual Budget gave me the ledger. The missing piece was a safe
conversational layer that could collect receipts, understand purchases, match
them to imported bank transactions, and make only the changes I had authorized.

My current deployment uses:

- **Nextcloud Talk** for messages, voice notes, and receipt uploads;
- **Actual Budget** as the financial ledger;
- **SimpleFIN** to bring in bank transactions; and
- **xAI's Grok API** for receipt understanding and conversational reasoning.

Those are the integrations implemented today, not a claim that they are the
only possible ones. A different chat service can translate its messages,
attachments, and replies into the same workflows. A different model provider
can implement the structured extraction and reasoning contracts. The code has
useful seams for both, but version 0.0.1 is not yet a drop-in adapter framework;
new integrations will still require deliberate implementation and testing.

> **0.0.1 is the initial public release.** It reflects a real, production-like
> personal deployment, but it is not a turnkey finance appliance. Expect to
> supply your own identities, category plan, credentials, private deployment
> configuration, and threat-model decisions.

## How it works

```text
Talk message
  -> answer naturally with broad, typed Actual reads
  -> categorize or split one explicitly identified transaction
  -> update household context or recurring payee rules

Talk voice message
  -> persist the signed attachment reference and return immediately
  -> verify zero-data-retention, retrieve it inside the worker, and transcribe it
  -> send the transcript through the same conversational agent

Talk image/PDF
  -> extract the receipt
  -> let the conversational agent answer from the exact extraction, coalescing same-post photos
  -> publish its merchant, totals, line items, and provenance to an Actual note
  -> settle duplicate/multi-photo uploads
  -> match it now or retry after the SimpleFIN transaction arrives

Actual transaction
  -> categorize it with or without a receipt
  -> use item-level splits when the purchase spans categories

Proposed Actual change
  -> verify the existing imported transaction and exact cents
  -> send a signed intent to the isolated writer
  -> update, read back, and record the result
```

The model handles the work that actually needs interpretation: receipt reading,
merchant and item
understanding, category choice, multi-category proposals, free-form questions,
and household-aware reasoning. Household context is editable in the same Talk
room, so either household member can correct what the bot remembers in plain
language.

The money boundary stays deterministic:

- only an existing, allowlisted imported transaction can be changed;
- transaction identity and the observed pre-update state must still match;
- category IDs are allowlisted and split amounts must balance to the cent;
- idempotency and duplicate guards prevent the same work from being applied twice;
- only a signed, narrowly typed existing-transaction or receipt-note intent reaches the isolated Actual writer;
- compare-and-set updates, readback, durable audit state, and bounded recovery handle uncertain outcomes.

Receipts may arrive before SimpleFIN exposes the transaction. They remain
pending and are reconsidered after sync. Matching searches from the receipt day
through seven days later by default. It can use one exact charge or a unique,
same-account set of two to six charges whose sum is exact. The system never
creates a guessed bank or credit-card transaction just because the import is
late. Missing item rows do not block a match when the receipt-level merchant,
date, currency, and total are clear. When item amounts cannot support an exact
split, the system uses one whole-purchase category if the receipt or household
caption makes that clear; readable mixed purchases still use item-level splits.
Immediate replies and follow-up questions can use the bounded local extraction
while the canonical Actual note is still settling; once that note exists, it is
the source of truth.

Receipt facts are durable in Actual as strict, namespaced JSON notes. Matching
adds a namespaced receipt-and-source-revision token to each linked transaction
note. A corrected image can replace an uncommitted match, while a revision that
arrives after an Actual write began stops for review instead of rewriting a
split transaction. SQLite holds only signed queues, audit evidence, and
projections that can be rebuilt from Actual, avoiding a second durable copy of
the receipt record.

When something material is genuinely unclear, the bot asks one short,
plain-language question. If it still cannot safely identify the transaction or
amount, it leaves the item for manual attention and explains what is needed.
Normal production use has no `!` commands and replies should not expose
internal IDs or implementation jargon.

## What 0.0.1 includes

The current implementation includes:

- automatic receipt intake from the private Talk room;
- JPEG, PNG, and PDF receipts;
- xAI extraction with Zero Data Retention checks;
- categorization of imported transactions, including transactions without receipts;
- item-level category splits for mixed purchases;
- receipt-first waiting and later matching;
- duplicate and multi-photo receipt bundling;
- one-receipt-to-many-charge matching for unique exact same-account sets;
- canonical line items and provenance in Actual notes;
- receipt discard tombstones that preserve the archived original and prior ledger writes;
- free-form questions over bounded Actual data;
- durable, retry-safe voice transcription through the same conversation path;
- conversational single-category and balanced-split edits of existing imports;
- explicit recurring payee categorization rules;
- editable household context; and
- guarded updates of existing imported Actual transactions.

Cash and other genuinely manual transactions are not created automatically.
Backup/restore verification remains deferred.

## Security boundary

- Talk callbacks must be signed and come from the configured private room and allowed actors.
- Attachment retrieval is bound to the signed Nextcloud file identity, MIME type, ETag, and size. Inputs are capped at 12 MiB and checked by magic bytes.
- A separate `document-preparer` parses images and PDFs without secrets, persistent storage, or external network access.
- xAI requests use `store: false`, strict structured output, bounded retries, and require `x-zero-data-retention: true` on every response. Voice intake verifies ZDR before retrieving or uploading the audio, verifies the transcription response again, and wipes its local byte buffer afterward. Receipt extraction uses inline prepared images. Finance conversations use bounded typed tools and client-side encrypted-reasoning continuation rather than provider-stored response state. Costco product lookup sends only one printed item number and its adjacent abbreviated label to bounded public web search; household and ledger context stay out of that request.
- `MODEL_NAME` and `MODEL_REASONING_EFFORT` select the xAI model and reasoning level at deployment time.
- The prepaid xAI balance is the spend cap; the service does not maintain a second local dollar budget.
- The model never receives raw Actual IDs, credentials, SQL, or a generic Actual client. It receives bounded ledger and receipt tools. Deterministic code resolves the imported transaction or unique exact charge set and validates categories and balanced cents before a signed, idempotent intent can exist.
- `finance-bot` has no Actual password. `actual-reader` exposes bounded reads; only the internal, no-WAN `actual-writer` receives the write credential and full production contract.
- Tracked examples fail closed. Site identities, contracts, and credentials stay in the untracked deployment configuration or file-backed secrets.

These controls reduce exposure; they do not turn provider ZDR, container
isolation, or IP-based egress filtering into absolute guarantees.

## Local verification

Requirements: Node 24, Corepack, pnpm 10.32, Docker Compose, Poppler, and a
container engine for image builds.

```sh
nvm exec 24 corepack pnpm install
nvm exec 24 corepack pnpm verify
nvm exec 24 corepack pnpm audit --prod
```

`pnpm verify` includes the rendered Compose security contract.

Run the fail-closed service locally:

```sh
nvm exec 24 corepack pnpm dev
curl --fail http://127.0.0.1:4380/health/ready
```

## Deployment

`compose.yaml` is a generic deployment example. Keep site-specific network,
identity, secret-path, and production activation values in an untracked
environment file or a separate private deployment repository. The default
services are:

- `finance-bot`
- `document-preparer`
- `actual-reader`
- `actual-server`
- `actual-writer`

Caddy exposes only the Talk webhook to finance-bot:

```text
https://finance.example.test/talk/webhook
  -> finance-bot-host:4380
```

Other paths continue to Actual. Finance-bot has no host-published container
port. Its firewall policy permits internal DNS, Nextcloud through the existing
reverse proxy, and xAI over TCP 443; a final source-specific rule blocks other
routed traffic.

The private Talk room must contain the household users, the application bot,
and the dedicated Nextcloud service identity. Bot installation alone does not
give the WebDAV identity access to Talk attachments.

Production capabilities are enabled with untracked deployment values. The
tracked intake default remains disabled:

```text
INTAKE_MODE=production
ACTUAL_BANK_SYNC_INTERVAL_HOURS=4
TRANSACTION_CATEGORIZATION_MINIMUM_AUTO_APPLY_CONFIDENCE=0.8
ACTUAL_AUTO_APPROVAL_ENABLED=true
```

`INTAKE_MODE=production` enables the complete Talk, context, categorization,
receipt-matching, and signed-update workflow. Auto-approval remains separate
because it changes write authority; it is rejected outside production mode.

The separate writer has a dedicated entry point, credential, network, and
production contract. Its Actual boundary exposes no transaction create/delete
API; existing-transaction updates still require a signed intent, exact observed
state, and readback.

For a new Actual budget, build the project and run
`scripts/provision-actual-production.mjs` in its default `inspect` mode first.
The inspection prints the live account and category names needed to make a
private account plan from `config/account-plan.example.json`; do not commit that
private copy. Apply mode then validates the exact live identities, provisions
the tracked category plan, and writes the reader contract, writer contract, and
model-safe taxonomy to protected absolute paths:

```sh
pnpm build

ACTUAL_PROVISION_MODE=inspect \
ACTUAL_SERVER_URL=https://actual.example.test \
ACTUAL_SERVER_PASSWORD_FILE=/absolute/private/actual-password.txt \
ACTUAL_API_DATA_DIR=/absolute/private/actual-api-data \
node scripts/provision-actual-production.mjs

ACTUAL_PROVISION_MODE=apply \
ACTUAL_APPLY_PROVISIONING=true \
ACTUAL_SERVER_URL=https://actual.example.test \
ACTUAL_SERVER_PASSWORD_FILE=/absolute/private/actual-password.txt \
ACTUAL_API_DATA_DIR=/absolute/private/actual-api-data \
ACTUAL_ACCOUNT_PLAN_FILE=/absolute/private/account-plan.json \
ACTUAL_CATEGORY_PLAN_FILE="$PWD/config/default-household-category-plan.json" \
ACTUAL_PRODUCTION_CONTRACT_OUTPUT_PATH=/absolute/private/actual-production-contract.json \
ACTUAL_READ_CONTRACT_OUTPUT_PATH=/absolute/private/actual-read-contract.json \
ACTUAL_CATEGORY_TAXONOMY_OUTPUT_PATH=/absolute/private/category-taxonomy.json \
node scripts/provision-actual-production.mjs
```

Inspect mode does not mutate Actual. Apply mode stops on ambiguous names or an
unexpected existing production identity instead of guessing.

The reader and writer run as UID/GID `1000:1000`. When the generated
file-backed contracts are installed or rotated for Compose, keep them owned by
`1000:1000` with mode `0400` (or another equally narrow readable mode), then
verify readability as that runtime identity before restarting either service.
`root:root` mode `0400` is deliberately unreadable to these containers and will
make them fail closed at startup.

For a new Nextcloud installation, provision the dedicated service identity and
unattached Talk bot with `scripts/provision-nextcloud-service.sh`, then create
and verify the production room/archive with
`scripts/provision-nextcloud-production-resources.sh`. The production script
does not depend on fake-data or test-room state.

The service provisioner is create-only: it refuses pre-existing scoped
resources and rolls back the user, app token, Talk bot, and every file it
created if any later step fails. Fix the cause and rerun it from the beginning;
there is no partial-state resume mode. On success it prints the non-secret
`FINANCE_BOT_ID` and `TALK_BOT_ACTOR_ID`, and records both in the protected
service resource-ID file. Put `TALK_BOT_ACTOR_ID` in the private deployment
environment. To hand only the numeric bot ID to the one-time production
provisioner, with the other required production variables already set:

```bash
FINANCE_BOT_ID="$(
  sudo sed -nE \
    's/^FINANCE_BOT_ID=([0-9]+)$/\1/p' \
    "$FINANCE_SECRET_DIR/service_resource_ids.env"
)"
FINANCE_CREATE_PRODUCTION_ROOM=true \
  FINANCE_BOT_ID="$FINANCE_BOT_ID" \
  ./scripts/provision-nextcloud-production-resources.sh
unset FINANCE_BOT_ID
```

Both bot IDs are identifiers, not credentials. The Nextcloud app password and
Talk webhook secret remain in their protected files and are never loaded into
the shell by this handoff.

## Secrets

Never commit credentials or private receipt fixtures. Arcane supplies separate
file-backed xAI, Nextcloud, Talk, intent-signing, and Actual secrets only to the
services that need them. Actual OIDC configuration is mounted only into
`actual-server`.

The Actual intent-signing secret is a one-line JSON keyring, not a bare key:

```json
{
  "schemaVersion": "actual-update-signing-keyring.v1",
  "targetReferenceKey": "<stable random key>",
  "keys": { "production-v1": "<active random key>" }
}
```

`ACTUAL_UPDATE_SIGNING_KEY_ID` must name an entry in `keys`. Keep the
`targetReferenceKey` stable across rotations, and retain any signing key while
an intent or receipt-note envelope still uses its key ID.

Do not place secret values in `.env`, logs, chat, shell history, or this
repository.

## License

Household Finance is available under the [MIT License](LICENSE).

## Deferred work

1. Complete and verify backup/restore.
2. Improve household context and category guidance from real attention cases.
3. Move `actual-server` to a non-root runtime identity during a backed-up maintenance window.

## Contributing

Bug reports and focused pull requests are welcome. Before contributing, read
[CONTRIBUTING.md](CONTRIBUTING.md), especially the synthetic-data and security
requirements. Never include real financial records, household identifiers, or
credentials in an issue, test, log, or pull request.
