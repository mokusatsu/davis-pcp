# WASM computation results and persistence

The static worker keeps API outcomes separate from IndexedDB durability. A successful Python operation remains successful, including binary exports, even if an outbound `syncfs(false)` fails. Original API errors also remain unchanged. Independent `PERSISTENCE` events and response receipts report `mode`, `pending`, and `error`; they never use fatal runtime `STATUS:error`.

Only exact `POST /summaries` and `POST /statistics/covariance` defer the pre-response flush. They are not classified as read-only: legacy metadata can be lazily migrated. All dispatches conservatively mark pending work, including reads and potentially partially applied failures. Other POST/PUT/PATCH/DELETE operations still attempt a flush. Only a successful outbound flush clears pending/error state.

## Recovery

- A runtime flush failure leaves the worker and its in-memory files usable. The visible warning remains across reads and deferred computations.
- **保存のみ再試行** performs one queued outbound flush. It never reruns a create/update/analysis operation. Failed retries remain visible; there is no automatic retry loop.
- A session response retains its applied ID, revision and version token even when persistence fails. The UI does not claim it was saved, blocks another save/copy while that receipt is pending, and flushes only the already-applied files on retry. A later successful operation's flush can also complete this receipt. Subsequent unsaved screen edits are not part of that original session snapshot.
- If the initial IndexedDB mount/populate fails (including asynchronous callback errors), the runtime remains in **temporary mode**. Previously stored data might be incomplete or absent in that tab. Outbound flushes are disabled for the lifetime of that worker so an incomplete tree cannot overwrite unseen stored files. Explicit session save is rejected before mutation. There is no automatic repopulate, remount, worker reset, reload, or database deletion.
- In temporary mode, keep the tab open and export the data you need before investigating browser storage. Dataset exports are not a complete backup of analysis results or unsaved screen state. This change deliberately offers no in-place resynchronization after an incomplete initial load.

## Limitations

This does **not** solve stale-snapshot overwrites across tabs. There is no single-writer/Web Locks protocol or cross-tab reconciliation here. A successful flush reports completion of the browser write, not protection against later writes by another tab, eviction, or external deletion.

## Verification

`npx tsc --noEmit` and `npx vitest run` from `fullstack/frontend` validate the source without a production build. Worker fault-injection tests execute the actual worker/queue modules with modeled Python/runtime/FS callbacks; they are not a real-browser IndexedDB corruption test. Client and UI tests cover independent warning state, receipt identity, flush-only retry, and startup preflight.
