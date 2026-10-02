import { CHART_MARKERS, pointDiameter, pointEmphasis, markerFitScale, fitPointSeries } from '../charts/markerStyle'
import { useGraphViewport, useGraphPopupContainer } from '../common/GraphPanel'
import { useEffect, useMemo, useRef, useState, type FC, type PointerEvent } from 'react'
import type { ECharts, EChartsOption } from 'echarts'
import { useDispatch, useSelector } from 'react-redux'
import { Dropdown } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { hovered, selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet } from '../../app/store'
import { useRowColorResolver } from '../../theme/useRowColor'
import { getBrushOp } from '../selection/SelectionMenu'
import { SELECTION_LABELS } from '../selection/selectionLabels'
import type { GeodesicEngine, ProjectionPoint } from './geodesicEngine'
import EChart from '../charts/EChart'

interface TgtCanvasProps {
  engine: GeodesicEngine
  rowIds: string[]
  dataMatrix: number[][]
  isPlaying: boolean
  isTracking: boolean
  onBasisUpdate: (alpha: number[], beta: number[]) => void
  isActive?: boolean
  onTogglePlay?: () => void
  onStep?: () => void
  onReset?: () => void
}
export interface TourPoint extends ProjectionPoint {
  color: string; selected: boolean; highlighted?: boolean; trails: {x:number;y:number}[]
}
/** The engine, not ECharts animation, remains authoritative for coordinates. */
export function tourOption(points: TourPoint[], width: number, height: number, selectionColor: string): EChartsOption {
  const scale = Math.max(1, Math.min(width-60,height-60)/6.5)
  const xmax = width/(2*scale), ymax = height/(2*scale)
  return { animation: false, backgroundColor: '#141414', grid:{left:0,right:0,top:0,bottom:0},
    xAxis:{type:'value',show:false,min:-xmax,max:xmax},yAxis:{type:'value',show:false,min:-ymax,max:ymax},
    tooltip:{renderMode:'richText',formatter:(p:any)=>p.data?.rowId ? `rowId: ${p.data.rowId}\nx: ${p.value[0]}\ny: ${p.value[1]}` : ''},
    graphic:[... [3,1.5].map((r,i)=>({id:`guide-${i}`,type:'circle' as const,silent:true,
      shape:{cx:width/2,cy:height/2,r:r*scale},style:{fill:'none',stroke:'#262626',lineWidth:1}})),
      {id:'cross-x',type:'line',silent:true,shape:{x1:width/2-3*scale,y1:height/2,x2:width/2+3*scale,y2:height/2},style:{stroke:'#333',lineDash:[3,3]}},
      {id:'cross-y',type:'line',silent:true,shape:{x1:width/2,y1:height/2-3*scale,x2:width/2,y2:height/2+3*scale},style:{stroke:'#333',lineDash:[3,3]}}],
    series:[{id:'tour-trails',type:'custom',silent:true,z:1,data:points.map((p,i)=>[p.x,p.y,i]),
      renderItem:(_params:any,api:any)=>{
        const p=points[Number(api.value(2))],children:any[]=[]
        for(let i=0;i<p.trails.length-1;i++) {
          const a=api.coord([p.trails[i].x,p.trails[i].y]),b=api.coord([p.trails[i+1].x,p.trails[i+1].y])
          children.push({type:'line',shape:{x1:a[0],y1:a[1],x2:b[0],y2:b[1]},
            style:{stroke:p.selected?selectionColor:p.color,lineWidth:p.selected?1.5:1,opacity:(i+1)/p.trails.length*.5}})
        }
        return {type:'group',children}
      }},
      {id:'tour-points',type:'scatter',z:3,data:points.map(p=>({id:p.rowId,rowId:p.rowId,value:[p.x,p.y],
        symbolSize:pointDiameter(p.selected,p.highlighted),emphasis:pointEmphasis(p.selected,p.highlighted),itemStyle:{color:p.selected?selectionColor:p.color,borderColor:p.highlighted?'#fa8c16':'#fff',borderWidth:p.selected||p.highlighted?2:.5,opacity:1}}))}],
  }
}
export const TgtCanvas: FC<TgtCanvasProps> = props => {
  const { engine, rowIds, dataMatrix, isPlaying, isTracking, isActive = true }=props
  const viewport = useGraphViewport()
  const viewportKey=JSON.stringify(viewport)
  const fitScale = markerFitScale(viewport)
  const getPopupContainer=useGraphPopupContainer()
  const dispatch=useDispatch<AppDispatch>(),selection=useSelector((s:RootState)=>s.selection)
  const colors=useRowColorResolver()
  const latest=useRef({props,colors,fitScale,hoveredRowId:selection.hoveredRowId});latest.current={props,colors,fitScale,hoveredRowId:selection.hoveredRowId}
  const containerRef=useRef<HTMLDivElement>(null),chartRef=useRef<ECharts|null>(null)
  const pointsRef=useRef<ProjectionPoint[]>([]),start=useRef<{x:number;y:number;clientX:number;clientY:number;pointerId:number;coordKey:string;pointId?:string}|null>(null)
  const lastProjection=useRef<{engine:GeodesicEngine;rowIds:string[];dataMatrix:number[][];basis:string}|null>(null)
  const [ready,setReady]=useState(false)
  const [keyboardDetail,setKeyboardDetail]=useState('')
  const keyboardRow=useRef<string|null>(null)
  const leaveKeyboard=()=>{
    if(keyboardRow.current!==null){keyboardRow.current=null;dispatch(hovered(null))}
    setKeyboardDetail('')
  }
  const announcePoint=(index:number)=>{
    const point=pointsRef.current[index]
    if(!point)return
    keyboardRow.current=point.rowId
    setKeyboardDetail(`rowId: ${point.rowId}, x: ${point.x}, y: ${point.y}`)
    dispatch(hovered(point.rowId))
  }
  useEffect(()=>{leaveKeyboard()},[rowIds,dataMatrix,isPlaying,isActive])
  useEffect(()=>()=>{if(keyboardRow.current!==null)dispatch(hovered(null))},[])
  const pausedBasisKey=isPlaying?'':JSON.stringify([engine.alpha,engine.beta])
  const baseOption=useMemo<EChartsOption>(()=>({animation:false,backgroundColor:'#141414'}),[])
  const clear=()=>{
    const drag=start.current
    start.current=null
    const element=containerRef.current
    if(drag && element?.hasPointerCapture?.(drag.pointerId))element.releasePointerCapture(drag.pointerId)
    const chart=chartRef.current
    if(chart && !chart.isDisposed())chart.setOption({graphic:[{id:'tour-brush',type:'rect',invisible:true,shape:{x:0,y:0,width:0,height:0}}]})
  }
  const draw=()=>{
    const chart=chartRef.current
    if(!chart || chart.isDisposed())return
    const {props:p,colors:c}=latest.current
    const points:TourPoint[]=pointsRef.current.map(q=>({...q,color:c.getColor(q.rowId),selected:c.isSelected(q.rowId),highlighted:q.rowId===latest.current.hoveredRowId,
      trails:p.isTracking?p.engine.getTrails(q.rowId):[]}))
    const option = tourOption(points,chart.getWidth(),chart.getHeight(),c.selectionColor)
    chart.setOption({...option,series:fitPointSeries(option.series,latest.current.fitScale)},{notMerge:false,lazyUpdate:false})
  }
  // One step/project per requested frame. Parent basis-label renders must not
  // advance or append trail history a second time.
  useEffect(()=>{
    if(!ready)return
    let id:number|undefined,cancelled=false
    const frame=()=>{
      if(cancelled)return
      if(isPlaying){engine.step();latest.current.props.onBasisUpdate([...engine.alpha],[...engine.beta])}
      const basis=JSON.stringify([engine.alpha,engine.beta]),previous=lastProjection.current
      // Pausing or toggling trail visibility is a redraw of the same frame,
      // not another history sample. Manual step/reset changes the basis.
      if(isPlaying || !previous || previous.engine!==engine || previous.rowIds!==rowIds || previous.dataMatrix!==dataMatrix || previous.basis!==basis){
        pointsRef.current=engine.project(rowIds,dataMatrix,latest.current.props.isTracking)
        lastProjection.current={engine,rowIds,dataMatrix,basis}
      }
      draw()
      if(isPlaying)id=requestAnimationFrame(frame)
    }
    frame()
    return ()=>{cancelled=true;if(id!==undefined)cancelAnimationFrame(id);clear()}
  },[ready,engine,rowIds,dataMatrix,isPlaying,pausedBasisKey])
  // Recolor and resize without mutating the projection/trail engine.
  useEffect(()=>{if(ready)draw()},[ready,isTracking,colors.getColor,colors.isSelected,colors.selectionColor,selection.hoveredRowId])
  useEffect(()=>{
    if(!ready||!containerRef.current||typeof ResizeObserver==='undefined')return
    const observer=new ResizeObserver(()=>{const chart=chartRef.current;if(chart&&!chart.isDisposed()){chart.resize();clear();draw()}})
    observer.observe(containerRef.current);return ()=>observer.disconnect()
  },[ready])
  const local=(e:PointerEvent<HTMLDivElement>)=>{
    const box=e.currentTarget.getBoundingClientRect(),c=chartRef.current
    if(!c||!box.width||!box.height)return null
    return {x:(e.clientX-box.left)*c.getWidth()/box.width,y:(e.clientY-box.top)*c.getHeight()/box.height}
  }
  useEffect(()=>{clear();draw()},[viewportKey])
  const nearestRow=(point:{x:number;y:number},box:DOMRect)=>{
    const chart=chartRef.current
    if(!chart)return undefined
    let hit:string|undefined,distance=CHART_MARKERS.nearestRadius ** 2 + .000001
    for(const q of pointsRef.current){const xy=chart.convertToPixel({gridIndex:0},[q.x,q.y]) as number[]
      const d=((xy[0]-point.x)*box.width/chart.getWidth())**2+((xy[1]-point.y)*box.height/chart.getHeight())**2
      if(d<distance){distance=d;hit=q.rowId}}
    return hit
  }
  const contextMenuItems = [
    {
      key: 'focus',
      label: SELECTION_LABELS.focus,
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(focusSelected()),
    },
    {
      key: 'delete',
      label: SELECTION_LABELS.exclude,
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(deleteSelected()),
    },
    {
      key: 'clear',
      label: SELECTION_LABELS.clear,
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(selectionCleared()),
    },
    {
      type: 'divider' as const,
    },
    {
      key: 'reset',
      label: SELECTION_LABELS.reset,
      onClick: () => dispatch(resetWorkingSet()),
    },
  ]


  return <Dropdown getPopupContainer={getPopupContainer} menu={{items:contextMenuItems}} trigger={['contextMenu']}>
    <div ref={containerRef} data-testid="tgt-canvas" tabIndex={0} role="group"
      aria-label="Grand Tour 投影図。Spaceで再生・一時停止、.で1コマ送り、Rで視点リセット。一時停止中は矢印キーで行を移動、Enterで選択"
      onFocus={event=>{if(event.target===event.currentTarget&&isActive&&!isPlaying)announcePoint(Math.max(0,pointsRef.current.findIndex(point=>point.rowId===keyboardRow.current)))}}
      onBlur={leaveKeyboard}
      onKeyDown={event=>{
        // Native controls (including export and dialog buttons) keep their keys.
        if(!isActive||event.defaultPrevented||event.target!==event.currentTarget||event.altKey||event.ctrlKey||event.metaKey||event.repeat)return
        if((event.code==='Space'||event.key===' ')&&props.onTogglePlay){event.preventDefault();props.onTogglePlay();return}
        if(event.key==='.'&&props.onStep){event.preventDefault();props.onStep();return}
        if((event.key==='r'||event.key==='R')&&props.onReset){event.preventDefault();props.onReset();return}
        if(event.key==='Escape'){leaveKeyboard();return}
        if(isPlaying||!pointsRef.current.length)return
        const index=Math.max(0,pointsRef.current.findIndex(point=>point.rowId===keyboardRow.current))
        if(event.key.startsWith('Arrow')){
          event.preventDefault()
          const direction=event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1
          announcePoint(Math.max(0,Math.min(pointsRef.current.length-1,index+direction)))
        }else if(event.key==='Home'||event.key==='End'){
          event.preventDefault();announcePoint(event.key==='Home'?0:pointsRef.current.length-1)
        }else if(event.key==='Enter'){
          event.preventDefault();dispatch(selectionApplied({rowIds:[pointsRef.current[index].rowId],operation:'toggle',label:'Touring点選択'}))
        }
      }}
      style={{height:'100%',width:'100%',position:'relative',border:'1px solid #333',borderRadius:8,overflow:'hidden',userSelect:'none',touchAction:'none'}}
      onPointerDown={e=>{if(isPlaying||e.button!==0||start.current)return;const p=local(e);if(!p)return;
        start.current={...p,clientX:e.clientX,clientY:e.clientY,pointerId:e.pointerId,coordKey:viewportKey,pointId:nearestRow(p,e.currentTarget.getBoundingClientRect())};try{e.currentTarget.setPointerCapture?.(e.pointerId)}catch{/* synthetic event */}}}
      onPointerMove={e=>{const a=start.current,p=local(e);if(!a||a.pointId||a.pointerId!==e.pointerId||!p||isPlaying)return;
        chartRef.current?.setOption({graphic:[{id:'tour-brush',type:'rect',invisible:false,silent:true,z:100,
          shape:{x:Math.min(a.x,p.x),y:Math.min(a.y,p.y),width:Math.abs(a.x-p.x),height:Math.abs(a.y-p.y)},style:{fill:'rgba(42,120,214,.15)',stroke:'#2a78d6',lineWidth:1.5}}]})}}
      onPointerCancel={e=>{if(start.current?.pointerId===e.pointerId)clear()}}
      onLostPointerCapture={e=>{if(start.current?.pointerId===e.pointerId)clear()}}
      onPointerUp={e=>{
        const a=start.current,p=local(e),chart=chartRef.current
        if(a?.pointerId!==e.pointerId)return
        clear()
        if(!a||!p||!chart||isPlaying||a.coordKey!==viewportKey)return
        const box=e.currentTarget.getBoundingClientRect()
        if(Math.abs(e.clientX-a.clientX)<=4&&Math.abs(e.clientY-a.clientY)<=4){
          const hit=a.pointId??nearestRow(p,box)
          if(hit)dispatch(selectionApplied({rowIds:[hit],operation:'toggle',label:'Touring点選択'}))
        }else if(!a.pointId){
          const hit=pointsRef.current.filter(q=>{const xy=chart.convertToPixel({gridIndex:0},[q.x,q.y]) as number[]
            return xy[0]>=Math.min(a.x,p.x)&&xy[0]<=Math.max(a.x,p.x)&&xy[1]>=Math.min(a.y,p.y)&&xy[1]<=Math.max(a.y,p.y)}).map(q=>q.rowId)
          dispatch(selectionApplied({rowIds:hit,operation:getBrushOp(),label:`Touring選択 (${hit.length}行)`}))
        }
      }}>
      <EChart chartRef={chartRef} renderer="canvas" height="100%" option={baseOption} ariaLabel="Grand Tour 投影図" onReady={()=>setReady(true)}
        onEvents={{mouseover:event=>{if(event.seriesId==='tour-points'&&event.data?.rowId)dispatch({type:'selection/hovered',payload:event.data.rowId})},
          mouseout:event=>{if(event.seriesId==='tour-points')dispatch({type:'selection/hovered',payload:null})}}} />
      <span aria-live="polite" style={{position:'absolute',top:0,left:0,width:1,height:1,overflow:'hidden',clipPath:'inset(50%)'}}>{keyboardDetail}</span>
    </div>
  </Dropdown>
}
