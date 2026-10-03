import { useCallback, useEffect, useRef, useState } from 'react'
import { useDispatch, useStore } from 'react-redux'
import { api, fetchArrowView, getCodebook } from '../api/client'
import type { AppDispatch, RootState, VariableMetaItem } from './store'
import { analysisWorkspaceRestored, datasetLoaded, variablesInitialized } from './store'
import { codebookReceived } from '../features/dataset/codebookSlice'
import { createAnalysisWorkspaceSnapshot, readAnalysisWorkspaceSnapshot } from '../features/selection/workspaceSession'

export interface SessionRecord {
  sessionId: string
  datasetId: string
  name: string
  revision: number
  versionToken: string
  state: unknown
  updatedAt?: string
}
export type SessionSummary = Omit<SessionRecord, 'state' | 'versionToken'>
type SessionIdentity = Omit<SessionRecord, 'state'>
const sessionIdentity = ({ state: _state, ...identity }: SessionRecord): SessionIdentity => identity
const errorMessage = (error: unknown) => (error as { message?: string })?.message || String(error)

/** Read and validate every input before changing the live workspace. */
async function prepareDataset(datasetId: string, name?: string) {
  const [meta, data, codebook] = await Promise.all([
    api.get<{ name: string; dataRevision: number; schema: Array<{
      columnId: string; name: string; semanticType: string; physicalType?: string; missingCount?: number
    }> }>(`/datasets/${datasetId}`),
    fetchArrowView(datasetId, []), getCodebook(datasetId),
  ])
  if (codebook.datasetId !== datasetId) throw new Error('データセットの読込結果が一致しません。再試行してください。')
  const rowIds = data.__rowId__ as string[]
  if (!Array.isArray(rowIds) || rowIds.some(id => typeof id !== 'string')) throw new Error('対象行を読み込めませんでした。')
  const variableMeta: Record<string, VariableMetaItem> = {}
  meta.schema.forEach(column => {
    variableMeta[column.name] = {
      columnId: column.columnId, name: column.name, semanticType: column.semanticType as VariableMetaItem['semanticType'],
      physicalType: column.physicalType || 'Float64', missingCount: column.missingCount || 0,
      isTargetCandidate: ['nominal', 'ordinal', 'categorical'].includes(column.semanticType),
    }
  })
  return { datasetId, name: name || meta.name, rowIds, dataRevision: meta.dataRevision,
    variables: meta.schema.map(column => column.name), variableMeta, codebook }
}

