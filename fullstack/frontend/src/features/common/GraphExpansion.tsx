import { findGraphElement } from './graphElement'
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import { Button, Space, Typography } from 'antd'
import {
  FullscreenOutlined, FullscreenExitOutlined, ZoomInOutlined, ZoomOutOutlined, OneToOneOutlined,
} from '@ant-design/icons'
import PointerSelectionDropdown from '../selection/PointerSelectionDropdown'

/**
 * Feature 035 共通拡大基盤。
 * GraphPanel ごとに portal container を固定し、所有 host だけを
 * 通常 slot と共通 dialog 間で移す。描画子の複製・再マウントはしない。
 */

export const GRAPH_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const
export type GraphZoom = number | null // null = フィット

export interface GraphSession {
  graphId: string
  pageKey: string
  datasetId: string | null
  title: string
  zoom: GraphZoom
  host: HTMLElement
  returnSlot: HTMLElement | null
  originButton: HTMLElement | null
  normalScroll: { left: number; top: number }
}

export interface GraphRegistryEntry {
  graphId: string
  title: string
  host: HTMLElement
  slot: HTMLElement | null
  available: boolean
  pageKey: string
  datasetId: string | null
  originButton: HTMLElement | null
}

interface GraphExpansionValue {
  session: GraphSession | null
  register: (entry: GraphRegistryEntry) => void
  unregister: (graphId: string, host: HTMLElement) => void
  updateEntry: (graphId: string, host: HTMLElement, patch: Partial<GraphRegistryEntry>) => void
  open: (graphId: string) => boolean
  openWhenAvailable: (graphId: string) => boolean
  close: () => void
  setZoom: (z: GraphZoom) => void
  notifyRoute: (pageKey: string, datasetId: string | null) => void
  getPopupContainer: () => HTMLElement
}

const GraphExpansionContext = createContext<GraphExpansionValue>({
  session: null,
  register: () => undefined,
  unregister: () => undefined,
  updateEntry: () => undefined,
  open: () => false,
  openWhenAvailable: () => false,
  close: () => undefined,
  setZoom: () => undefined,
  notifyRoute: () => undefined,
  getPopupContainer: () => document.body,
})

export function normalizePageKey(pathname: string): string {
  const p = pathname.replace(/\/$/, '')
  return p === '' ? '/pcp' : p
}

