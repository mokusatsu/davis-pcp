import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Space, Typography } from 'antd'
import {
  FullscreenOutlined, FullscreenExitOutlined, ZoomInOutlined, ZoomOutOutlined, OneToOneOutlined,
} from '@ant-design/icons'

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

  useEffect(() => {
    if (!focused) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        exit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focused, exit])

  if (!focused) return null
  const stepIndex = zoom === null ? -1 : ZOOM_STEPS.indexOf(zoom)

  return (
    <div
      data-testid="focus-bar"
      style={{
        position: 'fixed', top: 8, right: 16, zIndex: 2000,
        background: '#fff', border: '1px solid #d9d9d9', borderRadius: 8,
        boxShadow: '0 2px 10px rgba(0,0,0,.15)', padding: '4px 8px',
        display: 'flex', alignItems: 'center',
      }}
    >
      <Space size="small">
        {title && (
          <Typography.Text strong style={{ fontSize: 12, marginRight: 2 }} data-testid="focus-title">
            {title}
          </Typography.Text>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>拡大表示</Typography.Text>
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
        <Typography.Text data-testid="focus-zoom-label" style={{ fontSize: 12, minWidth: 44, textAlign: 'center' }}>
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
      </Space>
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
