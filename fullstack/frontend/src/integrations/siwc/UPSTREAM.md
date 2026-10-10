# Vendored page-command transport

This directory contains the host-side page SDK from the user-supplied
`siwc-bridge-source-0.1.1(1).zip`, package `sign-in-with-chatgpt-bridge` version
`0.1.1`. The archive SHA-256 is:

`43bdff68197549d5da6f3f381f94ddc9fb8320f2a25006999829ff11c21cbee0`

The source archive root is `siwc-bridge/`. Its `package.json` declares
`GPL-3.0-or-later`, and the JavaScript source carries that SPDX identifier. The
complete supplied GPL license is preserved in `LICENSE`. No upstream repository
or release URL was supplied or inferred.

## Imported files and original SHA-256

| Source path within the archive root | Original SHA-256 | Local status |
| --- | --- | --- |
| `sdk/page-bridge.js` | `161abb1a584073e67f947700a4978bb1efbcee379bdc077706c19f25829e43f8` | Amended below |
| `sdk/page-bridge.d.ts` | `8bcdc8f88a847deea747603fa66928ad618f73161aa7e99e2de126a42a3589ac` | Amended below |
| `extension/core/common.js` | `922f5e412b2512c03adf4c5db29bec19fc389f9589ac5af3fc0a8a4061132c7d` | Unmodified |
| `extension/core/schema.js` | `38cb79c1d4bf836ba66723f8bff9f5e7b07dc6829b9a42372d1df5aa45442420` | Updated to supplied 0.1.3 below |
| `LICENSE` | `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986` | Unmodified |

The original relative layout is retained so the SDK imports its pure helper
modules. The `extension/core` directory name does not imply an installed or
bundled browser extension. No background/content script, OAuth, token handling,
inference client, installer, or prototype DAVIS PCA adapter is included.

## Local amendments, 2026-10-10

`sdk/page-bridge.js` is reformatted and amended as follows:

- Disposal is permanent and idempotent. New calls and work completing an awaited
  revision, schema, snapshot context/workflow, envelope fingerprint, or authorization are
  gated. Queued execution and delayed Web Lock callbacks cannot start after
  disposal. Running signals and deadline timers are stopped and caches cleared.
- Snapshots finish their context/workflow reads and schema digest before the final revision comparison.
  Snapshot capacity is checked after awaits so concurrent captures cannot exceed
  the original 128-entry bound. A failed bounded serialization is never cached.
- Envelope validation explicitly requires an object and a bounded string
  revision. The original seven envelope fields, ID rules, five-minute expiry
  limit, schema/revision binding and single-use snapshots are retained. The
  original 1 MiB/50,000-node/32-depth JSON bounds, schema interpreter, 12-command
  limit, 1,024-entry execution and cancellation caches, and fail-closed replay
  rules remain in force.
- Each internal handler receives `expectedRevision`. DAVIS must compare it with
  its synchronous generation immediately before any mutation, and must check
  that generation and the abort signal immediately before publishing an awaited
  result. This field is not a new wire field and does not change `page-commands/1`.
- Synchronous handlers remain synchronous through successor-revision capture;
  unrelated microtasks cannot be adopted as part of their own committed state.
  Promise-returning handlers retain their asynchronous behavior and the host's
  source-generation checks remain necessary before publishing their results.
- A handler that resolves has one completed receipt. Cancellation, expiration,
  or disposal observed after that receipt stops later operations and reports a
  plan-level interruption; it cannot append a second failed receipt for the
  same operation. Revision-reporting failure cannot erase earlier receipts.
  Handlers must report a committed effect by returning bounded output, without
  throwing solely because cancellation arrived after their commit. A failed
  receipt never promises that the application rolled back a mutation.
- Both metadata names reject duplicate elements. Cleanup restores borrowed
  metadata or removes created metadata, removes listeners, and suppresses
  pending replies. `pagehide` uses the same complete cleanup. The application
  owns fresh registration on `pageshow` after runtime/UI readiness; disposed
  instances never revive. StrictMode/HMR teardown must call the returned cleanup.

