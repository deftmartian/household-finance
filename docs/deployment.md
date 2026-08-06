# Deployment

This guide covers the generic Compose deployment included with Household
Finance. Keep site-specific identities, network details, contracts, and secret
paths in an untracked environment file or a separate private deployment
repository.

## Requirements

- Node.js 24
- Corepack and pnpm 10.32
- Docker Compose or a compatible container engine
- Poppler for local PDF processing
- Nextcloud with Talk and Files
- Actual Budget
- xAI API access

## Verify the checkout

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify
pnpm audit --prod
```

`pnpm verify` runs formatting, lint, type checks, tests, the production build,
and the rendered Compose security contract.

For local development, the service starts with its write-capable production
workflow disabled:

```sh
pnpm dev
curl --fail http://127.0.0.1:4380/health/ready
```

## Compose services

The generic `compose.yaml` defines:

- `finance-bot`
- `document-preparer`
- `actual-reader`
- `actual-server`
- `actual-writer`

Copy `.env.example` to an untracked `.env`, adapt the non-secret values, and
create each file-backed secret referenced by the Compose configuration. Render
the final model before building or starting it:

```sh
docker compose --env-file .env config --quiet
docker compose --env-file .env build
```

The reader and writer run as UID/GID `1000:1000`. Their generated contracts
must be readable by that identity; mode `0400` with matching ownership is the
usual production setting.

## Actual Budget provisioning

Build the project and inspect the target budget before applying any changes:

```sh
pnpm build

ACTUAL_PROVISION_MODE=inspect \
ACTUAL_SERVER_URL=https://actual.example.test \
ACTUAL_SERVER_PASSWORD_FILE=/absolute/private/actual-password.txt \
ACTUAL_API_DATA_DIR=/absolute/private/actual-api-data \
node scripts/provision-actual-production.mjs
```

Use the reported account and category names to create a private account plan
from `config/account-plan.example.json`. Apply mode provisions the tracked
category plan and writes the reader contract, writer contract, and model-safe
taxonomy:

```sh
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

Inspect mode is read-only. Apply mode validates exact live identities before it
writes anything.

## Nextcloud provisioning

Create the dedicated service identity and unattached Talk bot:

```sh
./scripts/provision-nextcloud-service.sh
```

Then create and verify the production Talk room and receipt archive:

```sh
./scripts/provision-nextcloud-production-resources.sh
```

The private room must contain the household members, application bot, and
dedicated Nextcloud service identity. The bot installation alone does not give
the WebDAV identity access to Talk attachments.

## Production activation

The tracked configuration defaults to disabled intake. A production deployment
typically sets:

```text
INTAKE_MODE=production
ACTUAL_BANK_SYNC_INTERVAL_HOURS=4
TRANSACTION_CATEGORIZATION_MINIMUM_AUTO_APPLY_CONFIDENCE=0.8
ACTUAL_AUTO_APPROVAL_ENABLED=true
```

Auto-approval is a separate switch because it grants write authority. Review
the rendered Compose model and the generated Actual contracts before enabling
it.

## Secrets

Credentials remain in file-backed secrets and are mounted only into the
services that use them. The Actual intent-signing secret is a JSON keyring:

```json
{
  "schemaVersion": "actual-update-signing-keyring.v1",
  "targetReferenceKey": "<stable random key>",
  "keys": { "production-v1": "<active random key>" }
}
```

`ACTUAL_UPDATE_SIGNING_KEY_ID` names the active entry in `keys`. Keep the
target-reference key stable across rotations, and retain old signing keys while
queued intents still reference them.

Do not store secret values in `.env`, logs, shell history, or the repository.
