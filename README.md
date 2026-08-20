# Household Finance

[![Publish container images](https://github.com/deftmartian/household-finance/actions/workflows/publish-images.yml/badge.svg)](https://github.com/deftmartian/household-finance/actions/workflows/publish-images.yml)

Household Finance turns a private chat room into an interface for everyday
bookkeeping. Send it a receipt, ask where the money went, or tell it how a
transaction should be categorized. It does the work in the background and
keeps [Actual Budget](https://actualbudget.org/) as the ledger of record.

I built it after years of using tools like YNAB. The budgeting software was
useful, but keeping it current still meant sorting transactions, saving
receipts, and remembering the context behind purchases. I did not want another
finance dashboard. I wanted to use the chat interface already on my phone.

## What using it looks like

```text
You: [send two photos of a grocery receipt]

Household Finance: I found an $84.32 purchase from Example Market and matched
it to the card transaction from yesterday. Most of it looks like groceries,
with $12.49 in household supplies. Want me to split it that way?

You: Yes, and remember that Example Market is usually groceries.

Household Finance: Done. I split the transaction and saved the merchant rule.
```

The same conversation can answer questions about recent spending, correct a
category, split a mixed purchase, discard a bad receipt, or update household
context. Voice notes go through the same workflow as typed messages.

## What it does

- Reads JPEG, PNG, and PDF receipts sent through chat.
- Combines multi-photo receipts and detects duplicate uploads.
- Matches receipts to imported bank transactions, including purchases split
  across more than one charge.
- Categorizes transactions with or without a receipt.
- Creates balanced category splits for mixed purchases.
- Answers plain-language questions using live Actual Budget data.
- Accepts conversational corrections and recurring merchant rules.
- Keeps household context that can be updated from the same chat room.
- Archives original documents and records receipt details in Actual notes.

Receipts can arrive before their bank transaction. Household Finance keeps them
pending and matches them after a later [SimpleFIN](https://www.simplefin.org/)
sync rather than inventing a transaction that has not appeared yet.

## Current stack

The first deployment uses:

| Role                                   | Integration                                            |
| -------------------------------------- | ------------------------------------------------------ |
| Conversation and receipt intake        | Nextcloud Talk                                         |
| Ledger                                 | [Actual Budget](https://actualbudget.org/)             |
| Bank imports                           | [SimpleFIN](https://www.simplefin.org/) through Actual |
| Receipt understanding and conversation | xAI's Grok API                                         |
| Runtime                                | Node.js, TypeScript, SQLite, and Docker Compose        |

Nextcloud Talk and Grok are the integrations implemented today. The chat and
model boundaries are separate from the finance workflows, so other messengers
and model providers can be added without replacing the ledger or receipt
pipeline.

## How it works

```text
Nextcloud Talk ──> Household Finance ──> Actual Budget
       │                  │                    ▲
       │                  ├─> document parser  │
       │                  └─> Grok             │
       │                                       │
       └──────── receipts and questions        │
                                               │
SimpleFIN ───────── imported transactions ─────┘
```

The model reads receipts, understands questions, and proposes categories or
splits. Application code owns the ledger boundary: it checks the transaction,
amounts, categories, and prior state before an isolated writer can update
Actual. The model never receives ledger credentials or a general-purpose
database connection.

See [Architecture](docs/architecture.md) for the receipt lifecycle, service
boundaries, and write path.

## Getting started

The project uses Node.js 24 and pnpm 10.32.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

For local development, start the service and check its readiness endpoint:

```sh
pnpm dev
curl --fail http://127.0.0.1:4380/health/ready
```

Production mode also exposes `/health/status` and Prometheus `/metrics` with
fixed, aggregate operational state only: configured model/reasoning/revision,
bank-sync freshness and account counts, queue age/counts, worker failures, and
model latency/cost/failure counters. These endpoints never include account
identities, amounts, prompts, receipts, or model payloads. The default model is
the exact `grok-4.6` identifier with high reasoning effort.

The repository includes a generic Compose setup for `finance-bot`,
`document-preparer`, `actual-reader`, `actual-writer`, and `actual-server`.
Configuration examples live in `.env.example`, and provisioning scripts cover
the Actual and Nextcloud setup.

See [Deployment](docs/deployment.md) for the complete setup and production
configuration.

## Container images

A successful `main` workflow publishes Linux AMD64 images for the four
application services to GitHub Container Registry:

| Compose service     | Published package                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `finance-bot`       | [`household-finance-bot`](https://github.com/deftmartian/household-finance/pkgs/container/household-finance-bot)                             |
| `document-preparer` | [`household-finance-document-preparer`](https://github.com/deftmartian/household-finance/pkgs/container/household-finance-document-preparer) |
| `actual-reader`     | [`household-finance-actual-reader`](https://github.com/deftmartian/household-finance/pkgs/container/household-finance-actual-reader)         |
| `actual-writer`     | [`household-finance-actual-writer`](https://github.com/deftmartian/household-finance/pkgs/container/household-finance-actual-writer)         |

GitHub displays registry artifacts as packages. They are container _images_;
running containers appear in Docker or Arcane only after a Compose deployment
creates them. The fifth Compose service, `actual-server`, uses the upstream
`actualbudget/actual-server` image and is not published by this repository.

Each application image keeps a traceable full-commit tag and an immutable
top-level digest. After all four matrix builds succeed, the workflow verifies
that the complete commit-tagged set exists and promotes those exact four image
digests to `latest`.

The recommended rolling private-stack mode uses all four `latest` references
with `pull_policy: always`, as shown in `.env.example`. Wait for the whole
[publishing run](https://github.com/deftmartian/household-finance/actions/workflows/publish-images.yml)
to pass before a manual deployment. When Arcane auto-update is enabled, the
four application services are eligible to follow `latest` on Arcane's schedule;
they do not require an atomic, same-revision restart.

Actual Server and the embedded `@actual-app/api` dependency are pinned to the
same release. A weekly Dependabot group checks both references and opens one
reviewed pull request when Actual publishes a newer version. Actual Server
remains opted out of Arcane image updates, so its version changes only through
that Git change.

For a manual deployment:

```sh
docker compose --env-file .env pull \
  finance-bot document-preparer actual-reader actual-writer
docker compose --env-file .env up -d --no-build
```

For an immutable deployment or rollback, use all four workflow-reported
top-level digests from one run as `full-commit@sha256:digest`. See
[Deployment](docs/deployment.md#use-rolling-published-images) for the rolling,
local-build, and pinned modes.

## Extending it

A new chat integration needs to translate messages, attachments, replies, and
authenticated sender identity into the existing workflows. A new model
integration needs to provide the structured receipt and conversation contracts.
The finance rules, matching, storage, and Actual write boundary can stay the
same.

Bug fixes are welcome as pull requests. Please start a Discussion before larger
features or new integrations so the shape of the change can be worked out
together. See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidance.

## Release

Version 0.0.1 is the initial public release. It covers the receipt,
categorization, conversational query, household context, and transaction-editing
workflows used by the original household deployment.

## License

Household Finance is available under the [MIT License](LICENSE).
