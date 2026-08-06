# Architecture

Household Finance connects a conversational interface to Actual Budget without
giving the model direct authority over the ledger.

## Main flow

```text
Nextcloud Talk
  ├─ message or voice note ───────────────┐
  └─ receipt image or PDF                 │
           │                              │
           v                              │
  document-preparer                      │
           │                              │
           v                              v
       finance-bot ── structured model reasoning
           │
           ├─ bounded reads ──> actual-reader ──> Actual Budget
           └─ signed intent ──> actual-writer ──> Actual Budget

SimpleFIN ──> Actual Budget bank imports
```

The model handles interpretation: reading receipts, understanding merchants and
items, choosing categories, answering questions, and proposing splits. The
application remains responsible for identity, permissions, exact amounts,
idempotency, and ledger writes.

## Receipt lifecycle

1. A signed Talk callback identifies the room, sender, message, and attachment.
2. The attachment is archived in Nextcloud and prepared in a separate service
   with no credentials or persistent storage.
3. The model extracts the merchant, date, total, line items, and provenance.
4. Canonical receipt facts are published to an Actual note.
5. The matcher looks for an exact imported charge, or a unique same-account set
   of charges with the same total.
6. If the bank import has not arrived, the receipt remains pending and is tried
   again after a later sync.

Corrected images can replace an uncommitted match. Once a ledger write has
started, a conflicting receipt revision is held for review instead of silently
rewriting the transaction.

## Ledger changes

The conversational agent can propose a category or balanced split for an
existing imported transaction. It cannot create arbitrary transactions or call
Actual directly.

Before a write, deterministic code verifies that:

- the transaction is an allowlisted import and still has the observed state;
- the account and categories are in the deployment contract;
- every amount is represented in integer minor units;
- a split balances exactly to the transaction total; and
- the operation has not already been applied.

The proposal becomes a narrowly typed, signed intent. Only `actual-writer` has
the write credential; it applies the intent, reads the transaction back, and
records the outcome.

## Data ownership

- Nextcloud Files holds immutable source documents.
- Actual receipt notes hold canonical receipt facts and provenance.
- Actual transaction notes hold receipt-link tokens.
- Actual transactions remain the financial ledger.
- Local SQLite databases hold queues, audit records, and rebuildable
  projections—not a second copy of the ledger.

## Service boundaries

- `finance-bot` handles Talk workflows and model reasoning but has no Actual
  password.
- `document-preparer` parses images and PDFs without secrets, persistent
  storage, or external network access.
- `actual-reader` exposes only bounded, model-safe read operations.
- `actual-writer` is isolated on an internal network with a dedicated
  credential and production contract.
- Model requests use structured outputs and request zero data retention.

The tracked Compose configuration also enforces read-only filesystems, dropped
capabilities, resource limits, service-specific secrets, and separate networks.
Run `pnpm verify:compose` to check that contract.
