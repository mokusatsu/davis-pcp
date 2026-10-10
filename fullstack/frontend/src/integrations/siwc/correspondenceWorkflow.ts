// SPDX-License-Identifier: GPL-3.0-or-later
import { activeEntitiesSet, selectEffectiveRowIds } from '../../app/store'
import type { CodebookColumn } from '../../api/client'
import {
  getCaController, subscribeCaController, type CorrespondenceConfiguration,
  type CorrespondenceController, type CorrespondenceInspection, type CorrespondenceCompleted, type CorrespondenceSetup,
} from '../../features/models/caControllerBridge'
import {
  assertDavisCanonicalState, describeDavisColumn, lookupDavisOrdinaryColumn,
  type DavisAdapterPorts, type DavisWorkflowPort,
} from './davisAdapter'
import { assert, boundedJSON, BridgeError, throwIfAborted } from './extension/core/common.js'
import type { CommandDefinition, JSONSchema, JSONValue, OperationContext } from './sdk/page-bridge.js'

const ROUTE = '/models/ca'
const TTL = 15 * 60 * 1000
const MAX_CHOICES = 80
const choiceIdSupported = (id: string) => id.length > 0 && id.length <= 200
  && !['__proto__', 'constructor', 'prototype'].includes(id)
const ANSWER_IDS = ['inputKind', 'rowColumnId', 'columnColumnId', 'rowLabelColumnId', 'valueColumnIds',
  'cellSemantics', 'weightMode', 'missingPolicy', 'activateColumns']
const questionIdSchema: JSONSchema = { type: 'string', enum: ANSWER_IDS }
const str = (maxLength = 256): JSONSchema => ({ type: 'string', minLength: 1, maxLength })
const object = (properties: Record<string, JSONSchema>): JSONSchema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
})
const answersSchema: JSONSchema = { type: 'array', maxItems: 12, items: { anyOf: [
  object({ questionId: questionIdSchema, value: str(1000) }),
  object({ questionId: questionIdSchema, value: { type: 'array', minItems: 1, maxItems: 100, items: str() } }),
  object({ questionId: questionIdSchema, value: { type: 'boolean' } }),
] } }
const binding = { requestId: str(100), draftRevision: { type: 'integer', minimum: 1 } }
export const CORRESPONDENCE_COMMANDS: CommandDefinition[] = [
  { name: 'analysis.prepare', workflowRole: 'prepare', effect: 'write', description: 'コレスポンデンス分析の通常画面を開き、対象や入力形式を確認する。未指定の条件は質問として返し、計算はしない。',
    inputSchema: object({ method: { type: 'string', enum: ['correspondence'] }, answers: answersSchema }) },
  { name: 'analysis.resume', workflowRole: 'resume', effect: 'write', description: '現在の質問への明示的な回答で分析準備を更新する。独立度数の確認は通常画面での操作が必要。',
    inputSchema: object({ ...binding, answers: answersSchema }) },
  { name: 'analysis.run', workflowRole: 'run', effect: 'write', description: '質問が解決した現在の準備内容で分析し、通常のコレスポンデンス分析画面に結果を表示する。', inputSchema: object(binding) },
  { name: 'analysis.cancel', workflowRole: 'cancel', effect: 'write', description: '準備または進行中の結果公開を中止する。完了済みの操作を取り消すものではない。', inputSchema: object(binding) },
]

type Status = 'needs_input' | 'ready' | 'completed' | 'invalidated' | 'cancelled'
type Question = { id: string; type: 'single' | 'multi' | 'confirmation'; prompt: string; required: boolean;
  options?: { value: string; label: string }[]; minItems?: number; maxItems?: number;
  requiresPageAction?: boolean; pageAction?: { view: string; instruction: string } }
type Answer = { questionId: string; value: string | string[] | boolean }
type Draft = { requestId: string; draftRevision: number; expiresAt: number; sourceRevision: string;
  status: Status; inputKindChosen: boolean; semanticsChosen: boolean; setupKey: string;
  questions: Question[]; preview: Record<string, JSONValue>; summary: JSONValue | null;
  reason: string | null; running: AbortController | null; completedDraftRevision: number | null }