export function GraphExpansionProvider({ children }: { children: ReactNode }) {
  const registry = useRef(new Map<string, GraphRegistryEntry>())
  const [session, setSession] = useState<GraphSession | null>(null)
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const dockRef = useRef<HTMLDivElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<GraphSession | null>(null)
  const pendingRef = useRef(new Set<string>())
  const currentPage = useRef<{ pageKey: string; datasetId: string | null }>({ pageKey: '', datasetId: null })
  sessionRef.current = session

  // R035-04: 実 viewport のスクロール位置を保存・復元する。
  // 旧実装は slot 祖先の [data-graph-scroll] を探索していたが、この属性は
  // どこにも付与されておらず、実際のスクロール容器（host 内 viewport）を
  // 取得できていなかった。host 内の viewport を直接使う。
  const viewportOf = useCallback((host: HTMLElement | null): HTMLElement | null => {
    if (!host) return null
    try {
      return host.querySelector<HTMLElement>('[data-testid^="graph-viewport-"]')
    } catch { return null }
  }, [])

  const closeSession = useCallback((current: GraphSession | null) => {
    if (!current) return
    try {
      // host が dialog 受け口にある場合だけ slot へ戻す。
      // 既に slot 配下（React が管理する元の位置）なら DOM 操作しない。
      if (current.returnSlot && current.host.parentElement
        && current.host.parentElement !== current.returnSlot
        && current.host.parentElement === dockRef.current) {
        current.returnSlot.appendChild(current.host)
      }
    } catch { /* slot が既に無い場合は host を解放する */ }
    try {
      const dlg = dialogRef.current
      if (dlg && (dlg.open || dlg.hasAttribute('open'))) {
        if (dlg.open) dlg.close()
        else dlg.removeAttribute('open')
      }
    } catch { /* already closed */ }
    // route/dataset 切替時は旧ページへ focus やスクロールを戻さない。
    const moved = currentPage.current.pageKey === current.pageKey
      && currentPage.current.datasetId === current.datasetId
    // F005-03: 起点ボタンは拡大中にアンマウントされるため、保持した参照だけでなく
    // graphId から復帰先を再解決する。どちらもなければフォーカス復帰は行わない。
    // 注意：拡大終了は再レンダー後にボタンが復活するため、rAF 後に再解決して focus する。
    if (moved) {
      const focusOrigin = () => {
        const origin = (current.originButton && document.contains(current.originButton))
          ? current.originButton
          : findGraphElement('data-testid', `graph-expand-${current.graphId}`)
            ?? findGraphElement('data-graph-origin', current.graphId)
        if (origin) {
          try { origin.focus() } catch { /* focus 失敗は無視 */ }
        }
      }
      focusOrigin()
      requestAnimationFrame(() => { try { focusOrigin() } catch { /* ignore */ } })
    }
    if (moved) {
      try {
        // host 内の実 viewport へ通常スクロール位置を復元する。
        const scroller = viewportOf(current.host)
        if (scroller) scroller.scrollTo(current.normalScroll.left, current.normalScroll.top)
      } catch { /* ignore */ }
    }
  }, [viewportOf])

  const close = useCallback(() => {
    setSession((prev) => {
      closeSession(prev)
      return null
    })
  }, [closeSession])

  const buildSession = useCallback((entry: GraphRegistryEntry): GraphSession => {
    // 拡大開始前の通常スクロール位置は host 内の実 viewport から保存する。
    const scroller = viewportOf(entry.host)
    return {
      graphId: entry.graphId,
      pageKey: entry.pageKey,
      datasetId: entry.datasetId,
      title: entry.title,
      zoom: null,
      host: entry.host,
      returnSlot: entry.slot,
      originButton: entry.originButton
        ?? findGraphElement('data-graph-origin', entry.graphId),
      normalScroll: { left: scroller?.scrollLeft ?? 0, top: scroller?.scrollTop ?? 0 },
    }
  }, [viewportOf])

  const tryStart = useCallback((graphId: string): boolean => {
    const entry = registry.current.get(graphId)
    // 登録なし・非表示対象の開始要求は失敗させ、現在のページを拡大状態にしない。
    if (!entry || !entry.available) return false
    // pageKey/datasetId が未通知の isoloated 利用（unit test 等）では照合を緩和する。
    // 実画面では AppShell が notifyRoute で必ず通知するため照合が効く。
    const pageKnown = currentPage.current.pageKey !== '' || currentPage.current.datasetId !== null
    if (pageKnown
      && (entry.pageKey !== currentPage.current.pageKey || entry.datasetId !== currentPage.current.datasetId)) return false
    const prev = sessionRef.current
    if (prev && prev.graphId === graphId) return true // 同一対象の重複開始は no-op
    if (prev) closeSession(prev)
    setSession(buildSession(entry))
    return true
  }, [buildSession, closeSession])

  useEffect(() => {
    const dlg = dialogRef.current
    if (!dlg) return
    // R035-02: dialog 内の antd popup が開いているか。可視メニューの有無で判定する。
    // antd は閉じた後も .ant-dropdown-hidden のラッパーを残すため、open クラスや
    // 非 hidden セレクタだけでは誤検知する。可視性（offsetParent・rect）を併用する。
    const isVisibleEl = (el: Element | null): boolean => {
      if (!el || !(el instanceof HTMLElement)) return false
      try {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
      } catch { return false }
    }
    const isGraphPopupOpen = () => {
      const root = popupRef.current ?? dlg
      if (root.querySelector('.ant-select-open, .ant-dropdown-open, .ant-tooltip-open, .ant-popover-open')) {
        // open クラスが残骸か可視メニューで裏付ける。
        const vis = dlg.querySelector('.ant-dropdown-menu, .ant-select-dropdown, .ant-tooltip-inner, .ant-popover-inner')
        if (isVisibleEl(vis)) return true
      }
      const visMenu = dlg.querySelector('.ant-dropdown-menu, .ant-select-dropdown:not([hidden]), .ant-tooltip-inner, .ant-popover-inner')
      return isVisibleEl(visMenu)
    }
    // R035-02: davis:close-graph-popup の受信処理。開いている antd popup を閉じる。
    // antd は Escape を自前で処理するため、ここではフォーカスを dialog 内へ戻し、
    // 開状態の解除を促す。イベント発行だけでは閉じない問題の修正。
    const onClosePopup = () => {
      const dock = dockRef.current
      try {
        (document.activeElement as HTMLElement | null)?.blur?.()
        dock?.querySelector<HTMLElement>('[data-testid^="graph-surface-"]')?.focus?.()
      } catch { /* ignore */ }
      // Dropdown menu の可視要素が残っていれば Escape を転送して閉じる。
      const openMenu = dlg.querySelector<HTMLElement>('.ant-dropdown-menu, .ant-select-dropdown, .ant-tooltip-inner')
      try { openMenu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) } catch { /* ignore */ }
    }
    const onCancel = (e: Event) => {
      // 子 popup が開いていれば先に閉じる。二回目で拡大終了。
      if (isGraphPopupOpen()) {
        e.preventDefault()
        window.dispatchEvent(new Event('davis:close-graph-popup'))
        return
      }
      e.preventDefault()
      close()
    }
    const onClose = () => {
      const s = sessionRef.current
      if (s) {
        closeSession(s)
        setSession(null)
      }
    }
    dlg.addEventListener('cancel', onCancel)
    dlg.addEventListener('close', onClose)
    window.addEventListener('davis:close-graph-popup', onClosePopup)
    return () => {
      dlg.removeEventListener('cancel', onCancel)
      dlg.removeEventListener('close', onClose)
      window.removeEventListener('davis:close-graph-popup', onClosePopup)
    }
  }, [close, closeSession])

  // unmount 時は dialog・登録を解放する。
  useEffect(() => () => {
    closeSession(sessionRef.current)
    registry.current.clear()
    pendingRef.current.clear()
  }, [closeSession])

  const register = useCallback((entry: GraphRegistryEntry) => {
    const withRoute: GraphRegistryEntry = {
      ...entry,
      pageKey: entry.pageKey || currentPage.current.pageKey,
      datasetId: entry.datasetId ?? currentPage.current.datasetId,
    }
    registry.current.set(entry.graphId, withRoute)
    // 「図へ移動」の保留要求：登録後に available なら開く。
    if (pendingRef.current.has(entry.graphId)) {
      pendingRef.current.delete(entry.graphId)
      tryStart(entry.graphId)
    }
  }, [tryStart])

  const unregister = useCallback((graphId: string, host: HTMLElement) => {
    const current = registry.current.get(graphId)
    if (current && current.host === host) registry.current.delete(graphId)
    pendingRef.current.delete(graphId)
    setSession((prev) => {
      if (prev && prev.graphId === graphId && prev.host === host) {
        closeSession(prev)
        return null
      }
      return prev
    })
  }, [closeSession])

  const updateEntry = useCallback((graphId: string, host: HTMLElement, patch: Partial<GraphRegistryEntry>) => {
    const current = registry.current.get(graphId)
    if (!current || current.host !== host) return
    // pageKey/datasetId の正本は notifyRoute。patch に route 情報が無ければ維持する。
    const next = {
      ...current, ...patch, graphId, host,
      pageKey: patch.pageKey || current.pageKey || currentPage.current.pageKey,
      datasetId: patch.datasetId ?? current.datasetId ?? currentPage.current.datasetId,
    }
    registry.current.set(graphId, next)
    if (patch.available === false) {
      pendingRef.current.delete(graphId)
      setSession((prev) => {
        if (prev && prev.graphId === graphId) {
          closeSession(prev)
          return null
        }
        return prev
      })
    } else if (patch.available === true && pendingRef.current.has(graphId)) {
      pendingRef.current.delete(graphId)
      tryStart(graphId)
    }
  }, [closeSession, tryStart])

  const open = useCallback((graphId: string): boolean => tryStart(graphId), [tryStart])

  const openWhenAvailable = useCallback((graphId: string): boolean => {
    const entry = registry.current.get(graphId)
    if (entry && entry.available
      && entry.pageKey === currentPage.current.pageKey
      && entry.datasetId === currentPage.current.datasetId) {
      return tryStart(graphId)
    }
    // まだマウントされていない図のために空の dialog は開かない。登録を待つ。
    pendingRef.current.add(graphId)
    return false
  }, [tryStart])

  // R035-04/F004-03: 数値倍率の変更時は表示中央の論理位置を保ち、
  // フィット時は原点へ戻す。同じ倍率のフィット再押下でも原点復帰を実行する
  // （prev.zoom===z の早期 return では到達しないため、fit は常に処理する）。
  const setZoom = useCallback((z: GraphZoom) => {
    setSession((prev) => {
      if (!prev) return prev
      if (prev.zoom === z && z !== null) return prev
      try {
        const vp = prev.host.querySelector<HTMLElement>('[data-testid^="graph-viewport-"]')
        const surf = prev.host.querySelector<HTMLElement>('[data-testid^="graph-surface-"]')
        const prevScale = Number(surf?.getAttribute('data-graph-scale')) || 1
        if (vp && prevScale > 0) {
          const cxLogical = (vp.scrollLeft + vp.clientWidth / 2) / prevScale
          const cyLogical = (vp.scrollTop + vp.clientHeight / 2) / prevScale
          const host = prev.host
          requestAnimationFrame(() => {
            try {
              const v = host.querySelector<HTMLElement>('[data-testid^="graph-viewport-"]')
              const s = host.querySelector<HTMLElement>('[data-testid^="graph-surface-"]')
              if (!v || !s) return
              const nextScale = Number(s.getAttribute('data-graph-scale')) || prevScale
              if (z === null) {
                v.scrollTo(0, 0)
                return
              }
              const maxLeft = Math.max(0, v.scrollWidth - v.clientWidth)
              const maxTop = Math.max(0, v.scrollHeight - v.clientHeight)
              const nl = Math.min(maxLeft, Math.max(0, cxLogical * nextScale - v.clientWidth / 2))
              const nt = Math.min(maxTop, Math.max(0, cyLogical * nextScale - v.clientHeight / 2))
              v.scrollTo(nl, nt)
            } catch { /* ignore */ }
          })
        } else if (vp && z === null) {
          const v = vp
          requestAnimationFrame(() => { try { v.scrollTo(0, 0) } catch { /* ignore */ } })
        }
      } catch { /* ignore */ }
      return { ...prev, zoom: z }
    })
  }, [])

  const notifyRoute = useCallback((pageKey: string, datasetId: string | null) => {
    const prev = currentPage.current
    currentPage.current = { pageKey, datasetId }
    // 登録済み entry の route 照合を現在のページへ追従させる。
    for (const [id, entry] of registry.current) {
      registry.current.set(id, {
        ...entry,
        pageKey: entry.pageKey || pageKey,
        datasetId: entry.datasetId ?? datasetId,
      })
    }
    if (prev.pageKey !== pageKey || prev.datasetId !== datasetId) {
      // route/dataset 変更：session と保留中の開始要求を破棄する。
      pendingRef.current.clear()
      setSession((s) => {
        closeSession(s)
        return null
      })
    }
  }, [closeSession])

  const getPopupContainer = useCallback(() => popupRef.current ?? document.body, [])

  // host 移動：所有 host だけを通常 slot と共通 dialog 間で移す。
  // appendChild 自体が元の親から切り離して移動させるため、removeChild は使わない。
  // jsdom の dialog は showModal 未対応のため、open 属性で代用する。
  // antd Modal 内の host も dock へ移動する。移動しないと dialog が空になる。
  useLayoutEffect(() => {
    const dock = dockRef.current
    const dlg = dialogRef.current
    if (!dock || !dlg) return
    const dialogOpen = dlg.open || dlg.hasAttribute('open')
    if (session) {
      if (session.host.parentElement !== dock) {
        try { dock.appendChild(session.host) } catch { /* ignore */ }
      }
      if (!dialogOpen) {
        try {
          if (typeof dlg.showModal === 'function') dlg.showModal()
          else dlg.setAttribute('open', '')
        } catch {
          try { dlg.setAttribute('open', '') } catch { /* ignore */ }
        }
      }
      // 戻すボタンへ focus。
      const exit = dlg.querySelector<HTMLElement>('[data-testid="graph-expansion-exit"]')
      try { exit?.focus() } catch { /* ignore */ }
    } else if (dialogOpen) {
      try {
        if (typeof dlg.close === 'function' && dlg.open) dlg.close()
        else dlg.removeAttribute('open')
      } catch {
        try { dlg.removeAttribute('open') } catch { /* ignore */ }
      }
    }
  }, [session])

  const value = useMemo<GraphExpansionValue>(() => ({
    session, register, unregister, updateEntry, open, openWhenAvailable,
    close, setZoom, notifyRoute, getPopupContainer,
  }), [session, register, unregister, updateEntry, open, openWhenAvailable, close, setZoom, notifyRoute, getPopupContainer])

  return (
    <GraphExpansionContext.Provider value={value}>
      {children}
      <dialog
        ref={dialogRef}
        aria-label={session?.title ?? 'グラフ拡大表示'}
        data-testid="graph-expansion-dialog"
        style={{ padding: 0, border: 'none', width: '96vw', height: '92vh', maxWidth: '96vw', maxHeight: '92vh' }}
      >
        <div
          data-testid="graph-expansion-body"
          style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#fff' }}
        >
          <GraphExpansionBar />
          <div ref={dockRef} data-testid="graph-expansion-dock" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }} />
          <div ref={popupRef} data-testid="graph-expansion-popup" style={{ position: 'static', width: 0, height: 0, overflow: 'visible' }} />
        </div>
      </dialog>
    </GraphExpansionContext.Provider>
  )
}

