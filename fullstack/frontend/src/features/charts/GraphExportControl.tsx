import { DownloadOutlined } from '@ant-design/icons'
import AsyncExportButton, { type AsyncExportButtonProps } from '../common/AsyncExportButton'

export type GraphExportFormat = 'svg' | 'png'

/** Shared visual, naming, accessibility and failure contract for chart exports. */
export default function GraphExportControl({ format = 'svg', graphLabel, target, ...props }:
  Omit<AsyncExportButtonProps, 'children' | 'statusLabel'> & {
    format?: GraphExportFormat
    graphLabel: string
    target?: string
  }) {
  const label = `${target ? `${target} ` : ''}${format.toUpperCase()}を保存`
  return <AsyncExportButton size="small" icon={<DownloadOutlined />} {...props}
    style={{ width: target ? undefined : 84, height: 24, boxSizing: 'border-box', fontSize: 12, padding: '0 4px', columnGap: 4, ...props.style }}
    data-chart-export={format} aria-label={`${graphLabel}：${label}`} title={label}
    statusLabel={target ? `${target} ${format.toUpperCase()}` : format.toUpperCase()}
    onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
    onPointerUp={event => event.stopPropagation()} onMouseUp={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}>{label}</AsyncExportButton>
}
