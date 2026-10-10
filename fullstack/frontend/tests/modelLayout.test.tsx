import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { init, getInstanceByDom } from 'echarts'
import { store } from '../src/app/store'
import { oddsForestOption } from '../src/features/models/OddsRatioForest'
import { logisticCurveSeries } from '../src/features/models/LogisticRegressionPage'
import { modelScatterOption } from '../src/features/models/ModelScatter'
import { TreeDiagram, treeDiagramDimensions } from '../src/features/models/ModelsPage'

afterEach(cleanup)

describe('model chart layout', () => {
  for (const width of [560, 1120]) it(`keeps the sigmoid cutoff label within width ${width}`, () => {
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, width, height: 280 })
    try {
      chart.setOption(modelScatterOption([], 'X', 'P(Y = 1 | X)', false, [-2,2], [0,1], logisticCurveSeries([{x:-2,probability:.1},{x:2,probability:.9}],.5)))
      chart.getZr().flush()
      const label = chart.getZr().storage.getDisplayList(true).find((el: any) => el.style?.text === 'Cutoff = 0.50')!
      expect(label).toBeTruthy()
      const box = label.getBoundingRect().clone(); box.applyTransform(label.transform)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height).toBeLessThanOrEqual(280)
    } finally { chart.dispose() }
  })

  it('places the odds-ratio reference annotation above the plot, clear of extreme numeric ticks', () => {
    const chart=init(null,undefined,{renderer:'svg',ssr:true,width:560,height:280})
    try {
      chart.setOption(oddsForestOption([{name:'x',coefficient:2000,stdError:100,zValue:20,pValue:0,oddsRatio:null,ciLower:null,ciUpper:null,logOddsRatio:2000,logCiLower:1800,logCiUpper:2200,
        inferenceStatus:'available',inferenceReason:null}]))
      chart.getZr().flush()
      const axis=(chart.getOption() as any).xAxis[0]
      expect(axis.axisLabel.showMinLabel).toBe(false)
      expect(axis.axisLabel.showMaxLabel).toBe(false)
      expect(axis.axisLabel.hideOverlap).toBe(true)
      const label=chart.getZr().storage.getDisplayList(true).find((el:any)=>el.style?.text==='OR = 1')!
      expect(label).toBeTruthy()
      const box=label.getBoundingRect().clone();box.applyTransform(label.transform)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y+box.height).toBeLessThanOrEqual(30)
    } finally {chart.dispose()}
  })

  it('exports a readable full-width tree with in-frame nonoverlapping nodes and unchanged leaf selection', () => {
    let nextId=0
    const makeTree=(depth:number):any=> {
      const nodeId=nextId++
      return {nodeId,isLeaf:depth===4,count:16>>depth,majority:'A',feature:'X',threshold:.5,
        values:[{label:'A',count:16>>depth,ratio:1,classIndex:0}],...(depth<4?{children:[makeTree(depth+1),makeTree(depth+1)]}:{})}
    }
    const classCategories=[[{rawValue:'A',code:'A',label:'A'}]]
    const root=makeTree(0), size=treeDiagramDimensions(root,'String',classCategories)
    expect(size.width).toBe(16*104+40)
    const w=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'clientWidth'),h=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'clientHeight')
    Object.defineProperty(HTMLElement.prototype,'clientWidth',{configurable:true,get:()=>size.width})
    Object.defineProperty(HTMLElement.prototype,'clientHeight',{configurable:true,get:()=>size.height})
    const select=vi.fn(),leaf=root.children[0].children[0].children[0].children[0]
    try {
      const view=render(<Provider store={store}><TreeDiagram root={root} targetDtype="String" classCategories={classCategories} treeIndex={0} leafMembership={[{treeIndex:0,nodeId:leaf.nodeId,rowIds:['R1']}]} selectedRowIds={['R1']} onLeafSelect={select} /></Provider>)
      const chart=getInstanceByDom(view.container.querySelector('[data-chart-renderer="echarts"]') as HTMLElement)!
      const series=(chart as any).getModel().getSeriesByIndex(0),data=series.getData()
      expect(series.get('coordinateSystem')).toBe('cartesian2d')
      expect(data.count()).toBe(31)
      const boxes=Array.from({length:data.count()},(_,i)=>{
        const el=data.getItemGraphicEl(i),box=el.getBoundingRect().clone();box.applyTransform(el.transform);return box
      })
      for(const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(0); expect(b.y).toBeGreaterThanOrEqual(0)
        expect(b.x+b.width).toBeLessThanOrEqual(size.width); expect(b.y+b.height).toBeLessThanOrEqual(size.height)
      }
      for(let i=0;i<boxes.length;i++) for(let j=i+1;j<boxes.length;j++) {
        const a=boxes[i],b=boxes[j]
        expect(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y).toBe(false)
      }
      ;(chart as any).trigger('click',{dataType:'node',data:{isLeaf:true,nodeId:leaf.nodeId}})
      expect(select).toHaveBeenCalledWith(['R1'])
      expect(chart.getWidth()).toBe(size.width)
      expect(view.getByTestId(`tree-leaf-0-${leaf.nodeId}`)).toHaveAttribute('aria-pressed','true')
    } finally {
      cleanup()
      if(w)Object.defineProperty(HTMLElement.prototype,'clientWidth',w);else delete (HTMLElement.prototype as any).clientWidth
      if(h)Object.defineProperty(HTMLElement.prototype,'clientHeight',h);else delete (HTMLElement.prototype as any).clientHeight
    }
  })
})
