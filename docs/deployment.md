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
the final model before building or starting it.

### Build this checkout

The example defaults to building the four Household Finance application images
from the current checkout:

```sh
docker compose --env-file .env config --quiet
docker compose --env-file .env build
```

`HOUSEHOLD_FINANCE_IMAGE_PULL_POLICY=build` and the four local image names in
`.env.example` make this source-build behavior explicit.

### Use published images

Every overall-green
[publishing workflow](https://github.com/deftmartian/household-finance/actions/workflows/publish-images.yml)
produces four public Linux AMD64 images under one full 40-character commit tag.
Select one successful run and set all four image references from that same
commit:

```dotenv
HOUSEHOLD_FINANCE_IMAGE_PULL_POLICY=missing
FINANCE_BOT_IMAGE=ghcr.io/deftmartian/household-finance-bot:<full-commit>@sha256:<digest>
DOCUMENT_PREPARER_IMAGE=ghcr.io/deftmartian/household-finance-document-preparer:<full-commit>@sha256:<digest>
ACTUAL_READER_IMAGE=ghcr.io/deftmartian/household-finance-actual-reader:<full-commit>@sha256:<digest>
ACTUAL_WRITER_IMAGE=ghcr.io/deftmartian/household-finance-actual-writer:<full-commit>@sha256:<digest>
```

The package pages are linked from the README, and each publish job records its
top-level digest in the workflow summary. The additional `unknown/unknown`
entries visible on a package page are provenance and SBOM attestations, not
runnable platforms.

Render and inspect the exact image set before pulling or starting it:

```sh
docker compose --env-file .env config --quiet
docker compose --env-file .env config --images
docker compose --env-file .env pull \
  finance-bot document-preparer actual-reader actual-writer
docker compose --env-file .env up -d --no-build
docker compose --env-file .env ps
docker compose --env-file .env images
```

Do not mix commits, use a child-platform or attestation digest in place of the
workflow-reported top-level digest, or switch the pull policy while any local
image name remains. `actual-server` continues to use its separately pinned
upstream image.

Publishing creates registry artifacts; it does not deploy them. A production
deployment should keep site-specific configuration in a private deployment
repository, update all four digest pins in one reviewed change, and let its
deployment system activate that change only after the rendered model and pulls
succeed. Reverting that deployment change selects the prior image set for
rollback.

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
