# Deployment and recovery

The application replaces the previous runtime wholesale. Keep Actual Server, its volume, budget identity, bank connections, categories, rules, schedules, and user-written notes. Do not recreate a budget to activate the assistant.

## Before activation

1. Stage a verified image by complete commit/digest. The publish workflow builds one image and does not advance a moving production tag.
2. Keep the production deployment checkout unchanged while preparing the replacement. Directory-sync GitOps can activate changes immediately.
3. Capture Actual's exported budget and complete API snapshot; back up all application databases, household context, original-file references, deployment, and credentials privately. Restore the budget in a network-isolated rehearsal.
4. Build the conversion manifest with the offline tools in `scripts/`. Run it twice against the restored budget, then reconnect and verify preservation. Every source field remains in canonical evidence. A stale receipt revision is retained with its original reference and marked for review; its bank categorization is unchanged.
5. Import household context and unresolved business work into a fresh application database. Completed message identities prevent replay. Old voice requests are explicitly retired. Set the Talk history cursor at the maintenance boundary. Runtime startup refuses a missing cursor.
6. Verify document isolation, typed model responses with ZDR, memory save/recall/correction/forget, ledger writes/readback, Talk history, original-file permissions, and readable purchase notes.

## Hard cut

Capture the current Talk cursor with the cutover tool’s `cursor` mode before stopping old intake and all old workers. Keep that cursor unchanged through snapshot, conversion, and startup so maintenance messages remain eligible for replay. Pause bank imports and household edits for the consistent snapshot and conversion. Take final backups and run the exact reviewed conversion. Only notes and positively identified old application tokens may change. The converter checks every unrelated field and note, journals each mutation, and stops on unexpected state.

Use a fresh `finance-data` volume populated with the converted work/context database, and mount the private configuration and existing credential files read-only. The application runs as UID 1000 with `/data` writable and a read-only root filesystem. The entrypoint holds an exclusive kernel lock for the entire process lifetime. A second application instance must fail to acquire that lock.

Start only the replacement application with Actual Server unchanged. Keep the existing bot identity and `/talk/webhook` endpoint. Replay messages after the maintenance cursor through authenticated history, deduplicating already-accepted webhooks. Confirm receipts, a purchase-purpose correction, readable transaction notes, both household users' original-file access, and restart recovery.

Remove old service definitions and deployment triggers. Delete retired runtime containers/volumes and obsolete signing credentials only after backups are verified and replacement recovery succeeds. Retained offline backups are recovery artifacts, not runtime dependencies. Never mount predecessor stores or conversion tools into the installed application.

## Recovery

The default is to repair the replacement while Actual remains usable manually. Stop the worker before recovery. Preserve its SQLite database, WAL, Actual cache, and uncertain operation journal. A confirmed desired state completes an operation; unchanged expected state permits a bounded retry; any other state needs reconciliation. A failed notification never reruns a financial edit.

Never restore an old Actual snapshot over newer household transactions. Before activation, a failed conversion can resume its reviewed manifest or restore the exact predecessor while intake remains paused. After new work has arrived, reconcile the journal and current ledger before any restore.

Back up the application database with SQLite's online backup API, and restore-test it alongside Actual exports and authenticated original-file references. Memory cannot be reconstructed completely from Actual. Suppression markers must survive restoration and index rebuilds.

## Acceptance and observation

Health endpoints expose only aggregate work status. Check the image revision, one-writer lock, document namespace, authenticated Talk delivery, notes, preserved account/transaction/category/rule identities, and restart recovery. Keep model cost/latency and completed-work counters for comparison against the predecessor.

The normal bank import remains manual/weekly. A subsequent real import must match a waiting receipt without new extraction or operator repair. Measure at least 50% lower model cost on a comparable workload, including memory work; do not substitute synthetic orchestration checks for extraction quality or claim savings from fewer containers alone.

## Document sandbox policy

`config/document-seccomp.json` derives from the Moby default allowlist
(https://github.com/moby/profiles/blob/3c28324314729dbade8287e868eef6338c42807a/seccomp/default.json), with explicit
allowances for `clone`, `unshare`, `mount`, `umount2`, `pivot_root`, and
`sethostname` needed by the nested Bubblewrap sandbox. The outer container stays
unprivileged, drops every capability, and retains no-new-privileges and a
read-only root. The parser receives no application data, secrets, process tree,
or network. Run `scripts/verify-container.sh IMAGE` on the deployment engine;
Docker's default policy blocks the required nested namespace creation.
