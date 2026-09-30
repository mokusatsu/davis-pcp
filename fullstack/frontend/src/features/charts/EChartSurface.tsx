import { useGraphViewport } from '../common/GraphPanel'
import { Children, Fragment, forwardRef, isValidElement, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type SVGProps } from 'react'
import { graphic, type EChartsOption } from 'echarts'
import { createFromString } from 'zrender/lib/tool/path.js'
import EChart from './EChart'
import { ReactReduxContext } from 'react-redux'

// GraphicComponent has no built-in SVG path shape (custom series does). Register
// one reusable zrender shape rather than leaking one shape class per frame/path.
const StatisticalPath = graphic.extendShape({
  shape: { pathData: '' },
  buildPath(context: any, shape: any) {
    const path = createFromString(shape.pathData || '')
    path.buildPath(context, path.shape)
  },
})
graphic.registerShape('davisStatisticalPath', StatisticalPath)

function textContent(node: ReactNode, includeTitle = false): string {
  return Children.toArray(node).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    if (!isValidElement<{ children?: ReactNode }>(child) || (!includeTitle && child.type === 'title')) return ''
    return textContent(child.props.children, includeTitle)
  }).join('')
}

/** Declarative, data-only geometry for nonstandard statistical charts. These JSX
 * shapes are never mounted as SVG: ECharts/zrender owns drawing and hit testing.
 * Keeping the original geometry preserves linkage distances, confidence bounds,
 * categorical strips and existing selection membership exactly. */