export function useWorkspacePersistence(onSaved: (message: string) => void) {
  const dispatch = useDispatch<AppDispatch>()
  const workspace = useStore<RootState>()
  const [identity, setIdentity] = useState<SessionIdentity | null>(null)
  const [sessionName, setSessionName] = useState('')
  const [saveModal, setSaveModal] = useState(false)
  const [saveAs, setSaveAs] = useState(false)
  const [saveBusy, setSaveBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [loadBusy, setLoadBusy] = useState(false)
  const [pendingDataset, setPendingDataset] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sessionsModal, setSessionsModal] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [listBusy, setListBusy] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [openingSession, setOpeningSession] = useState<string | null>(null)
  const loadGeneration = useRef(0)
  const listGeneration = useRef(0)
  const saving = useRef(false)
  const alive = useRef(true)
  const retry = useRef<null | (() => Promise<boolean>)>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false; loadGeneration.current++; listGeneration.current++ } }, [])

  const install = useCallback((prepared: Awaited<ReturnType<typeof prepareDataset>>, snapshot?: unknown) => {
    // Validate against prepared metadata, not the old dataset. Failed opens leave
    // the current dataset, rows and drafts intact.
    const current = workspace.getState()
    const candidate: RootState = { ...current,
      selection: { ...current.selection, datasetId: prepared.datasetId, dataRevision: prepared.dataRevision, allRowIds: prepared.rowIds },
      codebook: { ...current.codebook, ...prepared.codebook },
    }
    const restored = snapshot === undefined ? null : readAnalysisWorkspaceSnapshot(snapshot, candidate)
    dispatch(datasetLoaded(prepared))
    dispatch(variablesInitialized({ datasetId: prepared.datasetId, variables: prepared.variables, meta: prepared.variableMeta }))
    dispatch(codebookReceived(prepared.codebook))
    if (restored) dispatch(analysisWorkspaceRestored(restored))
  }, [dispatch, workspace])

  const loadDataset = useCallback(async (datasetId: string, name?: string): Promise<boolean> => {
    if (saving.current) return false
    const generation = ++loadGeneration.current
    setLoadBusy(true); setPendingDataset(datasetId); setLoadError(null)
    retry.current = () => loadDataset(datasetId, name)
    try {
      const prepared = await prepareDataset(datasetId, name)
      if (!alive.current || generation !== loadGeneration.current) return false
      install(prepared)
      setIdentity(null); setSessionName(''); setSaveModal(false); setSaveError(null); setConflict(false)
      return true
    } catch (error) {
      if (alive.current && generation === loadGeneration.current) setLoadError(`データセット読込に失敗しました: ${errorMessage(error)}`)
      return false
    } finally {
      if (alive.current && generation === loadGeneration.current) { setLoadBusy(false); setPendingDataset(null) }
    }
  }, [install])

  const openSession = useCallback(async (sessionId: string): Promise<boolean> => {
    if (saving.current) return false
    const generation = ++loadGeneration.current
    setLoadBusy(true); setOpeningSession(sessionId); setLoadError(null); setListError(null)
    retry.current = () => openSession(sessionId)
    try {
      const record = await api.get<SessionRecord>(`/sessions/${sessionId}`)
      if (!alive.current || generation !== loadGeneration.current) return false
      if (!record.datasetId || record.sessionId !== sessionId || !record.versionToken
        || (record.state as { datasetId?: string })?.datasetId !== record.datasetId)
        throw new Error('保存されたセッションのデータセット・世代情報が不完全です。')
      const prepared = await prepareDataset(record.datasetId)
      if (!alive.current || generation !== loadGeneration.current) return false
      install(prepared, record.state)
      setIdentity(sessionIdentity(record)); setSessionName(record.name); setSessionsModal(false); setSessions([]); setSaveModal(false); setSaveError(null); setConflict(false)
      onSaved(`セッション「${record.name}」の共通分析対象を開きました (revision ${record.revision})`)
      return true
    } catch (error) {
      if (alive.current && generation === loadGeneration.current) {
        const message = `セッションを開けませんでした: ${errorMessage(error)}`
        setListError(message); setLoadError(message)
      }
      return false
    } finally {
      if (alive.current && generation === loadGeneration.current) { setLoadBusy(false); setOpeningSession(null) }
    }
  }, [install, onSaved])

  const refreshSessions = useCallback(async () => {
    const generation = ++listGeneration.current
    setListBusy(true); setListError(null)
    try {
      const response = await api.get<{ sessions: SessionSummary[] }>('/sessions')
      if (alive.current && generation === listGeneration.current) setSessions(response.sessions.map(item => ({
        sessionId: item.sessionId, datasetId: item.datasetId, name: item.name, revision: item.revision, updatedAt: item.updatedAt,
      })))
    } catch (error) {
      if (alive.current && generation === listGeneration.current) setListError(`一覧を読み込めませんでした: ${errorMessage(error)}`)
    } finally {
      if (alive.current && generation === listGeneration.current) setListBusy(false)
    }
  }, [])

  const beginSave = (copy = false) => {
    if (saving.current || loadBusy) return
    const sameDataset = identity?.datasetId === workspace.getState().selection.datasetId
    setSaveAs(copy); setSessionName(copy ? `${sameDataset ? identity?.name || 'Session' : 'Session'} (copy)` : sameDataset ? identity?.name || '' : '')
    setSaveError(null); setConflict(false); setSaveModal(true)
  }
  const saveSession = async (forceCopy = false) => {
    if (saving.current || loadBusy || !workspace.getState().selection.datasetId) return
    saving.current = true; setSaveBusy(true); setSaveError(null)
    try {
      const state = { ...createAnalysisWorkspaceSnapshot(workspace.getState()), savedAt: new Date().toISOString() }
      const name = sessionName.trim() || `Session ${new Date().toLocaleString('ja-JP')}`
      const target = !forceCopy && !saveAs && identity?.datasetId === state.datasetId ? identity : null
      const saved = target
        ? await api.put<SessionRecord>(`/sessions/${target.sessionId}`, { state, name, versionToken: target.versionToken })
        : await api.post<SessionRecord>('/sessions', { name, datasetId: state.datasetId, state })
      if (!alive.current) return
      // Keep enough identity even for response contracts that omit state/name.
      setIdentity(sessionIdentity({ ...saved, datasetId: state.datasetId, name, state }))
      setSessionName(name); setConflict(false); setSaveModal(false)
      onSaved(`セッション保存 (revision ${saved.revision})`)
    } catch (error) {
      if (!alive.current) return
      setSaveError(`保存できませんでした: ${errorMessage(error)}`)
      setConflict((error as { code?: string })?.code === 'SESSION_CONFLICT')
    } finally {
      saving.current = false
      if (alive.current) setSaveBusy(false)
    }
  }

  return { identity, sessionName, setSessionName, saveModal, saveBusy, saveError, conflict, beginSave, saveSession,
    closeSave: () => { if (!saving.current && !loadBusy) setSaveModal(false) },
    loadDataset, loadBusy, pendingDataset, loadError, retryLoad: () => retry.current?.(),
    beginDatasetIntent: () => {
      if (saving.current) return null
      const generation = ++loadGeneration.current
      setLoadBusy(true); setPendingDataset(null); setLoadError(null)
      return generation
    },
    isCurrentDatasetIntent: (generation: number) => alive.current && loadGeneration.current === generation,
    finishDatasetIntent: (generation: number) => {
      if (alive.current && loadGeneration.current === generation) { setLoadBusy(false); setPendingDataset(null) }
    },
    sessionsModal, sessions, listBusy, listError, openingSession, openSession, refreshSessions,
    showSessions: () => { setSessionsModal(true); void refreshSessions() },
    closeSessions: () => { if (!loadBusy) { listGeneration.current++; setListBusy(false); setSessionsModal(false); setSessions([]) } },
  }
}
