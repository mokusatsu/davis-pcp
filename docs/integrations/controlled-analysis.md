# DAVIS-PCP controlled analysis interface

DAVIS exposes the `page-commands/1` host protocol from the supplied siwc-bridge 0.1.1 integration. It is registered after the application is ready, in an HTTPS top-level page. The deployed static application uses hash routes, so navigating to `#/models/ca` does not change the document pathname.

The complete executable analysis workflow in this version is correspondence analysis (CA). Other analysis pages remain available through navigation. The prototype `analysis.pca` from the supplied example is deliberately not advertised: opening a page or returning separate JSON is not a completed normal-page analysis.

## Discovery and transport

The host publishes `meta[name="siwc-bridge"]` with content `page-commands/1`, and `meta[name="siwc-bridge-app"]` with content `davis-pcp`. Messages use channel `siwc-page-commands/1`, direction `to-page`, a bounded request `id`, and method `snapshot`, `execute`, or `cancel`. Replies use direction `to-extension` and the matching `id`.

The snapshot is the authority for the current command list, input schemas, schema hash, revision, snapshot ID, and expiry. Preserve the supplied protocol's exact execute envelope and single-use snapshot/replay rules; do not construct an old envelope from cached context. A state change, including A→B→A, changes the opaque host revision. The adapter checks that revision synchronously before mutations. Commands are serialized, and a repeated identical plan ID executes once. Reusing an ID with different content is rejected.

Same-window and same-origin checks isolate other frames and origins. They **do not authenticate an extension** against other JavaScript already executing in the same page. This interface accepts a closed set of application commands; it does not accept arbitrary JavaScript, API paths, uploads, credentials, OAuth grants, or inference requests.

The eight foundation commands are `state.inspect`, `view.navigate`, `variables.select`, `variables.setTarget`, `selection.clear`, `selection.focus`, `selection.reset`, and `pcp.configure`. Variable arguments use stable `columnId` values. MA groups and their option columns are not implicitly expanded. `variables.setTarget` translates to the existing application's raw-name target representation. `selection.focus` changes active rows but preserves the selected scope mode; inspect `effectiveRowCount`, rather than assuming that All or Sampled became Active. `selection.reset` explicitly restores Active/all rows and clears selection/sampling through the ordinary reducer.

Snapshots contain bounded column descriptors, counts, current settings, and workflow state. They contain no raw data values, row IDs, sample multiplicities, individual coordinates, or model scores. Catalog truncation is explicitly marked. Arbitrary names such as `__proto__` remain string values in descriptor arrays, never dictionary keys.

## Prepare, answer, run

The workflow contract is `davis-analysis/1`. The outer execute receipt still uses `completed`, `partial`, or `failed`. An individual command's result can have inner status `needs_input`, `ready`, `completed`, `invalidated`, or `cancelled`.

1. `analysis.prepare` accepts `{method:"correspondence", answers:[]}`. It opens the normal CA page without calculating. Existing page defaults and current source scope are disclosed in the preview. An untouched page defaults to respondent rows; missing targets produce questions. It never chooses the first pair of variables. A request involving three or more categorical variables must resolve the intended CA pair; MCA/FAMD are not advertised executable methods here.
2. `analysis.resume` accepts `{requestId,draftRevision,answers:[{questionId,value}]}`. Obtain the binding from a fresh snapshot/result. Resume accepts only the questions and choices currently issued by the host. Unknown, duplicate, stale, inapplicable, or page-only answers are rejected before configuration changes.
3. `analysis.run` accepts `{requestId,draftRevision}` and requires a ready draft. It executes the same controller as the ordinary CA Run button. Completion means the normal result state has committed: the chart, tables, exports, and category-selection controls use that result. Repeating a completed request/version returns its existing result reference, without a second fit.
4. `analysis.cancel` abandons the pending draft. During a running execute call, use transport `cancel(runId)` first; after it settles, obtain a fresh snapshot and cancel the application draft if desired. Cancel suppresses publication and later commands. It cannot undo a result already committed, and the current numerical engine may finish computing in the background.

The pending object is available at `snapshot.context.pendingAnalysis`, or `null` when absent. `context.analysis` describes the supported workflow version and methods. A draft includes `requestId`, integer `draftRevision`, `expiresAt`, `questions`, and `preview`. The preview exposes row/column target IDs explicitly as well as descriptor arrays; ready results include `run:{command:"analysis.run"}`, and needs-input results include the resume hint. Its lifetime is 15 minutes. It is not saved as a dataset/session or restored after document reload.

Questions use `{id,type,prompt,required}` plus applicable choice/cardinality or page-action fields. Single/multi questions include `options:[{value,label}]`; multi bounds never exceed the actual choices. Confirmations omit options and cardinality. Insufficient choices become a page-action confirmation. The entire workflow is bounded to128 KiB, matching the supplied0.1.2 form contract. Use stable option values, not translated labels. Question options are capped, stable option IDs must be at most200 characters and cannot be the reserved IDs `__proto__`, `constructor`, or `prototype`, and display labels can be shortened; the host marks these limits. For a larger catalog, use the ordinary page to choose the intended variables, then obtain a fresh snapshot. Do not pretend truncated lists are complete.

