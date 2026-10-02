import { useState } from 'react'
import { Segmented } from 'antd'
import { AnalysisViewActivityContext, useAnalysisViewActive } from '../selection/analysisScope'
import { useGraphExpansion } from '../common/GraphExpansion'
import OrdinaryPcaPanel from './OrdinaryPcaPanel'
import SparsePcaPanel from './SparsePcaPanel'

/** Keep the two analyses independent, including their saved results and inputs. */
export default function PcaPage() {
  const active = useAnalysisViewActive()
  const { close } = useGraphExpansion()
  const [mode, setMode] = useState<'ordinary' | 'sparse'>('ordinary')
  const [sparseVisited, setSparseVisited] = useState(false)
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Segmented data-testid="pca-analysis-mode" aria-label="PCA解析モード" value={mode}
      options={[{ value: 'ordinary', label: '通常PCA' }, { value: 'sparse', label: 'SparsePCA' }]}
      onChange={value => { close(); setMode(value as 'ordinary' | 'sparse'); if (value === 'sparse') setSparseVisited(true) }} />
    <div hidden={mode !== 'ordinary'}><AnalysisViewActivityContext.Provider value={active && mode === 'ordinary'}>
      <OrdinaryPcaPanel />
    </AnalysisViewActivityContext.Provider></div>
    {sparseVisited && <div hidden={mode !== 'sparse'}><AnalysisViewActivityContext.Provider value={active && mode === 'sparse'}>
      <SparsePcaPanel />
    </AnalysisViewActivityContext.Provider></div>}
  </div>
}