export function geometryToGraphic(children: ReactNode, eventBridge: (handler: Function, event: any) => void = (handler, event) => handler(event), questions: Record<string, string> = {}, hitRadius = 12): any[] {
  const convert = (node: ReactNode, path: string, inherited: Record<string, unknown> = {}): any[] => {
    if (!isValidElement<Record<string, any>>(node)) return []
    const p = node.props
    if (node.type === Fragment || typeof node.type !== 'string') {
      const question = p.question ?? questions[p.nameOrId]
      return Children.toArray(p.children).flatMap((child, i) => convert(child, `${path}.${i}`, { ...inherited, ...(question ? { __davisTitle: `${p.nameOrId ?? ''} — ${question}` } : {}) }))
    }
    if (node.type === 'title' || node.type === 'desc') return []
    const sourceStyle = { ...inherited, ...p, ...p.style }
    const style: Record<string, any> = {
      fill: sourceStyle.fill === 'none' ? null : sourceStyle.fill ?? (node.type === 'text' ? '#333' : '#000'),
      stroke: sourceStyle.stroke === 'none' ? null : sourceStyle.stroke,
      lineWidth: Number(sourceStyle.strokeWidth ?? 1),
      opacity: sourceStyle.opacity ?? 1,
      fillOpacity: sourceStyle.fillOpacity,
      strokeOpacity: sourceStyle.strokeOpacity,
      lineCap: sourceStyle.strokeLinecap,
      lineJoin: sourceStyle.strokeLinejoin,
    }
    if (sourceStyle.strokeDasharray) style.lineDash = String(sourceStyle.strokeDasharray).split(/[ ,]+/).map(Number)
    const item: any = { id: path, type: node.type, style, cursor: p.style?.cursor,
      silent: sourceStyle.pointerEvents === 'none', name: p['data-testid'] ?? path }
    const title = Children.toArray(p.children).find(child => isValidElement(child) && child.type === 'title') as any
    if (title) item.tooltip = { formatter: () => textContent(title.props.children, true), renderMode: 'richText', confine: true }
    const handlers: Record<string, string> = { onClick: 'onclick', onDoubleClick: 'ondblclick', onMouseEnter: 'onmouseover', onMouseLeave: 'onmouseout', onMouseMove: 'onmousemove', onMouseDown: 'onmousedown', onMouseUp: 'onmouseup' }
    for (const [reactName, zrName] of Object.entries(handlers)) if (p[reactName]) item[zrName] = (event: any) => eventBridge(p[reactName], event)
    item.info = { selectable: Boolean(p.onClick || p['data-selectable']), title: title ? textContent(title.props.children, true) : sourceStyle.__davisTitle }
    switch (node.type) {
      case 'g':
        item.type = 'group'; delete item.style
        item.children = Children.toArray(p.children).flatMap((child, i) => convert(child, `${path}.${i}`, {
          fill: sourceStyle.fill, stroke: sourceStyle.stroke, strokeWidth: sourceStyle.strokeWidth,
          opacity: sourceStyle.opacity, fillOpacity: sourceStyle.fillOpacity, strokeOpacity: sourceStyle.strokeOpacity, fontFamily: sourceStyle.fontFamily, fontSize: sourceStyle.fontSize, fontWeight: sourceStyle.fontWeight,
          pointerEvents: sourceStyle.pointerEvents, __davisTitle: sourceStyle.__davisTitle,
        }))
        break
      case 'rect': item.shape = { x: +p.x || 0, y: +p.y || 0, width: Math.max(0, +p.width || 0), height: Math.max(0, +p.height || 0), r: +p.rx || 0 }; break
      case 'circle': item.shape = { cx: +p.cx || 0, cy: +p.cy || 0, r: +p.r || 0 }; break
      case 'ellipse': item.shape = { cx: +p.cx || 0, cy: +p.cy || 0, rx: +p.rx || 0, ry: +p.ry || 0 }; break
      case 'line': item.shape = { x1: +p.x1 || 0, y1: +p.y1 || 0, x2: +p.x2 || 0, y2: +p.y2 || 0 }; item.style.fill = null; break
      case 'path': item.type = 'davisStatisticalPath'; item.shape = { pathData: p.d ?? '' }; break
      case 'polygon': case 'polyline': item.shape = { points: String(p.points ?? '').trim().split(/\s+/).map(pair => pair.split(',').map(Number)) }; break
      case 'text':
        item.style = { ...style, text: textContent(p.children),
          x: +p.x || 0, y: +p.y || 0,
          fontSize: Number(sourceStyle.fontSize ?? 12), fontFamily: sourceStyle.fontFamily ?? 'sans-serif',
          fontWeight: sourceStyle.fontWeight ?? 'normal',
          align: sourceStyle.textAnchor === 'middle' ? 'center' : sourceStyle.textAnchor === 'end' ? 'right' : 'left',
          verticalAlign: sourceStyle.dominantBaseline === 'middle' ? 'middle' : 'bottom' }
        break
      default: throw new Error(`Unsupported statistical geometry: ${node.type}`)
    }
    if (p.transform) {
      for (const match of String(p.transform).matchAll(/(translate|rotate|scale)\(([^)]+)\)/g)) {
        const values = match[2].split(/[ ,]+/).map(Number)
        if (match[1] === 'translate') { item.x = values[0]; item.y = values[1] ?? 0 }
        if (match[1] === 'scale') { item.scaleX = values[0]; item.scaleY = values[1] ?? values[0] }
        if (match[1] === 'rotate') { item.rotation = -values[0] * Math.PI / 180; item.originX = values[1] ?? 0; item.originY = values[2] ?? 0 }
      }
    }
    if (node.type === 'circle' && p.onClick && item.shape.r < hitRadius) {
      const visible = { ...item, id: `${path}.visible`, silent: true }
      for (const name of Object.values(handlers)) delete visible[name]
      return [{ type: 'group', id: `${path}.hit-group`, children: [visible,
        { ...item, shape: { ...item.shape, r: hitRadius }, style: { fill: 'rgba(0,0,0,0)', stroke: null } }] }]
    }
    return [item]
  }
  return Children.toArray(children).flatMap((child, i) => convert(child, String(i)))
}

