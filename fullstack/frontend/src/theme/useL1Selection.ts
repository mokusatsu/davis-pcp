import { useEffect, useRef } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { message } from 'antd'
import { pcpStateChanged, type RootState } from '../app/store'
import { useColumnarData } from '../features/pcp/useDatasetColumns'
import { defaultL1Column, useL1ColorDomains } from './useL1ColorDomain'

export function useL1Selection() {
  const dispatch = useDispatch()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const colorBy = useSelector((s: RootState) => s.pcp.colorBy)
  const codebook = useSelector((s: RootState) => s.codebook)
  const data = useColumnarData(datasetId)
  const domains = useL1ColorDomains(data)
  const initialized = useRef<string | null>(null)
  useEffect(() => {
    if (!datasetId) { initialized.current = null; return }
    if (!data || codebook.datasetId !== datasetId || codebook.isLoading) return
    if (initialized.current !== datasetId) {
      initialized.current = datasetId
      dispatch(pcpStateChanged({ colorBy: defaultL1Column(data, domains) }))
    } else if (colorBy && !domains.some(d => d.key === colorBy)) {
      dispatch(pcpStateChanged({ colorBy: null }))
      void message.info('色分け列が削除されたか、有効な値の種類数が1～20の範囲外になったためL1色分けを解除しました。')
    }
  }, [datasetId, data, domains, colorBy, codebook.datasetId, codebook.isLoading, dispatch])
}
