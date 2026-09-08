import { useSelector } from 'react-redux'
import type { RootState } from '../../app/store'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { useL1ColorDomains } from '../../theme/useL1ColorDomain'
import { l1Color, vizTheme } from '../../theme/viz'
import { useCodebook } from '../dataset/useCodebookColumn'
import ColumnQuestionTooltip from './ColumnQuestionTooltip'

export default function L1Legend() {
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const key = useSelector((s: RootState) => s.pcp.colorBy)
  const data = useColumnarData(datasetId)
  const domain = useL1ColorDomains(data).find(d => d.key === key)
  const { formatValueLabel } = useCodebook()
  if (!domain || !key) return null
  const theme = vizTheme(false)
  return <div aria-label="L1色分け凡例" style={{ fontSize: 12, padding: '6px 0' }}>
    <ColumnQuestionTooltip nameOrId={key} />
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', maxHeight: 160, overflowY: 'auto' }}>
      {domain.codes.map((code, index) => {
        const label = formatValueLabel(key, code)
        return <span key={code} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <i aria-hidden style={{ width: 10, height: 10, background: l1Color(theme, index), flexShrink: 0 }} />
          {code === '' ? '(空文字)' : code}{label !== code ? ` / ${label}` : ''}
        </span>
      })}
      <span><i aria-hidden style={{ display: 'inline-block', width: 10, height: 10, background: theme.contextLine }} /> 欠損（L1なし）</span>
    </div>
  </div>
}
