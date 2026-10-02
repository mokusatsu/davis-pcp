import { formatFixed } from '../../common/RoundedStatistic'

export function vifDisplay(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return { text: '—', color: '#666666', label: '算出不可' }
  if (!Number.isFinite(value) || value < 1) return { text: '範囲外', color: '#cf1322', label: '範囲外' }
  if (value > 10) return { text: formatFixed(value, 1), color: '#cf1322', label: '強い共線性（VIF > 10）' }
  if (value > 5) return { text: formatFixed(value, 1), color: '#d46b08', label: '共線性に注意（VIF > 5）' }
  return { text: formatFixed(value, 1), color: '#3f8600', label: 'VIF ≤ 5' }
}