type Props = SVGProps<SVGSVGElement> & { 'data-testid'?: string; onViewportChange?: () => void }
const EChartSurface = forwardRef<SVGSVGElement, Props>(function EChartSurface({ children, viewBox, width, height, style, onViewportChange, ...props }, forwardedRef) {
  const viewportKey=JSON.stringify(useGraphViewport())
  const previousViewport=useRef(viewportKey)
  const onViewportChangeRef=useRef(onViewportChange);onViewportChangeRef.current=onViewportChange
  useEffect(()=>{if(previousViewport.current!==viewportKey){previousViewport.current=viewportKey;onViewportChangeRef.current?.()}},[viewportKey])
  const redux = useContext(ReactReduxContext)
  const definitions = useSyncExternalStore(redux?.store.subscribe ?? (() => () => {}), () => redux?.store.getState().codebook?.columns)
  const questions = useMemo<Record<string, string>>(() => Object.fromEntries((definitions ?? []).flatMap((column: any) => [[column.name, column.label], [column.columnId, column.label]])), [definitions])
  const host = useRef<HTMLDivElement>(null)
  const chart = useRef<any>(null)
  const svg = useRef<SVGSVGElement>(null)
  const vb = viewBox?.split(/[ ,]+/).map(Number)
  const logicalWidth = vb?.[2] || (typeof width === 'number' ? width : Number(width)) || 600
  const logicalHeight = vb?.[3] || (typeof height === 'number' ? height : Number(height)) || 400
  const [size, setSize] = useState({ width: logicalWidth, height: logicalHeight })
  const [tip, setTip] = useState<string | null>(null)
  const [keyboardIndex, setKeyboardIndex] = useState(0)
  useEffect(() => {
    const node = host.current
    if (!node) return
    const update = () => { if (node.clientWidth && node.clientHeight) setSize({ width: node.clientWidth, height: node.clientHeight }) }
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    observer?.observe(node); update()
    return () => observer?.disconnect()
  }, [])
  const transferRef = () => {
    const element = host.current?.querySelector('svg') ?? null
    if (element) {
      element.dataset.logicalWidth = String(logicalWidth)
      element.dataset.logicalHeight = String(logicalHeight)
      element.dataset.logicalAspect = props.preserveAspectRatio === 'none' ? 'none' : 'meet'
    }
    if (typeof forwardedRef === 'function') forwardedRef(element)
    else if (forwardedRef) forwardedRef.current = element
  }
  const transferLatest = useRef(transferRef); transferLatest.current = transferRef
  useEffect(transferRef, [size, children, logicalWidth, logicalHeight, forwardedRef])
  useEffect(() => () => {
    if (typeof forwardedRef === 'function') forwardedRef(null)
    else if (forwardedRef) forwardedRef.current = null
  }, [forwardedRef])
  const eventBridge = (handler: Function, event: any) => {
    const native = event.event ?? event
    handler(new Proxy(native, { get: (target, key) => key === 'currentTarget' ? svg.current
      : key === 'stopPropagation' ? () => { event.cancelBubble = true; native.stopPropagation?.() }
      : typeof target[key] === 'function' ? target[key].bind(target) : target[key] }))
  }
  const accessibilityMarks = useMemo(() => {
    const all = geometryToGraphic(children, eventBridge, questions)
    const entries: any[] = []
    const walk = (items: any[], parentClick?: Function) => items.forEach(item => {
      const click = item.onclick ?? parentClick
      if (!item.silent && item.info?.title) entries.push({ ...item, onclick: click })
      else if (item.onclick && !item.children?.length) entries.push(item)
      if (item.children) walk(item.children, click)
    })
    walk(all)
    return entries
  }, [children, questions])
  const keyboardMark = accessibilityMarks[Math.min(keyboardIndex, accessibilityMarks.length - 1)]
  const option = useMemo<EChartsOption>(() => {
    const sx = size.width / logicalWidth, sy = size.height / logicalHeight
    const scale = Math.min(sx, sy)
    const stretch = props.preserveAspectRatio === 'none'
    return { tooltip: { show: true, confine: true, renderMode: 'richText' }, graphic: [{ type: 'group', id: 'statistical-geometry',
      x: stretch ? 0 : (size.width - logicalWidth * scale) / 2,
      y: stretch ? 0 : (size.height - logicalHeight * scale) / 2,
      scaleX: stretch ? sx : scale, scaleY: stretch ? sy : scale,
      children: geometryToGraphic(children, eventBridge, questions, 12 / Math.max(scale, .01)),
    }] } as EChartsOption
  }, [children, size, logicalWidth, logicalHeight, props.preserveAspectRatio, questions])
  const mouseHandler = (key: keyof Props) => (event: any) => {
    const handler = (props as Props)[key] as Function | undefined
    if (!handler) return
    const rect = host.current?.getBoundingClientRect()
    if ((key === 'onPointerDown' || key === 'onMouseDown') && rect) {
      let target = chart.current?.getZr().findHover((event.clientX - rect.left) * chart.current.getWidth() / rect.width, (event.clientY - rect.top) * chart.current.getHeight() / rect.height).target
      while (target) { if (target.onclick) return; target = target.parent }
    }
    handler(new Proxy(event, { get: (target, name) => name === 'currentTarget' ? svg.current : typeof target[name] === 'function' ? target[name].bind(target) : target[name] }))
  }
  const autoHeight = style?.height === 'auto' || (!height && !style?.height)
  return <div ref={host} tabIndex={0} aria-label={`${props['aria-label'] ?? props['data-testid'] ?? '統計グラフ'}。矢印キーでマークを移動、Enterで選択`}
    onFocus={() => setTip(keyboardMark?.info?.title ?? null)} onBlur={() => setTip(null)}
    onKeyDown={event => {
      if (event.key.startsWith('Arrow') && accessibilityMarks.length) {
        event.preventDefault()
        const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
        const index = (keyboardIndex + direction + accessibilityMarks.length) % accessibilityMarks.length
        setKeyboardIndex(index); setTip(accessibilityMarks[index].info?.title ?? null)
        accessibilityMarks[index].onmouseover?.({ event: event.nativeEvent })
      } else if ((event.key === 'Enter' || event.key === ' ') && keyboardMark?.onclick) { event.preventDefault(); keyboardMark.onclick({ event: event.nativeEvent }) }
      else if (event.key === 'Escape') setTip(null)
    }} data-testid={props['data-testid']} data-chart-renderer="echarts-graphic"
    style={{ width: width ?? '100%', height: autoHeight ? undefined : height ?? logicalHeight, aspectRatio: autoHeight ? `${logicalWidth} / ${logicalHeight}` : undefined,
      position: 'relative', userSelect: 'none', ...style, ...(autoHeight ? { height: undefined } : {}) }}
    onPointerDown={mouseHandler('onPointerDown')} onPointerMove={mouseHandler('onPointerMove')} onPointerUp={mouseHandler('onPointerUp')}
    onPointerCancel={mouseHandler('onPointerCancel')} onLostPointerCapture={mouseHandler('onLostPointerCapture')} onContextMenu={mouseHandler('onContextMenu')} onPointerLeave={mouseHandler('onPointerLeave')}
    onMouseDown={mouseHandler('onMouseDown')} onMouseMove={mouseHandler('onMouseMove')} onMouseUp={mouseHandler('onMouseUp')}
    onMouseLeave={() => setTip(null)}>
    <EChart option={option} height="100%" chartRef={chart} svgRef={svg} ariaLabel={props['aria-label'] ?? props['data-testid'] ?? '統計グラフ'}
      onReady={instance => { instance.on('finished', () => transferLatest.current()); instance.on('mouseover', (event: any) => setTip(event.info?.title ?? null)) }} style={{ minHeight: 0 }} />
    {tip && <div role="tooltip" aria-live="polite" style={{ position: 'absolute', left: 12, bottom: 4, pointerEvents: 'none', background: '#fff', border: '1px solid #ddd', padding: 6, fontSize: 12, maxWidth: '95%', whiteSpace: 'pre-wrap', zIndex: 10 }}>{tip}</div>}
  </div>
})
export default EChartSurface
