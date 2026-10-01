import {
  createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode,
} from 'react'
import { Typography } from 'antd'
import { GRAPH_ZOOM_STEPS, GraphExpandButton, useGraphExpansion } from './GraphExpansion'
import type { GraphZoom } from './GraphExpansion'

/**
 * Feature 035 GraphPanel。
 * 常設の描画 host、通常位置の slot、タイトル・拡大入口、
 * 固定構造の操作領域と描画面、寸法・倍率の提供を担う。
 *
 * 構造: host > [title行, controls, viewport > extent > surface, popup受け口]
 * 描画子は host 配下の surface に直接描画する（portal container 固定・
 * 描画子の複製なし）。拡大切替は所有 host だけを通常 slot と共通
 * dialog 間で移す。倍率・拡大状態で再マウントしない。
 */

export interface GraphPanelProps {
  graphId: string
  title: string
  /** 現在のタブ・ページ・結果で表示可能か。非表示の図へは開かない。 */
  available?: boolean
  sizing?: 'responsive' | 'intrinsic'
  /** intrinsic の場合のみ：軸・凡例を含む描画全体の論理幅・高さ。 */
  intrinsicSize?: { width: number; height: number }
  /** 通常表示だけ親列幅へ追従させる。HTML のカード型グラフに限って指定する。 */
  normalWidth?: 'intrinsic' | 'viewport'
  /** 既存の軸切替・選択メニュー・図設定等。共通部は内容を解釈しない。 */
  controls?: ReactNode
  style?: CSSProperties
  children: ReactNode
}

export interface GraphViewport {
  logicalWidth: number
  logicalHeight: number
  scale: number
  zoom: GraphZoom
  dpr: number
  /** 寸法変更の通し番号。Canvas 再描画の合図に使う。 */
  revision: number
}

const GraphViewportContext = createContext<GraphViewport>({
  logicalWidth: 0, logicalHeight: 0, scale: 1, zoom: null, dpr: 1, revision: 0,
})
const GraphPanelScopeContext = createContext<string | null>(null)

/** GraphPanel 配下で論理寸法・実表示 scale・DPR・revision を取得する。 */
export function useGraphViewport(): GraphViewport {
  return useContext(GraphViewportContext)
}

/**
 * F004-02/R035-02: GraphPanel 内の Dropdown/Select/Tooltip 用 popup container。
 * 現在拡大している対象からの popup だけを開いた dialog 内受け口へ送り、
 * 通常表示（非拡大）では body へ戻す。閉じた dialog 配下へ生成すると
 * 通常時のメニューが不可視・操作不能になる回帰を防ぐ。
 */
export function useGraphPopupContainer(graphId?: string): () => HTMLElement {
  const scopedGraphId = useContext(GraphPanelScopeContext)
  const { session, getPopupContainer } = useGraphExpansion()
  const targetGraphId = graphId ?? scopedGraphId
  return () => {
    try {
      if (targetGraphId && session && session.graphId === targetGraphId) return getPopupContainer()
      return document.body
    } catch { return document.body }
  }
}