`sdk/page-bridge.d.ts` adds the internal `expectedRevision` field, optional
`getWorkflow` and `workflowRole`, documents the already-supported injectable
`clock`, and carries an SPDX/provenance notice.
`extension/core/common.d.ts` is a local declaration-only companion for strict
TypeScript consumers of the unchanged helpers. The maintained
`tests/pageCommandBridge.test.ts` exercises the actual vendored SDK and transport.

## Coordinated 0.1.3 workflow migration, 2026-10-10

The user subsequently supplied `sign-in-with-chatgpt-bridge` version `0.1.3`.
The attachment's `package.json` declares `GPL-3.0-or-later`; both imported
JavaScript files retain that SPDX notice. Its supplied `LICENSE` has the same
SHA-256 as the existing unmodified license above. No upstream repository or
release URL was supplied or inferred.

| Source path within the 0.1.3 archive root | Original SHA-256 | Local status |
| --- | --- | --- |
| `extension/core/workflow.js` | `2661eee1be2341bbb20adb36dc5d2e6cf11f6540c4499e62672ce732d6c23aeb` | Unmodified |
| `extension/core/schema.js` | `c5d466adb86f1f2844c9b5c31778afd69f260c31d55c7baafba7ef1eab90334a` | Unmodified; replaces the 0.1.1 helper |

The schema delta only validates/preserves optional `workflowRole` in command
normalization, so roles participate in the schema digest. The imported workflow
helper defines the application-independent `page-workflow/1` contract, bounded
forms, role discovery and lifecycle preconditions. Its imports are satisfied by
the original 0.1.1 `common.js`; unused 0.1.3 common/runtime changes are not copied.
`extension/core/workflow.d.ts` is a local declaration-only companion.

The hardened SDK remains the locally amended 0.1.1 implementation above. It
emits `contractRevision: 2` and a top-level `workflow` (null when absent), from an
optional application `getWorkflow`. Every workflow read is bounded and validated;
snapshot reads finish before the final revision comparison. Declared lifecycle
commands must be standalone plans, checked before any authorization or handler.
Immediately before a lifecycle handler, the SDK reads the current workflow and
rechecks revision, cancellation, expiry and disposal after that asynchronous read.
Draft/status checks dispatch by declared role, never by a DAVIS name or method.
Commands without roles retain their ordinary opaque results, even if those results
contain a field named `workflow`. One committed effect still receives one completed
receipt, and exact-envelope replay retains the existing receipt cache behavior.

DAVIS supplies roles on its existing analysis commands and publishes the generic
workflow through `getWorkflow`. The previous `context.pendingAnalysis` alias is
removed; `context.analysis` remains DAVIS-owned capability metadata. This is a
coordinated contract migration for the revised 0.1.3 extension. The maintained
`pageWorkflowContract.test.ts` and existing transport, adapter, workflow and host
tests cover it; runtime/parser validation and hosted acceptance remain separate
gates. The supplied extension itself is externally maintained and is not installed,
authenticated, or executed by this migration.

## Protocol and trust boundary

Discovery remains `meta[name="siwc-bridge"]` with content `page-commands/1`, plus
`meta[name="siwc-bridge-app"]` with the application ID. Messages remain on
`siwc-page-commands/1`, with `to-page` requests and `to-extension` replies, on a
top-level HTTPS page. Both `event.source === window` and exact origin equality
are required. This does **not** authenticate a browser extension: JavaScript
already executing in the page is in the same trust boundary. The host exposes
only its closed, bounded commands and retains its own permissions and validation.

The supplied extension binds requests to the document pathname. DAVIS's static
hash router can keep that binding intact while navigating between analyses. A
browser-history router that changes the pathname can invalidate the extension's
binding; the host does not relax the check. Supporting that case belongs in a
separately reviewed extension change.
