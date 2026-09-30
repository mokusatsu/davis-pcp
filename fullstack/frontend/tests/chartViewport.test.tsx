import { cleanup, fireEvent, render, act } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getInstanceByDom } from 'echarts'
import EChart from '../src/features/charts/EChart'
import EChartSurface from '../src/features/charts/EChartSurface'
import ModelScatter from '../src/features/models/ModelScatter'
const viewport = vi.hoisted(()=>({logicalWidth:600,logicalHeight:400,scale:1,zoom:null as number|null,dpr:1,revision:0}))
vi.mock('../src/features/common/GraphPanel',()=>({useGraphViewport:()=>viewport, useGraphPopupContainer:()=>()=>document.body}))
beforeEach(()=>{Object.assign(viewport,{logicalWidth:600,logicalHeight:400,scale:1,zoom:null,dpr:1,revision:0});vi.stubGlobal('PointerEvent',MouseEvent)})
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals()})
it('keeps a native SVG chart alive across display zoom changes',()=>{
 const option={xAxis:{},yAxis:{},series:[{type:'scatter' as const,data:[[1,2]]}]}
 const view=render(<EChart option={option} testId="chart" />)
 const chart=getInstanceByDom(view.getByTestId('chart'))!
 viewport.scale=2;viewport.zoom=2
 view.rerender(<EChart option={option} testId="chart" />)
 expect(getInstanceByDom(view.getByTestId('chart'))).toBe(chart)
 expect(chart.isDisposed()).not.toBe(true)
})
it('cancels a model brush when only GraphPanel zoom changes',()=>{
 const brush=vi.fn(), points=[{id:'r',x:1,y:1,title:'r'}]
 const props={points,xLabel:'X',yLabel:'Y',testId:'model',onBrush:brush}
 const view=render(<ModelScatter {...props} />),el=view.getByTestId('model'),host=el.parentElement!.parentElement!
 const chart=getInstanceByDom(el)!
 act(()=>chart.resize({width:600,height:400}))
 host.getBoundingClientRect=()=>({left:0,top:0,width:600,height:400} as DOMRect)
 fireEvent.pointerDown(host,{clientX:90,clientY:80,button:0})
 fireEvent.pointerMove(host,{clientX:160,clientY:170,button:0})
 viewport.scale=2;viewport.zoom=2
 view.rerender(<ModelScatter {...props} />)
 fireEvent.pointerUp(host,{clientX:220,clientY:220,button:0})
 expect(brush).not.toHaveBeenCalled()
})
it('notifies geometry controllers for scale and DPR changes, not ordinary renders',()=>{
 const cancel=vi.fn(),node=<circle cx={50} cy={50} r={5}/>
 const view=render(<EChartSurface width={600} height={400} onViewportChange={cancel}>{node}</EChartSurface>)
 expect(cancel).not.toHaveBeenCalled()
 view.rerender(<EChartSurface width={600} height={400} onViewportChange={cancel}>{node}</EChartSurface>)
 expect(cancel).not.toHaveBeenCalled()
 viewport.scale=.5;view.rerender(<EChartSurface width={600} height={400} onViewportChange={cancel}>{node}</EChartSurface>)
 expect(cancel).toHaveBeenCalledTimes(1)
 viewport.dpr=2;view.rerender(<EChartSurface width={600} height={400} onViewportChange={cancel}>{node}</EChartSurface>)
 expect(cancel).toHaveBeenCalledTimes(2)
})