type Ports = Pick<DavisAdapterPorts, 'store' | 'router' | 'monitor'> & {
  clock?: () => number
  /** Test seam also used to keep the workflow independent of React. */
  controllers?: { get(): CorrespondenceController | null; subscribe(listener: () => void): () => void }
}

const categorical = (c: CodebookColumn) => !c.multiResponseGroup
  && ['question', 'attribute'].includes(c.role) && ['nominal', 'ordinal', 'binary'].includes(c.scaleType)
const numeric = (c: CodebookColumn) => !c.multiResponseGroup && ['interval', 'ratio'].includes(c.scaleType)
const rowLabel = (c: CodebookColumn) => !c.multiResponseGroup && ['nominal', 'ordinal', 'binary', 'text', 'id'].includes(c.scaleType)
const choice = (c: CodebookColumn) => ({ value: c.columnId, label: `${c.name} — ${c.label}`.slice(0, 96) })
const descriptor = (c: CodebookColumn) => ({ ...describeDavisColumn(c), name: c.name.slice(0, 64),
  label: c.label.slice(0, 128), displayTruncated: c.name.length > 64 || c.label.length > 128 })
const setupKey = (inspection: CorrespondenceInspection) => JSON.stringify(inspection.setup)
const finite = (value: number) => { assert(Number.isFinite(value) && value >= 0, 'INVALID_ANALYSIS_RESULT'); return value }
const integer = (value: number) => { assert(Number.isSafeInteger(value) && value >= 0, 'INVALID_ANALYSIS_RESULT'); return value }
const boundedString = (value: unknown, limit = 128): string => {
  assert(typeof value === 'string' && value.length > 0 && value.length <= limit, 'INVALID_ANALYSIS_RESULT')
  return value
}

/** Deliberate allowlist: never send config, row IDs, coordinates or arbitrary server messages. */
export function summarizeCorrespondence(completed: CorrespondenceCompleted): JSONValue {
  const { result } = completed
  assert(result.status === 'ok' || result.status === 'success', 'INVALID_ANALYSIS_RESULT')
  boundedString(result.resultId, 200)
  assert(choiceIdSupported(result.resultId), 'INVALID_ANALYSIS_RESULT')
  const { meta, summary } = result
  assert(['all', 'active', 'selected', 'sampled', 'explicit'].includes(meta.scope), 'INVALID_ANALYSIS_RESULT')
  assert(['respondent_row', 'table_record'].includes(meta.analysisUnit), 'INVALID_ANALYSIS_RESULT')
  assert(typeof meta.weightApplied === 'boolean' && (meta.weightType === null
    || ['frequency', 'survey'].includes(meta.weightType)), 'INVALID_ANALYSIS_RESULT')
  assert(Array.isArray(summary.inertiaRatio) && Array.isArray(meta.warnings), 'INVALID_ANALYSIS_RESULT')
  return boundedJSON({
    method: 'correspondence', resultId: result.resultId, route: ROUTE,
    datasetId: boundedString(meta.datasetId, 200), dataRevision: integer(meta.dataRevision), schemaRevision: integer(meta.schemaRevision),
    scope: meta.scope, scopeCount: integer(meta.scopeCount), fitCount: integer(meta.fitCount), usedRows: integer(meta.fitCount),
    excludedCount: integer(meta.excludedCount), analysisUnit: meta.analysisUnit,
    weightApplied: meta.weightApplied, weightType: meta.weightType,
    algorithmVersion: boundedString(meta.algorithmVersion), rank: integer(summary.rank), totalInertia: finite(summary.totalInertia),
    tableTotal: finite(summary.tableTotal), rowCategoryCount: integer(summary.activeRowCategoryCount),
    columnCategoryCount: integer(summary.activeColumnCategoryCount),
    inertiaRatio: summary.inertiaRatio.slice(0, 20).map(finite), inertiaRatioTruncated: summary.inertiaRatio.length > 20,
    warnings: meta.warnings.slice(0, 20).map(w => ({ code: typeof w?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(w.code) ? w.code : 'ANALYSIS_WARNING' })),
  }, 32 * 1024) as JSONValue
}

