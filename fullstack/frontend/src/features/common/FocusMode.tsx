import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Divider, Typography } from 'antd'
import {
  FullscreenOutlined, FullscreenExitOutlined, ZoomInOutlined, ZoomOutOutlined, OneToOneOutlined, ClearOutlined,
  AimOutlined, DeleteOutlined, ReloadOutlined, HolderOutlined,
} from '@ant-design/icons'
import { useDispatch, useSelector } from 'react-redux'
import type { RootState } from '../../app/store'
import { selectionCleared, focusSelected, deleteSelected, resetWorkingSet } from '../../app/store'
import PointerSelectionDropdown from '../selection/PointerSelectionDropdown'

/** Focus (fullscreen chart) mode context.
 *  Supports single-chart pages (PCP, Distribution) as well as multi-chart pages
 *  (Relationships, Clusters, Models, Statistics) with targetId routing.
 *  When focused, AppShell hides header/sidebar so the active chart fills the screen. */
export interface FocusModeValue {
  focused: boolean
  targetId: string | null
  title: string | null
  zoom: number | null // null = fit-to-screen
  enter: (targetId?: string, title?: string) => void
  exit: () => void
  setZoom: (z: number | null) => void
  isTargetActive: (id?: string) => boolean
}

const FocusContext = createContext<FocusModeValue>({
  focused: false,
  targetId: null,
  title: null,
  zoom: null,
  enter: () => undefined,
  exit: () => undefined,
  setZoom: () => undefined,
  isTargetActive: () => false,
})

export function FocusModeProvider({ children }: { children: ReactNode }) {
  const [focused, setFocused] = useState(false)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [title, setTitle] = useState<string | null>(null)
  const [zoom, setZoomState] = useState<number | null>(null)

  const enter = useCallback((target?: string, targetTitle?: string) => {
    setFocused(true)
    setTargetId(target ?? null)
    setTitle(targetTitle ?? null)
    setZoomState(null)
  }, [])

  const exit = useCallback(() => {
    setFocused(false)
    setTargetId(null)
    setTitle(null)
    setZoomState(null)
  }, [])

  const setZoom = useCallback((z: number | null) => setZoomState(z), [])

  const isTargetActive = useCallback((id?: string) => {
    if (!focused) return false
    // If no targetId was specified on enter, or if target matches id, it is active
    if (targetId === null) return true
    return targetId === id
  }, [focused, targetId])

  const value = useMemo(() => ({
    focused,
    targetId,
    title,
    zoom,
    enter,
    exit,
    setZoom,
    isTargetActive,
  }), [focused, targetId, title, zoom, enter, exit, setZoom, isTargetActive])

  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>
}

export function useFocusMode(): FocusModeValue {
  return useContext(FocusContext)
}

export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

export interface FocusTargetProps {
  id?: string
  title?: string
  children: ReactNode
  className?: string
  style?: React.CSSProperties
}

/** Wraps a chart.
 *  In fit mode the chart renders as-is (its own responsive sizing fills the screen);
 *  At a magnification the inner wrapper's layout box grows to scale× the viewport
 *  in BOTH axes, so responsive children actually render larger and the outer surface
 *  scrolls symmetrically to reach every part.
 *  When another target on the same page is focused, this target renders null. */