export function useGraphExpansion(): GraphExpansionValue {
  return useContext(GraphExpansionContext)
}

function GraphExpansionBar() {
  const { session, close, setZoom, getPopupContainer } = useGraphExpansion()
  if (!session) return null
  const zoom = session.zoom
  const stepIndex = zoom === null ? -1 : (GRAPH_ZOOM_STEPS as readonly number[]).indexOf(zoom)
  const stepTo = (next: GraphZoom) => setZoom(next)
  return (
    <div
      data-testid="graph-expansion-bar"
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
        borderBottom: '1px solid #d9d9d9', background: '#fff', flexWrap: 'wrap', flexShrink: 0,
      }}
    >
      <Button size="small" icon={<FullscreenExitOutlined />} data-testid="graph-expansion-exit" onClick={close} aria-label="拡大を戻す">
        戻す
      </Button>
      <Typography.Text strong style={{ fontSize: 12 }} data-testid="graph-expansion-title">{session.title}</Typography.Text>
      <Space size={4}>
        <Button
          size="small" icon={<OneToOneOutlined />} data-testid="graph-expansion-fit"
          type={zoom === null ? 'primary' : 'default'} onClick={() => stepTo(null)} aria-label="フィット"
        >
          フィット
        </Button>
        <Button
          size="small" icon={<ZoomOutOutlined />} data-testid="graph-expansion-zoom-out" aria-label="縮小"
          disabled={stepIndex === 0}
          // R035-03: フィット（stepIndex=-1）からの「－」は 75%（index 1）。
          // 従来は index 0 の 50%へ飛んでいた。
          onClick={() => stepTo(GRAPH_ZOOM_STEPS[Math.max(0, stepIndex < 0 ? 1 : stepIndex - 1)])}
        />
        <Typography.Text data-testid="graph-expansion-zoom-label" style={{ fontSize: 12, minWidth: 44, textAlign: 'center' }}>
          {zoom === null ? 'フィット' : `${Math.round(zoom * 100)}%`}
        </Typography.Text>
        <Button
          size="small" icon={<ZoomInOutlined />} data-testid="graph-expansion-zoom-in" aria-label="拡大"
          disabled={stepIndex >= GRAPH_ZOOM_STEPS.length - 1}
          onClick={() => stepTo(GRAPH_ZOOM_STEPS[Math.min(GRAPH_ZOOM_STEPS.length - 1, stepIndex < 0 ? 3 : stepIndex + 1)])}
        />
      </Space>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
        <PointerSelectionDropdown
          testId="graph-expansion-selection"
          getPopupContainer={getPopupContainer}
          includeSelectionActions
          showSelectionCount
          showPcpHitMode={session.graphId === 'pcp/main'}
        />
      </div>
    </div>
  )
}

export function GraphExpandButton({ graphId, title, label = '拡大表示' }: {
  graphId: string; title?: string; label?: string
}) {
  const { session, open } = useGraphExpansion()
  // 拡大中は起点ボタンを隠す（host が dock へ移動するため元の位置に残さない）。
  // F005-03 の focus 復帰は DOM 参照ではなく graphId からの再解決で行う。
  if (session) return null
  return (
    <Button
      size="small"
      icon={<FullscreenOutlined />}
      data-testid={`graph-expand-${graphId}`}
      data-graph-origin={graphId}
      aria-label={`${title ?? label}を拡大表示`}
      onClick={(e) => { try { (e.currentTarget as HTMLElement).focus() } catch { /* ignore */ }; open(graphId) }}
    >
      {label}
    </Button>
  )
}
