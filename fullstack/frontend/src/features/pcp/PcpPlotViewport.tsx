import { useEffect } from 'react'
import { useGraphViewport } from '../common/GraphPanel'

/**
 * F004-01: GraphPanel の子として実 viewport 情報を受け取り、
 * 親（PcpPage）の frameSize へ反映する薄い橋渡し。
 * PcpPage 自体は Provider の外なので、ここで受け取る以外に実値は届かない。
 */
export default function PcpPlotViewport({ onSize }: {
  onSize: (size: { width: number; height: number; scale: number; dpr: number; revision: number }) => void
}) {
  const viewport = useGraphViewport()
  useEffect(() => {
    onSize({
      width: viewport.logicalWidth,
      height: viewport.logicalHeight,
      scale: viewport.scale,
      dpr: viewport.dpr,
      revision: viewport.revision,
    })
  }, [viewport.logicalWidth, viewport.logicalHeight, viewport.scale, viewport.dpr, viewport.revision, onSize])
  return null
}
