import { Button, type ButtonProps } from 'antd'
import { useEffect, useRef, useState, type CSSProperties } from 'react'

export interface AsyncExportButtonProps extends Omit<ButtonProps, 'onClick' | 'loading'> {
  onExport: () => void | Promise<void>
  /** Changing the result must not display completion/errors from its predecessor. */
  exportKey?: string | number
  statusLabel?: string
  statusStyle?: CSSProperties
}

/** Every export has the same pending/retry contract, including synchronous SVGs. */
export default function AsyncExportButton({ onExport, exportKey, statusLabel = 'ファイル', statusStyle,
  disabled, children, ...props }: AsyncExportButtonProps) {
  const [state, setState] = useState<{ pending: boolean; error?: string; complete?: boolean }>({ pending: false })
  const operation = useRef(0)
  const pending = useRef(false)
  const completionTimer = useRef<ReturnType<typeof setTimeout>>()
  const currentKey = useRef(exportKey)
  currentKey.current = exportKey
  useEffect(() => {
    clearTimeout(completionTimer.current)
    operation.current += 1
    pending.current = false
    setState({ pending: false })
    return () => { operation.current += 1; clearTimeout(completionTimer.current) }
  }, [exportKey])

  const run = async () => {
    // A ref also rejects a second activation before React flushes loading state.
    if (disabled || pending.current) return
    clearTimeout(completionTimer.current)
    pending.current = true
    const token = ++operation.current, key = currentKey.current
    const isCurrent = () => token === operation.current && key === currentKey.current
    setState({ pending: true })
    try {
      await onExport()
      if (isCurrent()) {
        setState({ pending: false, complete: true })
        completionTimer.current = setTimeout(() => { if (isCurrent()) setState({ pending: false }) }, 4000)
      }
    } catch (error) {
      const detail = typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message) : String(error)
      if (isCurrent()) setState({ pending: false, error: `${statusLabel}を保存できませんでした: ${detail}` })
    } finally {
      if (isCurrent()) pending.current = false
    }
  }

  return <span style={{ display: 'inline-flex', position: 'relative', flexDirection: 'column', alignItems: 'flex-start', maxWidth: '100%' }}>
    <Button {...props} disabled={disabled || state.pending} loading={state.pending} aria-busy={state.pending}
      onClick={event => { event.stopPropagation(); void run() }}>{children}</Button>
    {state.pending && <span role="status" style={{ fontSize: 12, ...statusStyle }}>{statusLabel}を準備中…</span>}
    {state.error && <span role="alert" style={{ fontSize: 12, color: '#b42318', whiteSpace: 'normal', ...statusStyle }}>{state.error}</span>}
    {state.complete && <span role="status" style={{ fontSize: 12, ...statusStyle }}>{statusLabel}のダウンロードを開始しました</span>}
  </span>
}