The prepare command can receive choices already explicit in the user's request. Its supported answer IDs are:

| ID | Value |
| --- | --- |
| `inputKind` | `respondents` or `contingency` |
| `rowColumnId`, `columnColumnId` | distinct eligible categorical column IDs |
| `rowLabelColumnId` | ordinary row-label column ID |
| `valueColumnIds` | at least two distinct numeric column IDs |
| `cellSemantics` | `frequency` or `mass` |
| `weightMode` | `dataset` or `none` |
| `missingPolicy` | `exclude`, `include_missing`, or `separate_not_applicable` for respondents |
| `activateColumns` | `append`, only for explicitly chosen targets |

Resume uses the issued question subset, not this whole table. To change an already resolved choice, use the normal page or start a new prepare request with explicit choices. The host never changes roles/scales, imputes data, expands MA options, drops a saved weight, or widens the row scope to make an analysis run. Appending inactive chosen columns requires an explicit preparation answer and retains unrelated active variables.

Respondent inputs use the existing backend's current-scope two-variable cross-tabulation. Missing and saved dataset-weight settings are disclosed. The header's selected weight and the CA page's saved-weight mode are reported separately, because the ordinary CA page has its own weight choice. Table input uses its ordinary exclude-missing policy and requires at least two numeric value columns. A saved dataset weight conflicts with contingency input until the user explicitly chooses no additional weighting. No physical dataset values or metadata are changed by this preparation.

### Independent frequency counts

Aggregated table cells need explicit frequency/mass meaning. Integer-looking cells do not prove independent observations. For frequency input, the host returns a page-only question:

```json
{
  "id": "independentCounts",
  "type": "confirmation",
  "required": true,
  "requiresPageAction": true,
  "pageAction": {
    "view": "/models/ca",
    "instruction": "「セルが独立した観測の度数であることを確認する」を操作してください。"
  }
}
```

Only the existing page checkbox can acknowledge this condition. There is no writable command `ack`, `userConfirmed`, or `independentCounts` boolean. Editing table targets/semantics or source context resets the acknowledgement. The extension should offer a return-to-page instruction, then re-snapshot after the user's action.

## State and results

Expected normal-page input/checkbox changes update the same draft, questions, preview, and integer version. Dataset replacement, data/schema/canonical-codebook changes, and effective row-scope/sample changes invalidate it. A cancelled or stale computation cannot publish a normal-page result. Navigating away during a bridge run also suppresses its publication. A subsequent ordinary manual fit invalidates a completed bridge reference when it replaces that result.

Full results remain local to the ordinary page. Bridge completion returns the actual `resultId`, `view`, and a bounded summary: method, source revisions, scope/fit/exclusion counts (`usedRows` is the same fit count), weight interpretation, rank, total inertia, category counts, limited inertia ratios, and safe warning codes. Scalar types and size limits are checked before page publication. Full config, membership, category coordinates, arbitrary errors and server bodies are excluded. If a source changes just after a committed completion, the receipt reports invalidation with `committed:true` and no old summary; this is not rollback.

Page hide disposes pending work, listeners, snapshots, and authorizers. Page show creates a fresh host registration. React StrictMode cleanup and HMR remounts also dispose the old owner. In-flight computation cancellation is a publication guarantee, not a server-side compute-stop claim.

## Extension changes and boundaries

The original supplied0.1.1 extension did not provide rich question forms or automatic conversational resume. That version supports only outer completed/partial/failed receipts and can end its model loop on `kind:"clarify"`; the next Run starts without prior observations. It must detect the inner workflow status, stop deterministically at questions, show the actual choices, retain original intent and user answers, and resume from a fresh snapshot. The separately delivered Japanese handoff describes these extension changes. The subsequently supplied0.1.2 includes workflow forms/resume; the host question shapes and limits align with its validator. The extension runtime is maintained separately and is not installed or executed as part of host acceptance. Isolated unit validation may import its reviewed pure schema/workflow helper modules; this does not test the extension runtime or OAuth. A client must distinguish an acknowledged failed command from an unknown transport outcome, show its error and refreshed pending draft, and require explicit correction/retry instead of treating every failure as a lost reply.

The supplied page client binds the initialized URL pathname. Hash-route navigation works on the static test site. Browser-router path changes can require reconnecting the extension on the new page. Do not remove document/origin checks to hide that limitation.

No OAuth, extension installation, remote model inference, or extension-authentication claim is part of host validation. Numerical CA estimation remains in the existing backend. Maintained tests exercise the actual protocol, Redux adapter, shared page controller, and prepare→question→resume→normal-result path; hosted/manual acceptance is reported separately.

Vendored source, original hashes, GPL-3.0-or-later notice, and local amendments are recorded in `fullstack/frontend/src/integrations/siwc/UPSTREAM.md` and the adjacent `LICENSE`. The application's license panel also includes the vendored SDK.
