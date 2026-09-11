import { cloneElement, isValidElement, useCallback, useEffect, useId, useState, type ReactElement, type ReactNode } from 'react'
import { Tooltip } from 'antd'
import { useSelector } from 'react-redux'
import type { RootState } from '../../app/store'
import { useCodebook } from '../dataset/useCodebookColumn'

/** Plain text for existing row popups and SVG titles, avoiding nested balloons. */
export function useQuestionText() {
  const { getColumn } = useCodebook()
  return useCallback((name: string) => {
    const label = getColumn(name)?.label
    return label?.trim() ? `${name} — ${label}` : name
  }, [getColumn])
}

export function useColumnQuestion(nameOrId: string) {
  return useSelector((s: RootState) => s.codebook?.datasetId === s.selection.datasetId
    ? s.codebook.columns.find(c => c.name === nameOrId || c.columnId === nameOrId) : undefined)
}

export function ColumnQuestionText({ nameOrId }: { nameOrId: string }) {
  const column = useColumnQuestion(nameOrId)
  return <span>{nameOrId}{column?.label?.trim() ? ` — ${column.label}` : ''}</span>
}

interface ColumnQuestionProps {
  nameOrId: string; children?: ReactNode; svg?: boolean; tabIndex?: number; info?: boolean; passive?: boolean
}

export default function ColumnQuestionTooltip(props: ColumnQuestionProps) {
  const column = useColumnQuestion(props.nameOrId)
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  return <QuestionTooltip {...props} question={column?.label} columnName={column?.name} datasetId={datasetId} />
}

/** Also usable by standalone cards which already receive saved column metadata. */
export function QuestionTooltip({ nameOrId, children, svg = false, tabIndex = 0, info = false, passive = false,
  question, columnName, datasetId }: ColumnQuestionProps & { question?: string; columnName?: string; datasetId?: string | null }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const label = question?.trim() ? question : null
  useEffect(() => { setOpen(false) }, [datasetId, nameOrId])
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return
      if (event.type === 'scroll' && document.getElementById(id)?.contains(event.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('keydown', close, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('popstate', close)
    window.addEventListener('davis:close-column-questions', close)
    return () => {
      window.removeEventListener('keydown', close, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('popstate', close)
      window.removeEventListener('davis:close-column-questions', close)
    }
  }, [open, id])
  const content = children ?? nameOrId
  if (!label) return info ? null : <>{content}</>
  const props = {
    tabIndex, 'aria-describedby': open ? id : undefined,
    'data-column-question': nameOrId,
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
    onPointerDown: (event: React.PointerEvent) => {
      if (passive) return
      event.stopPropagation()
      if (!info && event.pointerType === 'touch') setOpen(value => !value)
    },
  }
  let trigger: ReactElement
  if (svg && isValidElement(content)) {
    const child = content as ReactElement<any>
    trigger = cloneElement(child, { ...props,
      onFocus: (e: React.FocusEvent) => { child.props.onFocus?.(e); props.onFocus() },
      onBlur: (e: React.FocusEvent) => { child.props.onBlur?.(e); props.onBlur() },
      onPointerDown: (e: React.PointerEvent) => { child.props.onPointerDown?.(e); props.onPointerDown(e) },
    })
  } else trigger = info ? <span {...props} role="button" aria-label={`${columnName ?? nameOrId}の設問文を表示`}
    style={{ cursor: 'help', padding: '0 4px', flexShrink: 0 }}
    onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
    onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(true) }}
    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setOpen(true) } }}
  >ⓘ</span> : <span {...props}>{content}</span>
  return <Tooltip open={open} onOpenChange={setOpen} trigger={['hover']} mouseEnterDelay={0.25} mouseLeaveDelay={0.1}
    autoAdjustOverflow title={<div id={id} style={{ maxHeight: '50vh', overflowY: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      <strong>{columnName ?? nameOrId}</strong><div>{label}</div>
    </div>} styles={{ root: { maxWidth: 'min(420px, calc(100vw - 24px))' } }}>{trigger}</Tooltip>
}