/** Owns one short-lived intent; the ordinary CA controller owns computation and rendering. */
export function createCorrespondenceWorkflow({ store, router, monitor, clock = Date.now,
  controllers = { get: getCaController, subscribe: subscribeCaController } }: Ports): DavisWorkflowPort & { dispose(): void } {
  let draft: Draft | null = null
  let disposed = false, changing = false
  const life = new AbortController()
  const changed = () => { if (!disposed) monitor.bump() }
  const failClosed = (reason: string) => {
    if (!draft || draft.status === 'invalidated' || draft.status === 'cancelled') return
    draft.running?.abort(); draft.running = null
    draft.status = 'invalidated'; draft.reason = reason; draft.summary = null
    draft.questions = []; draft.preview = {}; draft.draftRevision++
    changed()
  }
  const sourceCurrent = () => Boolean(draft && !disposed && draft.expiresAt > clock()
    && draft.sourceRevision === monitor.getAnalysisRevision())
  const selectedColumns = (inspection: CorrespondenceInspection, columns: CodebookColumn[]) => {
    const s = inspection.setup
    const names = s.inputKind === 'respondents' ? [s.rowVar, s.colVar] : [s.rowLabelCol, ...s.valueCols]
    return names.map(name => columns.find(c => c.name === name)).filter((c): c is CodebookColumn => Boolean(c))
  }
  const refresh = () => {
    if (disposed || changing || !draft) return
    if (!sourceCurrent()) { failClosed(draft.expiresAt <= clock() ? 'DRAFT_EXPIRED' : 'ANALYSIS_SOURCE_CHANGED'); return }
    if (draft.status === 'cancelled' || draft.status === 'invalidated') return
    const controller = controllers.get()
    if (!controller) { failClosed('ANALYSIS_PAGE_UNAVAILABLE'); return }
    const inspection = controller.inspect(), state = store.getState()
    if (!inspection.ready || inspection.datasetId !== state.selection.datasetId
      || inspection.dataRevision !== state.selection.dataRevision || inspection.schemaRevision !== state.codebook.schemaRevision) {
      failClosed('ANALYSIS_SOURCE_CHANGED'); return
    }
    if (draft.status === 'completed' && draft.summary && typeof draft.summary === 'object' && !Array.isArray(draft.summary)
      && inspection.completed?.result.resultId !== draft.summary.resultId) {
      failClosed('ANALYSIS_RESULT_REPLACED'); return
    }
    const key = setupKey(inspection)
    const setupChanged = key !== draft.setupKey
    // Normal page edits are answers, not source changes. They create a fresh draft binding.
    if (setupChanged) {
      const previous = JSON.parse(draft.setupKey) as CorrespondenceSetup
      if (draft.running) { draft.running.abort(); draft.running = null }
      draft.setupKey = key; draft.summary = null; draft.draftRevision++
      draft.inputKindChosen = true
      if (previous.inputKind !== inspection.setup.inputKind) draft.semanticsChosen = false
      if (previous.cellSemantics !== inspection.setup.cellSemantics || inspection.setup.ack) draft.semanticsChosen = true
      draft.status = 'needs_input'
    }
    const columns = assertDavisCanonicalState(state)
    const s = inspection.setup, questions: Question[] = []
    const ask = (id: string, prompt: string, options: NonNullable<Question['options']>, type: Question['type'] = 'single') =>
      questions.push({ id, type, prompt, required: true, options })
    const options = (predicate: (column: CodebookColumn) => boolean) => columns.filter(c => predicate(c)
      && choiceIdSupported(c.columnId)).slice(0, MAX_CHOICES).map(choice)
    if (!draft.inputKindChosen) ask('inputKind', '各行は回答者のデータですか、それとも集計済みの表ですか。', [
      { value: 'respondents', label: '回答者ごとのデータから、2つのカテゴリ変数を分析' },
      { value: 'contingency', label: '集計済みのクロス表（度数または質量）を分析' },
    ])
    const valid = (name: string | null, predicate: (c: CodebookColumn) => boolean) => columns.some(c => c.name === name && predicate(c))
    if (s.inputKind === 'respondents') {
      if (!valid(s.rowVar, categorical)) ask('rowColumnId', '行に配置するカテゴリ変数を選んでください。3変数以上のMCAはこの自動実行の対象外です。', options(categorical))
      if (!valid(s.colVar, categorical) || s.colVar === s.rowVar) ask('columnColumnId', '列に配置する、行とは別のカテゴリ変数を選んでください。', options(c => categorical(c) && c.name !== s.rowVar))
    } else {
      if (!valid(s.rowLabelCol, rowLabel)) ask('rowLabelColumnId', '集計表の行ラベル列を選んでください。', options(rowLabel))
      if (s.valueCols.length < 2 || s.valueCols.some(name => !valid(name, numeric) || name === s.rowLabelCol)) {
        ask('valueColumnIds', '集計表の値を含む数値列を2つ以上選んでください。', options(c => numeric(c) && c.name !== s.rowLabelCol), 'multi')
        Object.assign(questions[questions.length - 1], { minItems: 2,
          maxItems: Math.min(100, questions[questions.length - 1].options!.length) })
      }
      if (!draft.semanticsChosen) ask('cellSemantics', '表の数値は独立した観測の度数ですか、それとも重み等を集約した質量ですか。', [
        { value: 'frequency', label: '独立した観測を数えた度数（ページで確認が必要）' },
        { value: 'mass', label: '質量・集約済みの重み（独立度数の検定なし）' },
      ])
      if (s.weightChoice === 'dataset' && state.codebook.weightConfig?.weightColumnId) ask('weightMode', '集計済みの値に保存済みのウェイトを重ねて適用できません。表を無加重で分析するか、入力形式を見直してください。', [{ value: 'none', label: '集計済みの値をそのまま使用（追加のウェイトなし）' }])
      if (draft.semanticsChosen && s.cellSemantics === 'frequency' && !s.ack) questions.push({
        id: 'independentCounts', type: 'confirmation', prompt: '独立した観測を数えた度数であることを、DAVISの通常画面のチェックボックスで確認してください。',
        required: true, requiresPageAction: true,
        pageAction: { view: ROUTE, instruction: '「セルが独立した観測の度数であることを確認する」を操作してください。' },
      })
    }
    const chosen = selectedColumns(inspection, columns)
    const active = state.globalVariables.activeEntities
    const inactive = active === null ? [] : chosen.filter(c => !active.some(e => e.kind === 'column' && e.columnId === c.columnId))
    // Row label is not restricted by the normal page's global numeric/categorical picker.
    const needed = inactive.filter(c => s.inputKind === 'respondents' || c.name !== s.rowLabelCol)
    if (needed.length) ask('activateColumns', '選んだ変数を共通の分析対象変数に追加します。現在の選択は保持します。', [{ value: 'append', label: '選んだ変数を追加する' }])
    const scope = state.globalObservations.scopeMode
    const preview: Record<string, JSONValue> = {
      view: ROUTE, inputKind: s.inputKind, columns: chosen.map(descriptor), mapScaling: s.mapScaling,
      rowColumnId: s.inputKind === 'respondents' ? columns.find(c => c.name === s.rowVar)?.columnId ?? null : null,
      columnColumnId: s.inputKind === 'respondents' ? columns.find(c => c.name === s.colVar)?.columnId ?? null : null,
      rowLabelColumnId: s.inputKind === 'contingency' ? columns.find(c => c.name === s.rowLabelCol)?.columnId ?? null : null,
      valueColumnIds: s.inputKind === 'contingency' ? s.valueCols.map(name => columns.find(c => c.name === name)?.columnId ?? null) : [],
      datasetId: state.selection.datasetId, dataRevision: state.selection.dataRevision,
      schemaRevision: state.codebook.schemaRevision, scope, scopeCount: new Set(selectEffectiveRowIds(state)).size,
      missingPolicy: s.inputKind === 'contingency' ? 'exclude' : s.missingPolicy,
      weightMode: s.weightChoice, savedWeightColumnId: state.codebook.weightConfig?.weightColumnId ?? null,
      savedWeightType: state.codebook.weightConfig?.weightType ?? null,
      headerWeightColumnId: state.globalVariables.weightColumnId,
      cellSemantics: s.inputKind === 'contingency' ? s.cellSemantics : null,
      preparation: s.inputKind === 'respondents' ? '現在の対象行を2変数のクロス表に集計します。元データは変更しません。' : '集計済みの表を使用します。欠損は除外し、元データは変更しません。',
      appendColumnIds: needed.map(c => c.columnId),
      columnOptionsTruncated: [categorical, numeric, rowLabel].some(predicate => {
        const eligible = columns.filter(predicate)
        return eligible.length > MAX_CHOICES || eligible.some(c => !choiceIdSupported(c.columnId))
      }),
      optionLabelsMayBeTruncated: columns.some(c => `${c.name} — ${c.label}`.length > 96),
    }
    if (!questions.length && !inspection.canRun) questions.push({ id: 'pageInputs', type: 'confirmation',
      prompt: '通常画面の入力条件を確認してください。実行可能になると、この質問は解消されます。', required: true,
      requiresPageAction: true, pageAction: { view: ROUTE, instruction: '分析対象・入力条件と画面に表示される案内を確認してください。' } })
    for (const question of questions) {
      if (!question.requiresPageAction && ((question.options?.length ?? 0) === 0
        || (question.type === 'multi' && question.options!.length < (question.minItems ?? 0)))) {
        question.type = 'confirmation'
        delete question.options; delete question.minItems; delete question.maxItems
        question.requiresPageAction = true
        question.pageAction = { view: ROUTE, instruction: 'この条件で選べる列が不足しています。データと既存のコードブックの役割・尺度を確認してください。ホストは自動で変更しません。' }
      }
    }
    const stateChanged = JSON.stringify([draft.questions, draft.preview]) !== JSON.stringify([questions, preview])
    if (stateChanged && !setupChanged && draft.questions.length + Object.keys(draft.preview).length > 0) {
      draft.running?.abort(); draft.running = null; draft.draftRevision++; draft.summary = null
      draft.status = 'needs_input'
    }
    draft.questions = questions; draft.preview = preview
    if (draft.status !== 'completed') draft.status = questions.length || !inspection.canRun ? 'needs_input' : 'ready'
    if (stateChanged || setupChanged) changed()
  }
  const getContext = (): JSONValue => {
    refresh()
    if (!draft) return null
    const messages: Record<Status, string> = {
      needs_input: '分析に必要な対象・条件を確認してください。',
      ready: '確認した条件でコレスポンデンス分析を実行できます。',
      completed: '通常のコレスポンデンス分析画面に結果を表示しました。',
      invalidated: '対象または結果が変更されたため、改めて分析を準備してください。',
      cancelled: '分析の準備を中止しました。完了済みの処理は取り消していません。',
    }
    return boundedJSON({ workflow: 'page-workflow/1', method: 'correspondence',
      status: draft.status, requestId: draft.requestId, draftRevision: draft.draftRevision, expiresAt: draft.expiresAt,
      message: messages[draft.status],
      questions: draft.questions, preview: draft.preview, running: Boolean(draft.running),
      reason: draft.reason, summary: draft.summary,
      ...(draft.status === 'completed' && draft.summary && typeof draft.summary === 'object' && !Array.isArray(draft.summary)
        ? { resultId: draft.summary.resultId, view: ROUTE } : {}),
      ...(draft.status === 'needs_input' ? { resume: { command: 'analysis.resume' } } : {}),
      ...(draft.status === 'ready' ? { run: { command: 'analysis.run' } } : {}),
      ...(['needs_input', 'ready', 'completed'].includes(draft.status) ? { cancel: { command: 'analysis.cancel' } } : {}),
    }, 128 * 1024) as JSONValue
  }
  const guard = (context: OperationContext) => {
    assert(!disposed, 'BRIDGE_DISPOSED'); throwIfAborted(context.signal); monitor.assertCurrent(context.expectedRevision)
  }
  const bound = (args: Record<string, JSONValue>, allowCompleted = false) => {
    refresh()
    assert(draft && args.requestId === draft.requestId, 'UNKNOWN_ANALYSIS_DRAFT')
    assert(args.draftRevision === draft.draftRevision || (allowCompleted && draft.status === 'completed'
      && args.draftRevision === draft.completedDraftRevision), 'STALE_ANALYSIS_DRAFT')
    assert(draft.status !== 'invalidated' && draft.status !== 'cancelled', 'ANALYSIS_DRAFT_UNAVAILABLE')
    return draft
  }
  const waitReady = (sourceRevision: string, signal: AbortSignal): Promise<CorrespondenceController> => new Promise((resolve, reject) => {
    let unsubscribe = () => {}, timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => { unsubscribe(); clearTimeout(timer); signal.removeEventListener('abort', abort); life.signal.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); reject(new BridgeError('CANCELLED')) }
    const check = () => {
      if (signal.aborted || disposed) { abort(); return }
      if (sourceRevision !== monitor.getAnalysisRevision()) { cleanup(); reject(new BridgeError('STALE_STATE')); return }
      const controller = controllers.get(), inspection = controller?.inspect(), state = store.getState()
      if (controller && inspection?.ready && inspection.datasetId === state.selection.datasetId
        && inspection.dataRevision === state.selection.dataRevision && inspection.schemaRevision === state.codebook.schemaRevision) {
        cleanup(); resolve(controller)
      }
    }
    unsubscribe = controllers.subscribe(check)
    timer = setTimeout(() => { cleanup(); reject(new BridgeError('ANALYSIS_PAGE_NOT_READY')) }, 20_000)
    signal.addEventListener('abort', abort, { once: true }); life.signal.addEventListener('abort', abort, { once: true })
    check()
  })
  const applyAnswers = (raw: JSONValue, controller: CorrespondenceController, isResume = false) => {
    assert(Array.isArray(raw) && raw.length <= 12, 'INVALID_ANALYSIS_ANSWERS')
    const answers = raw as unknown as Answer[]
    assert(new Set(answers.map(a => a.questionId)).size === answers.length, 'DUPLICATE_ANALYSIS_ANSWER')
    assert(answers.every(a => ANSWER_IDS.includes(a.questionId)), 'UNKNOWN_ANALYSIS_ANSWER')
    if (isResume) for (const answer of answers) {
      const question = draft?.questions.find(q => q.id === answer.questionId)
      assert(question && !question.requiresPageAction, 'UNASKED_ANALYSIS_ANSWER')
      const values = Array.isArray(answer.value) ? answer.value : [answer.value]
      assert((question.type === 'multi') === Array.isArray(answer.value), 'INVALID_ANALYSIS_ANSWER')
      assert(values.every(value => typeof value === 'string' && question.options?.some(option => option.value === value)), 'INVALID_ANALYSIS_ANSWER')
      assert(values.length >= (question.minItems ?? 1) && values.length <= (question.maxItems ?? 1), 'INVALID_ANALYSIS_ANSWER')
    }
    const byId = new Map(answers.map(a => [a.questionId, a.value]))
    const patch: CorrespondenceConfiguration = {}, state = store.getState(), current = controller.inspect().setup
    const enumValue = <T extends string>(id: string, values: readonly T[]): T | undefined => {
      if (!byId.has(id)) return undefined
      const value = byId.get(id)
      assert(typeof value === 'string' && values.includes(value as T), 'INVALID_ANALYSIS_ANSWER')
      return value as T
    }
    const inputKind = enumValue('inputKind', ['respondents', 'contingency'] as const) ?? current.inputKind
    if (byId.has('inputKind')) patch.inputKind = inputKind
    const column = (id: string, predicate: (c: CodebookColumn) => boolean): string | undefined => {
      if (!byId.has(id)) return undefined
      const value = byId.get(id); assert(typeof value === 'string', 'INVALID_ANALYSIS_ANSWER')
      const c = lookupDavisOrdinaryColumn(state, value); assert(predicate(c), 'INELIGIBLE_ANALYSIS_COLUMN'); return c.name
    }
    if (inputKind === 'respondents') {
      assert(!['rowLabelColumnId', 'valueColumnIds', 'cellSemantics'].some(id => byId.has(id)), 'INAPPLICABLE_ANALYSIS_ANSWER')
      const row = column('rowColumnId', categorical), col = column('columnColumnId', categorical)
      if (row !== undefined) patch.rowVar = row
      if (col !== undefined) patch.colVar = col
      assert(!(patch.rowVar ?? current.rowVar) || (patch.rowVar ?? current.rowVar) !== (patch.colVar ?? current.colVar), 'DISTINCT_COLUMNS_REQUIRED')
    } else {
      assert(!['rowColumnId', 'columnColumnId'].some(id => byId.has(id)), 'INAPPLICABLE_ANALYSIS_ANSWER')
      const label = column('rowLabelColumnId', rowLabel)
      if (label !== undefined) patch.rowLabelCol = label
      if (byId.has('valueColumnIds')) {
        const ids = byId.get('valueColumnIds')
        assert(Array.isArray(ids) && ids.length >= 2 && ids.length <= 100 && new Set(ids).size === ids.length, 'INVALID_ANALYSIS_ANSWER')
        patch.valueCols = ids.map(id => { const c = lookupDavisOrdinaryColumn(state, id); assert(numeric(c), 'INELIGIBLE_ANALYSIS_COLUMN'); return c.name })
        assert(!patch.valueCols.includes(patch.rowLabelCol ?? current.rowLabelCol ?? ''), 'DISTINCT_COLUMNS_REQUIRED')
      }
      const semantics = enumValue('cellSemantics', ['frequency', 'mass'] as const)
      if (semantics) patch.cellSemantics = semantics
    }
    const weight = enumValue('weightMode', ['dataset', 'none'] as const)
    const missing = enumValue('missingPolicy', ['exclude', 'include_missing', 'separate_not_applicable'] as const)
    if (weight) patch.weightChoice = weight
    if (missing) { assert(inputKind === 'respondents' || missing === 'exclude', 'INAPPLICABLE_ANALYSIS_ANSWER'); patch.missingPolicy = missing }
    const activate = enumValue('activateColumns', ['append'] as const)
    const proposed = { ...current, ...patch }
    const chosen = selectedColumns({ ...controller.inspect(), setup: proposed }, assertDavisCanonicalState(state))
      .filter(c => inputKind === 'respondents' || c.name !== proposed.rowLabelCol)
    if (activate) assert(chosen.length > 0, 'ANALYSIS_TARGETS_REQUIRED')
    // No mutations happen until the whole answer set and activation have passed validation.
    changing = true
    try {
      controller.configure(patch)
      if (activate) {
        const active = state.globalVariables.activeEntities
        if (active !== null) {
          const append = chosen.filter(c => !active.some(e => e.kind === 'column' && e.columnId === c.columnId))
          if (append.length) store.dispatch(activeEntitiesSet([...active, ...append.map(c => ({ kind: 'column' as const, columnId: c.columnId }))]))
        }
      }
      if (draft) {
        draft.inputKindChosen ||= byId.has('inputKind') || byId.has('rowColumnId') || byId.has('columnColumnId') || byId.has('rowLabelColumnId') || byId.has('valueColumnIds')
        draft.semanticsChosen ||= byId.has('cellSemantics')
        draft.setupKey = setupKey(controller.inspect()); draft.draftRevision++
        draft.summary = null; draft.status = 'needs_input'
      }
    } finally { changing = false }
    refresh(); changed()
  }
  const handlers: DavisWorkflowPort['handlers'] = {
    'analysis.prepare': async (args, context) => {
      guard(context); assert(args.method === 'correspondence', 'UNSUPPORTED_ANALYSIS_METHOD')
      assertDavisCanonicalState(store.getState())
      const sourceRevision = monitor.getAnalysisRevision()
      draft?.running?.abort()
      draft = null
      const navigation = router.navigate(ROUTE)
      const ownedRevision = monitor.getRevision()
      await navigation
      monitor.assertCurrent(ownedRevision)
      const controller = await waitReady(sourceRevision, context.signal)
      throwIfAborted(context.signal); assert(!disposed && sourceRevision === monitor.getAnalysisRevision(), 'STALE_STATE')
      monitor.assertCurrent(ownedRevision)
      const inspection = controller.inspect()
      draft = { requestId: crypto.randomUUID(), draftRevision: 1, expiresAt: clock() + TTL,
        sourceRevision, status: 'needs_input', inputKindChosen: true,
        semanticsChosen: inspection.setup.inputKind === 'contingency' && (inspection.setup.ack || inspection.setup.cellSemantics === 'mass'),
        setupKey: setupKey(inspection), questions: [], preview: {}, summary: null, reason: null, running: null, completedDraftRevision: null }
      applyAnswers(args.answers, controller)
      return getContext()
    },
    'analysis.resume': (args, context) => {
      guard(context); const current = bound(args)
      assert(!current.running, 'ANALYSIS_RUNNING')
      const controller = controllers.get(); assert(controller, 'ANALYSIS_PAGE_NOT_READY')
      applyAnswers(args.answers, controller, true)
      return getContext()
    },
    'analysis.run': async (args, context) => {
      guard(context); const current = bound(args, true)
      if (current.status === 'completed') { await router.navigate(ROUTE); return getContext() }
      assert(current.status === 'ready' && !current.running, 'ANALYSIS_INPUT_REQUIRED')
      const controller = controllers.get(); assert(controller?.inspect().canRun && !controller.inspect().loading, 'ANALYSIS_INPUT_REQUIRED')
      const run = new AbortController(), revision = current.draftRevision
      current.running = run
      changed()
      const abort = () => run.abort()
      let unsubscribeRoute = () => {}
      context.signal.addEventListener('abort', abort, { once: true })
      const valid = () => !disposed && draft === current && sourceCurrent() && current.draftRevision === revision
        && !run.signal.aborted && !context.signal.aborted && router.getPath() === ROUTE
      let summary: JSONValue | null = null
      try {
        const navigation = router.navigate(ROUTE)
        const ownedRevision = monitor.getRevision()
        await navigation
        monitor.assertCurrent(ownedRevision)
        assert(valid(), 'STALE_ANALYSIS_DRAFT')
        unsubscribeRoute = router.subscribe(() => { if (router.getPath() !== ROUTE) run.abort() })
        await controller.run({ signal: run.signal, beforeCommit: completed => {
          if (!valid()) return false
          summary = summarizeCorrespondence(completed)
          return valid()
        } })
        assert(summary, 'INVALID_ANALYSIS_RESULT')
        // run() resolves only after the page committed. A later cancel cannot undo
        // that effect or turn its receipt into failure. A new source still must
        // never receive the old summary through snapshot.workflow.
        if (draft !== current || !sourceCurrent() || current.draftRevision !== revision) {
          return { workflow: 'page-workflow/1', method: 'correspondence', status: 'invalidated',
            requestId: current.requestId, draftRevision: current.draftRevision, expiresAt: current.expiresAt,
            reason: 'DRAFT_CHANGED_AFTER_COMPLETION', committed: true, summary: null }
        }
        current.summary = summary; current.status = 'completed'; current.draftRevision++
        current.completedDraftRevision = revision
        current.running = null; changed()
        return getContext()
      } catch (error) {
        if (error instanceof BridgeError) throw error
        const code = (error as { code?: unknown })?.code
        if (typeof code === 'string' && ['CANCELLED', 'CA_RUN_SUPERSEDED', 'CA_INPUT_REQUIRED', 'CA_CONTROLLER_DISPOSED'].includes(code)) throw new BridgeError(code)
        throw new BridgeError('ANALYSIS_FAILED')
      } finally {
        context.signal.removeEventListener('abort', abort)
        unsubscribeRoute()
        if (current.running === run) { current.running = null; changed() }
      }
    },
    'analysis.cancel': (args, context) => {
      guard(context); const current = bound(args)
      if (current.status === 'completed') return getContext()
      current.running?.abort(); current.running = null
      current.status = 'cancelled'; current.questions = []; current.summary = null; current.draftRevision++
      changed(); return getContext()
    },
  }
  const unsubscribeMonitor = monitor.subscribe(refresh)
  const unsubscribeController = controllers.subscribe(refresh)
  return { commands: CORRESPONDENCE_COMMANDS, handlers, getContext, dispose: () => {
    if (disposed) return
    disposed = true; life.abort(); draft?.running?.abort(); draft = null
    unsubscribeMonitor(); unsubscribeController()
  } }
}