export default function GraphPanel({
  graphId, title, available = true, sizing = 'intrinsic', intrinsicSize, normalWidth = 'intrinsic', controls, style, children,
}: GraphPanelProps) {
  const { session, register, unregister, updateEntry } = useGraphExpansion()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const slotRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0, outerWidth: 0, outerHeight: 0 })
  const [dpr, setDpr] = useState(() => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1))
  const active = session?.graphId === graphId
  const zoom: GraphZoom = active ? session!.zoom : null

  const logical = useMemo(() => {
    if (sizing === 'responsive') {
      // 小数 viewport を四捨五入すると surface が実 content box を越え、
      // 縦SB出現→RO再計測→再描画の振動になるため、収まる整数寸法へ切り捨てる。
      return { width: Math.max(1, Math.floor(viewport.width)), height: Math.max(1, Math.floor(viewport.height)) }
    }
    return {
      width: Math.max(1, Math.round(intrinsicSize?.width ?? viewport.width ?? 1)),
      height: Math.max(1, Math.round(intrinsicSize?.height ?? viewport.height ?? 1)),
    }
  }, [sizing, intrinsicSize, viewport])

  // viewport 計測：同一フレーム内の更新をまとめ、非表示(0)は最後の有効寸法を保持。
  // F005-02: 寸法世代を data-revision として公開し、ドラッグ取消し判定に使う。
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let raf = 0
    const RO = ResizeObserver
    const ro = new RO((entries) => {
      const entry = entries[0]
      const rect = entry?.contentRect
      if (!rect) return
      // Fit must use the space allocated by the parent, not the content box
      // reduced by our own scrollbars. Otherwise a caption/margin overflowing
      // an intrinsic-size estimate can make Fit repeatedly shrink enough to
      // remove a scrollbar and then grow enough to bring it straight back.
      // The viewport has no border/padding, so its border box is that stable
      // allocation. Keep content-box dimensions separately for responsive PCP
      // and the actual visible scroll area.
      const box = entry.borderBoxSize?.[0]
      const outerWidth = box?.inlineSize ?? rect.width
      const outerHeight = box?.blockSize ?? rect.height
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        setViewport((prev) => {
          if (rect.width === 0 || rect.height === 0) return prev
          if (Math.floor(prev.width) === Math.floor(rect.width) && Math.floor(prev.height) === Math.floor(rect.height)
            && Math.floor(prev.outerWidth) === Math.floor(outerWidth) && Math.floor(prev.outerHeight) === Math.floor(outerHeight)) return prev
          return { width: rect.width, height: rect.height, outerWidth, outerHeight }
        })
      })
    })
    // Watch the box that drives layout: intrinsic Fit must still receive a
    // genuine outer resize even if a scrollbar change leaves the content box
    // unchanged. Normal cards and responsive PCP follow usable content space.
    ro.observe(el, { box: active && sizing === 'intrinsic' ? 'border-box' : 'content-box' })
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [active, sizing])

  // F005-02: 座標系世代 = 寸法・DPR・zoom の通し番号。リサイズ・DPR変更・
  // 倍率変更で変わり、ドラッグ開始時と確定時を比較して取消しを判定する。
  const coordGen = useMemo(
    () => `${Math.floor(viewport.width)}x${Math.floor(viewport.height)}/${Math.floor(viewport.outerWidth)}x${Math.floor(viewport.outerHeight)}@${dpr}x${zoom === null ? 'fit' : String(zoom)}`,
    [viewport.width, viewport.height, viewport.outerWidth, viewport.outerHeight, dpr, zoom],
  )

  useEffect(() => {
    const onResize = () => setDpr(window.devicePixelRatio || 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 登録は host 同一性で管理（StrictMode の setup/cleanup 再実行に耐える）。
  // pageKey/datasetId は AppShell からの notifyRoute が正本。host の data 属性は使わない。
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    register({
      graphId, title, host,
      slot: slotRef.current,
      available,
      pageKey: '',
      datasetId: null,
      originButton: document.querySelector<HTMLElement>(`[data-graph-origin="${graphId}"]`),
    })
    return () => unregister(graphId, host)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId])

  // available / title の変化を通知する。
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    updateEntry(graphId, host, {
      title, available,
      originButton: document.querySelector<HTMLElement>(`[data-graph-origin="${graphId}"]`),
    })
  }, [graphId, title, available, updateEntry])

  const fitScale = useMemo(() => {
    if (sizing === 'responsive') return 1
    if (!viewport.outerWidth || !viewport.outerHeight) return 1
    // Leave the fractional remainder unused, including for the scaled surface
    // itself. A 598.59px allocation must never produce a 599px fitted extent.
    // Use the stable outer box above; actual overflowing children and manual
    // zoom can still create scrollbars without those scrollbars changing Fit.
    return Math.min(Math.max(1, Math.floor(viewport.outerWidth)) / logical.width,
      Math.max(1, Math.floor(viewport.outerHeight)) / logical.height)
  }, [sizing, viewport, logical])

  const z = zoom ?? 1
  // 通常表示は既存の論理寸法をそのまま使う。fit/zoom は拡大 dialog 内だけで
  // 適用し、通常時の ResizeObserver とスクロール範囲の循環を作らない。
  // responsive も拡大中にだけ共通倍率を surface へ一度だけ適用する。
  const scale = active
    ? (sizing === 'responsive' ? z : fitScale * z)
    : 1
  // intrinsic の通常表示では、論理寸法を「最低限必要な描画寸法」として扱う。
  // Card、凡例、説明などが既存の描画子に同居している図は、その内容高まで
  // host を自然に伸ばして外側ページへ委譲する。viewport 内の二重スクロールを
  // 防ぎつつ、拡大時は従来どおり固定論理 surface とする。
  const normalIntrinsic = !active && sizing === 'intrinsic'
  // 通常の2列カードでは固定560pxより親列が狭くなることがある。HTMLカードだけ
  // 親列へ追従させ、拡大 dialog と座標を持つ描画面は固定論理幅を保つ。
  const normalSurfaceWidth = normalIntrinsic && normalWidth === 'viewport' && viewport.width > 0
    ? Math.max(1, Math.floor(viewport.width))
    : logical.width

  const extentStyle: CSSProperties = useMemo(() => {
    if (normalIntrinsic) {
      return {
        width: Math.max(Math.floor(viewport.width), normalSurfaceWidth),
        minHeight: logical.height,
      }
    }
    const scaledWidth = Math.round(logical.width * scale)
    const scaledHeight = Math.round(logical.height * scale)
    return {
      // An expanded intrinsic extent owns only the scaled chart dimensions.
      // A viewport-sized minimum would still feed scrollbar size back into
      // layout when a child's margin collapses outside this extent, even with
      // a stable Fit scale. Overflow stays visible and genuinely scrollable.
      width: sizing === 'intrinsic' ? scaledWidth : Math.max(Math.floor(viewport.width), scaledWidth),
      height: sizing === 'intrinsic' ? scaledHeight : Math.max(Math.floor(viewport.height), scaledHeight),
    }
  }, [sizing, viewport, logical, scale, normalIntrinsic, normalSurfaceWidth])

  const viewportValue = useMemo<GraphViewport>(() => ({
    logicalWidth: logical.width,
    logicalHeight: logical.height,
    scale, zoom, dpr,
    revision: Math.round(viewport.width) * 100000 + Math.round(viewport.height),
  }), [logical, scale, zoom, dpr, viewport])

  return (
    <div ref={slotRef} data-testid={`graph-slot-${graphId}`} data-graph-slot={graphId} className="graph-panel-slot">
      <div
        ref={hostRef}
        data-testid={`graph-host-${graphId}`}
      data-graph-host={graphId}
      className="graph-panel-host"
      style={style}
    >
      <GraphPanelScopeContext.Provider value={graphId}>
        <div className="graph-panel-title-row">
          <Typography.Text strong style={{ fontSize: 12 }}>{title}</Typography.Text>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
            {!active && available && <GraphExpandButton graphId={graphId} title={title} />}
          </span>
        </div>
        {controls && <div className="graph-panel-controls" data-testid={`graph-controls-${graphId}`}>{controls}</div>}
        <div ref={viewportRef} className="graph-panel-viewport" data-testid={`graph-viewport-${graphId}`} data-coord-gen={coordGen}>
          <div className="graph-panel-extent" data-testid={`graph-extent-${graphId}`} style={extentStyle}>
            <div
              className="graph-panel-surface"
              data-testid={`graph-surface-${graphId}`}
              data-graph-scale={scale}
              data-graph-zoom={zoom === null ? 'fit' : String(zoom)}
              data-graph-dpr={dpr}
              style={{
                width: normalSurfaceWidth,
                ...(normalIntrinsic
                  ? { minHeight: logical.height, height: 'auto' }
                  : { height: logical.height }),
                ...(scale === 1 ? {} : { transform: `scale(${scale})` }),
              }}
            >
              <GraphViewportContext.Provider value={viewportValue}>
                {children}
              </GraphViewportContext.Provider>
            </div>
          </div>
        </div>
        <div className="graph-panel-popup" data-testid={`graph-popup-${graphId}`} data-popup-for={graphId} />
      </GraphPanelScopeContext.Provider>
      </div>
    </div>
  )
}

export { GRAPH_ZOOM_STEPS }
export type { GraphZoom }
