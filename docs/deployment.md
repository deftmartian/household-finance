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

In production, keep `/health/ready` as the process/intake readiness contract.
Use `/health/status` for a privacy-safe aggregate diagnosis and `/metrics` for
Prometheus. The isolated writer separately serves localhost readiness on port
4360; Compose uses that completed-cycle signal for container health.

The default model configuration requests the exact `grok-4.6` identifier with
high reasoning effort. The status and metrics build series report the
configured model, reasoning effort, and image source revision so deployment
verification can compare the running artifact with its approved contract.

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

### Use rolling published images

This is the recommended mode for a private stack that follows the public
repository. `.env.example` defaults all four application services to their
GHCR `latest` tags and sets `HOUSEHOLD_FINANCE_IMAGE_PULL_POLICY=always`.

Every successful `main`
[publishing workflow](https://github.com/deftmartian/household-finance/actions/workflows/publish-images.yml)
first publishes four Linux AMD64 images under the full 40-character commit.
Only after all matrix jobs succeed does a final job resolve every commit tag
and promote those exact four digests to `latest`.

GHCR moves the four package tags during one final promotion job. Confirm that
job is green before a manual deployment. The application services use stable
interfaces and do not require an atomic, same-revision restart, so an Arcane
installation with auto-update enabled may update each eligible service on its
normal schedule.

Actual-read protocol v2 explicitly negotiates partial bank-sync freshness.
During a rolling release, an older client receives a conservative v1-compatible
failed outcome without the new aggregate summary; a v2 client receives the
partial outcome and privacy-safe attempted/succeeded/failed account counts.
The reader also maintains a v1 freshness-state mirror so its persisted state
can be rolled back independently.

To deploy manually:

```sh
docker compose --env-file .env config --quiet
docker compose --env-file .env config --images
docker compose --env-file .env pull \
  finance-bot document-preparer actual-reader actual-writer
docker compose --env-file .env up -d --no-build
docker compose --env-file .env ps
docker compose --env-file .env images
```

If promotion fails after moving only some tags, rerun the failed promotion job.
Its digest-pinned sources make the operation idempotent, and the final all-four
check confirms that every rolling tag converged.

`pull_policy: always` refreshes a rolling tag when Compose creates or recreates
a service; it does not schedule a deployment by itself. Arcane auto-update is
the scheduler when enabled globally. The four application services deliberately
omit Arcane's updater opt-out and follow `latest`.

`@actual-app/api` is an embedded application dependency rather than a separate
container. It and `actual-server` stay pinned to the same release. A weekly
Dependabot multi-ecosystem group opens one public pull request that updates the
npm lockfile and Compose example together. The separately deployed server stays
opted out of Arcane updates until its reviewed deployment change is merged.

### Build this checkout locally

The Compose file retains build targets for all four application services. To
build the current checkout instead of using GHCR, set these overrides in the
untracked `.env`:

```dotenv
HOUSEHOLD_FINANCE_IMAGE_PULL_POLICY=build
FINANCE_BOT_IMAGE=household-finance-bot:local
DOCUMENT_PREPARER_IMAGE=household-finance-document-preparer:local
ACTUAL_READER_IMAGE=household-finance-actual-reader:local
ACTUAL_WRITER_IMAGE=household-finance-actual-writer:local
```

Then render and build it:

```sh
docker compose --env-file .env config --quiet
docker compose --env-file .env build
```

### Pin an immutable image set

For a reviewed production promotion or rollback, select one overall-green
workflow and use all four top-level digests from that same commit:

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
runnable platforms. Render and inspect the pinned set before activating it:

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
image name remains. `actual-server` uses its separately reviewed version pin.

Publishing creates registry artifacts; it does not deploy them. Keep
site-specific configuration in a private deployment repository. That repository
can follow the rolling tags with its platform's updater, redeploy manually, or
update digest pins in a reviewed change. Reverting a pin change selects the
prior image set for rollback.

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