export function FocusTarget({ id, children, className, style }: FocusTargetProps) {
  const { focused, zoom, isTargetActive } = useFocusMode()

  // If focus mode is active and this target is not the focused one, hide it
  if (focused && !isTargetActive(id)) {
    return null
  }

  // Normal mode: render as-is
  if (!focused) {
    return <>{children}</>
  }

  // Focus mode: Fit (zoom === null)
  if (zoom === null) {
    return (
      <div
        data-testid="focus-target-active"
        data-focus-target={id}
        className={`focus-target-active focus-target-fit ${className ?? ''}`}
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          ...style,
        }}
      >
        {children}
      </div>
    )
  }

  // Focus mode: Zoomed (zoom !== null)
  const scale = zoom
  return (
    <div
      data-testid="focus-target-active"
      data-focus-target={id}
      className={`focus-target-active focus-target-zoomed ${className ?? ''}`}
      style={{
        overflow: 'auto',
        width: '100%',
        height: '100%',
        flex: 1,
        minHeight: 0,
        ...style,
      }}
    >
      <div
        data-testid="focus-scaled"
        style={{
          width: `${100 * scale}%`,
          height: `${100 * scale}%`,
          minWidth: '100%',
          minHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>
    </div>
  )
}

/** Toolbar shown when focus mode is active (fixed overlay). */
export function FocusBar() {
  const { focused, title, zoom, exit, setZoom } = useFocusMode()
  const dispatch = useDispatch()
  const selectedCount = useSelector((s: RootState) => s.selection.selectedRowIds.length)

  const barRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  // Drag tracking state
  const dragInfo = useRef<{
    startX: number
    startY: number
    initialBarX: number
    initialBarY: number
  } | null>(null)

  useEffect(() => {
    if (!focused) {
      setPosition(null)
      return
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        exit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focused, exit])

  // Handle pointer down on the bar (or drag handle)
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement | null
    // Avoid dragging when clicking on buttons, selects, dropdowns, inputs, etc.
    if (target?.closest('button, input, select, a, .ant-select, .ant-dropdown, .ant-btn')) {
      return
    }

    const barEl = barRef.current
    if (!barEl) return

    const rect = barEl.getBoundingClientRect()
    dragInfo.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialBarX: rect.left,
      initialBarY: rect.top,
    }
    setIsDragging(true)

    const onMove = (moveEvt: MouseEvent | PointerEvent) => {
      if (!dragInfo.current || !barRef.current) return
      const dx = moveEvt.clientX - dragInfo.current.startX
      const dy = moveEvt.clientY - dragInfo.current.startY

      const barRect = barRef.current.getBoundingClientRect()
      const barWidth = barRect.width
      const barHeight = barRect.height

      const margin = 8
      let newX = dragInfo.current.initialBarX + dx
      let newY = dragInfo.current.initialBarY + dy

      // Clamp within viewport
      newX = Math.max(margin, Math.min(window.innerWidth - barWidth - margin, newX))
      newY = Math.max(margin, Math.min(window.innerHeight - barHeight - margin, newY))

      setPosition({ x: newX, y: newY })
    }

    const onUp = () => {
      dragInfo.current = null
      setIsDragging(false)
      window.removeEventListener('pointermove', onMove as EventListener)
      window.removeEventListener('mousemove', onMove as EventListener)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }

    window.addEventListener('pointermove', onMove as EventListener)
    window.addEventListener('mousemove', onMove as EventListener)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Reset to default top-right position on double-click
  const handleResetPosition = () => {
    setPosition(null)
  }

  if (!focused) return null
  const stepIndex = zoom === null ? -1 : ZOOM_STEPS.indexOf(zoom)

  return (
    <div
      ref={barRef}
      data-testid="focus-bar"
      onPointerDown={handlePointerDown}
      onMouseDown={handlePointerDown}
      style={{
        position: 'fixed',
        top: position ? position.y : 8,
        left: position ? position.x : undefined,
        right: position ? undefined : 16,
        zIndex: 2000,
        background: '#fff',
        border: '1px solid #d9d9d9',
        borderRadius: 8,
        boxShadow: isDragging
          ? '0 6px 18px rgba(0,0,0,.25)'
          : '0 2px 10px rgba(0,0,0,.15)',
        padding: '4px 8px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: 'calc(100vw - 32px)',
        cursor: isDragging ? 'grabbing' : 'default',
        userSelect: isDragging ? 'none' : 'auto',
        transition: isDragging ? 'none' : 'box-shadow 0.2s',
      }}
    >
      {/* 左端・上下中央のドラッグハンドル */}
      <span
        data-testid="focus-drag-handle"
        title="ドラッグして移動（ダブルクリックで初期位置に戻す）"
        onDoubleClick={handleResetPosition}
        style={{
          cursor: isDragging ? 'grabbing' : 'grab',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#8c8c8c',
          padding: '2px 4px',
          borderRadius: 4,
          flexShrink: 0,
        }}
      >
        <HolderOutlined style={{ fontSize: 16 }} />
      </span>

      {/* 操作コンテンツ（通常時は1行、詰まった場合は2行折り返し） */}
      <div
        data-testid="focus-bar-content"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '4px 8px',
        }}
      >
        {/* 選択操作グループ */}
        <div
          data-testid="focus-bar-selection"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            flexWrap: 'nowrap',
          }}
        >
          {title && (
            <Typography.Text
              strong
              style={{ fontSize: 12, marginRight: 4, cursor: isDragging ? 'grabbing' : 'grab' }}
              data-testid="focus-title"
            >
              {title}
            </Typography.Text>
          )}
        <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          選択: {selectedCount}行
        </Typography.Text>
        <PointerSelectionDropdown buttonSize="small" testId="focus-pointer-selection" />
        <Button
          size="small"
          icon={<ClearOutlined />}
          disabled={selectedCount === 0}
          onClick={() => dispatch(selectionCleared())}
          title="選択解除"
          data-testid="focus-clear-selection"
        >
          解除
        </Button>
        <Button
          size="small"
          icon={<AimOutlined />}
          disabled={selectedCount === 0}
          onClick={() => dispatch(focusSelected())}
          title="選択行のみに絞り込み"
          data-testid="focus-focus-selection"
        >
          Focus
        </Button>
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          disabled={selectedCount === 0}
          onClick={() => dispatch(deleteSelected())}
          title="選択行を一時除外"
          data-testid="focus-delete-selection"
        >
          Delete
        </Button>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => dispatch(resetWorkingSet())}
          title="初期ベースデータに全復帰"
          data-testid="focus-reset-selection"
        >
          全復帰(Reset)
        </Button>
      </div>

      {/* 拡大表示操作グループ */}
      <div
        data-testid="focus-bar-zoom"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          flexWrap: 'nowrap',
        }}
      >
        <Divider type="vertical" style={{ margin: '0 4px' }} />
        <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          拡大表示
        </Typography.Text>
        <Button
          size="small"
          icon={<OneToOneOutlined />}
          type={zoom === null ? 'primary' : 'default'}
          data-testid="focus-fit"
          onClick={() => setZoom(null)}
        >
          フィット
        </Button>
        <Button
          size="small"
          icon={<ZoomOutOutlined />}
          data-testid="focus-zoom-out"
          disabled={stepIndex === 0}
          onClick={() => setZoom(ZOOM_STEPS[Math.max(0, stepIndex <= 0 ? 0 : stepIndex - 1)])}
        />
        <Typography.Text
          data-testid="focus-zoom-label"
          style={{ fontSize: 12, minWidth: 44, textAlign: 'center', whiteSpace: 'nowrap' }}
        >
          {zoom === null ? 'フィット' : `${Math.round(zoom * 100)}%`}
        </Typography.Text>
        <Button
          size="small"
          icon={<ZoomInOutlined />}
          data-testid="focus-zoom-in"
          disabled={stepIndex >= ZOOM_STEPS.length - 1}
          onClick={() => setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, stepIndex < 0 ? 2 : stepIndex + 1)])}
        />
        <Button
          size="small"
          icon={<FullscreenExitOutlined />}
          data-testid="focus-exit"
          onClick={exit}
        >
          戻す
        </Button>
      </div>
      </div>
    </div>
  )
}

/** The expand toggle button. */
export interface FocusEnterButtonProps {
  targetId?: string
  title?: string
  label?: string
  size?: 'small' | 'middle'
  icon?: ReactNode
  type?: 'default' | 'primary' | 'text'
  style?: React.CSSProperties
}

export function FocusEnterButton({
  targetId,
  title,
  label = '拡大表示',
  size = 'small',
  icon = <FullscreenOutlined />,
  type = 'default',
  style,
}: FocusEnterButtonProps) {
  const { focused, enter } = useFocusMode()
  if (focused) return null
  return (
    <Button
      size={size}
      icon={icon}
      type={type}
      style={style}
      data-testid={targetId ? `focus-enter-${targetId}` : 'focus-enter'}
      data-focus-target={targetId}
      onClick={() => enter(targetId, title ?? label)}
      title={`${title ?? label}を全画面拡大`}
    >
      {label}
    </Button>
  )
}
