import { useEffect, useRef, type ReactNode } from 'react'
import './analysisSetup.css'

/** Native disclosure keeps optional settings mounted and keyboard accessible. */
export function AnalysisSettings({ title, summary, children, attention = false }: {
  title: string; summary: ReactNode; children: ReactNode; attention?: boolean
}): JSX.Element {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => { if (attention && ref.current) ref.current.open = true }, [attention])
  return <details className="analysis-settings" ref={ref}>
    <summary>
      <span className="analysis-settings-title">{title}</span>
      <span className="analysis-settings-summary">{summary}</span>
      {attention && <span className="analysis-settings-attention">設定を確認してください</span>}
    </summary>
    <div className="analysis-form-stack analysis-settings-content">{children}</div>
  </details>
}

export function AnalysisField({ label, htmlFor, help, children }: {
  label: ReactNode; htmlFor?: string; help?: ReactNode; children: ReactNode
}): JSX.Element {
  return <div className="analysis-field">
    <label htmlFor={htmlFor} className="analysis-field-label">{label}</label>
    {children}
    {help && <div id={htmlFor ? `${htmlFor}-help` : undefined} className="analysis-field-help">{help}</div>}
  </div>
}

export function AnalysisRunRow({ children }: { children: ReactNode }): JSX.Element {
  return <div className="analysis-run-row">{children}</div>
}
