import { forwardRef, useState } from 'react'
import { Select, Tag } from 'antd'
import ColumnQuestionTooltip, { ColumnQuestionText, QuestionTooltip } from './ColumnQuestionTooltip'
import { useCodebook } from '../dataset/useCodebookColumn'

/** Keep option values/search text intact; decorate only their presentation. */
const ColumnSelect = forwardRef<any, any>((props, ref) => {
  const [active, setActive] = useState<string | null>(null)
  const { getColumn } = useCodebook()
  const options = (props.options ?? []).flatMap((o: any) => o.options ?? [o])
  const presentation = (value: any, fallback?: React.ReactNode) => {
    const option = options.find((o: any) => o.value === value)
    const column = getColumn(String(value))
    const name = option?.questionName ?? column?.name ?? String(value)
    const label = option?.questionText ?? column?.label
    return label?.trim() ? `${name} — ${label}` : (option?.label ?? fallback ?? value)
  }
  const renderValue = (value: any, fallback?: React.ReactNode) => <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0, maxWidth: '100%', width: '100%' }}>
    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{presentation(value, fallback)}</span>
    {question(value, undefined, true)}
  </span>
  const question = (value: any, children?: React.ReactNode, info = false) => {
    const option = options.find((o: any) => o.value === value)
    return option?.questionText
      ? <QuestionTooltip nameOrId={option.questionName ?? String(value)} question={option.questionText} tabIndex={-1} passive={!info} info={info}>{children}</QuestionTooltip>
      : <ColumnQuestionTooltip nameOrId={String(value)} tabIndex={-1} passive={!info} info={info}>{children}</ColumnQuestionTooltip>
  }
  const activeOption = options.find((o: any) => String(o.value) === active)
  return <Select {...props} ref={ref}
    filterOption={props.filterOption ?? ((input: string, option: any) => `${option?.value ?? ''} ${option?.label ?? ''} ${presentation(option?.value)}`.toLocaleLowerCase().includes(input.toLocaleLowerCase()))}
    optionRender={props.optionRender ?? ((option: any) => renderValue(option.value, option.label))}
    labelRender={props.labelRender ?? ((option: any) => renderValue(option.value, option.label))}
    tagRender={props.tagRender ?? ((tag: any) => <Tag style={{ display: 'inline-flex', alignItems: 'center', maxWidth: 'min(320px, 100%)', minWidth: 0 }} closable={tag.closable} onClose={tag.onClose} onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}>
      {renderValue(tag.value, tag.label)}
    </Tag>)}
    onInputKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
      props.onInputKeyDown?.(event)
      const input = event.currentTarget
      requestAnimationFrame(() => {
        const element = document.getElementById(input.getAttribute('aria-activedescendant') ?? '')
        const text = element?.getAttribute('aria-label') ?? element?.textContent
        const option = options.find((o: any) => String(o.label ?? o.value) === text || String(o.value) === text)
        setActive(option ? String(option.value) : null)
      })
    }}
    onDropdownVisibleChange={(visible: boolean) => { if (!visible) setActive(null); props.onDropdownVisibleChange?.(visible) }}
    dropdownRender={(menu: React.ReactNode) => <>{props.dropdownRender ? props.dropdownRender(menu) : menu}
      {active && <div aria-live="polite" style={{ padding: 8, whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto' }}>{activeOption?.questionText ?? <ColumnQuestionText nameOrId={active} />}</div>}
    </>}
  />
}) as unknown as typeof Select
ColumnSelect.Option = Select.Option
ColumnSelect.OptGroup = Select.OptGroup

export default ColumnSelect
