# Contributing

Thanks for helping improve Household Finance. This project is a self-hosted
reference implementation whose safety depends on narrow, deterministic money
boundaries. Contributions should preserve those boundaries and remain useful to
people with installations different from the original deployment.

## Where to start

- Bug fixes and focused documentation or test improvements may go directly to
  a pull request.
- New features and substantial changes should start with a GitHub Discussion so
  the approach and scope can be agreed on before implementation.

## Before opening an issue or pull request

- Use only clearly synthetic people, merchants, accounts, receipts, and
  transactions. Do not include real household names, financial documents,
  account identifiers, card digits, provider payloads, private fixture paths,
  database contents, or credentials.
- Redact logs and screenshots before sharing them. If you find a credential or
  private-data exposure, do not open a public issue; use GitHub's private
  vulnerability-reporting channel instead.
- Keep changes focused. Explain the user-visible problem, the safety impact, and
  how the change was verified.

## Development setup

Use Node.js 24, Corepack, and the pnpm version declared in `package.json`.

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm verify
docker build -t household-finance-bot:local .
```

`pnpm verify` checks formatting, lint, types, tests, the production build, and
the rendered Compose security contract. Add focused tests for behavior changes
and run the complete verification suite before submitting a pull request.

## Safety invariants

Changes must preserve these properties:

- money is represented as integer minor units;
- the model remains an unprivileged parser and reasoning component;
- only narrow, typed, signed, and validated intents may reach a writer;
- imported transaction identity and observed state are verified before writes;
- split amounts balance exactly and category/account scopes are allowlisted;
- idempotency, transactional outbox behavior, and uncertain-outcome recovery
  remain intact;
- original documents remain immutable and extraction provenance is retained;
- configuration and external integrations fail closed when required controls
  are absent or inconsistent; and
- no Docker socket, home directory, Notes vault, or Nextcloud data directory is
  mounted into the service.

Do not weaken an activation gate merely to make a test or local deployment
easier. New external calls or write capabilities should be isolated, bounded,
and covered by negative tests.

## Pull requests

Include:

1. a concise description of the problem and approach;
2. any changes to trust boundaries, data retention, or deployment behavior;
3. tests that demonstrate the intended behavior and important rejection paths;
4. the verification commands you ran; and
5. documentation or example-configuration updates when behavior changes.

By contributing, you agree that your contribution will be licensed under the
license published with this repository.
