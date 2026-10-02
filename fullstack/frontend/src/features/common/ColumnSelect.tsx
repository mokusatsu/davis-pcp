import { forwardRef, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Input, Radio, Select, Tag } from 'antd'
import Modal from './ActiveModal'
import { SearchOutlined } from '@ant-design/icons'
import ColumnQuestionTooltip, { ColumnQuestionText, QuestionTooltip } from './ColumnQuestionTooltip'
import { useCodebook } from '../dataset/useCodebookColumn'

export interface ColumnSelectEmptyHint {
  roleLabel: string
  onOpenCodebook: () => void
}

/** A variable picker with the same value/option contract as Select. */
const ColumnSelect = forwardRef<any, any>((props, ref) => {
  const [active, setActive] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [dialogSearch, setDialogSearch] = useState('')
  const [tmpValue, setTmpValue] = useState<any[] | null>(null)
  const [uncontrolledValue, setUncontrolledValue] = useState(props.defaultValue)
  const { getColumn } = useCodebook()
  const options = (props.options ?? []).flatMap((o: any) => o.options ?? [o])
  const isMultiple = props.mode === 'multiple'
  const value = 'value' in props ? props.value : uncontrolledValue
  const committed = Array.isArray(value) ? value : (value == null ? [] : [value])
  const dialogValue = tmpValue ?? committed
  const { emptyHint, style, className, onDropdownVisibleChange, dropdownRender, onOpenChange, ...selectProps } = props as any
  const hint = emptyHint as ColumnSelectEmptyHint | undefined
  const maxCount = isMultiple && Number.isFinite(props.maxCount) ? Math.max(0, props.maxCount) : Infinity
  const prevOpen = useRef<boolean>(props.open ?? false)
  const handleOpenChange = (visible: boolean) => {
    if (!visible) setActive(null)
    setDropdownOpen(visible)
    if (prevOpen.current !== visible) {
      prevOpen.current = visible
      onDropdownVisibleChange?.(visible)
      // The legacy and current aliases can point at the same callback.
      if (onOpenChange !== onDropdownVisibleChange) onOpenChange?.(visible)
    }
  }
  const change = (next: any, option: any) => {
    if (props.disabled) return
    setUncontrolledValue(next)
    props.onChange?.(next, option)
  }
  const details = (option: any) => {
    const column = getColumn(String(option?.value))
    const name = option?.questionName ?? column?.name ?? String(option?.value ?? '')
    const primary = option?.label ?? name
    const question = (option?.questionText ?? column?.label)?.trim()
    const primaryText = typeof primary === 'string' || typeof primary === 'number' ? String(primary) : ''
    // Respect caller annotations and never repeat an already present question.
    const secondary = question && question !== name && !primaryText.includes(question) ? question : undefined
    return { name, primary, secondary }
  }
  const presentation = (value: any, fallback?: React.ReactNode) => {
    const option = options.find((o: any) => o.value === value) ?? { value, label: fallback }
    const { primary, secondary } = details(option)
    return secondary ? <>{primary} — {secondary}</> : primary
  }
  const renderLabel = (value: any, fallback?: React.ReactNode) =>
    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{presentation(value, fallback)}</span>
  const question = (value: any) => {
    const option = options.find((o: any) => o.value === value)
    const column = getColumn(String(value))
    if (!option?.questionText && !column?.label?.trim()) return null
    return option?.questionText
      ? <QuestionTooltip nameOrId={option.questionName ?? String(value)} question={option.questionText} tabIndex={-1} info />
      : <ColumnQuestionTooltip nameOrId={String(value)} tabIndex={-1} info />
  }
  const renderValue = (value: any, fallback?: React.ReactNode) => <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0, maxWidth: '100%', width: '100%' }}>
    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{presentation(value, fallback)}</span>
    {question(value)}
  </span>
  const searchText = (o: any) => {
    const { name, primary, secondary } = details(o)
    return `${o.value ?? ''} ${name} ${typeof primary === 'string' ? primary : ''} ${secondary ?? ''} ${o.questionText ?? ''}`.toLocaleLowerCase()
  }
  const dialogOptions = useMemo(() => {
    const q = dialogSearch.trim().toLocaleLowerCase()
    return q ? options.filter((o: any) => searchText(o).includes(q)) : options
  }, [options, dialogSearch, getColumn])
  const eligibleOptions = dialogOptions.filter((o: any) => !o.disabled)
  const hiddenCount = dialogValue.filter(v => !dialogOptions.some((o: any) => o.value === v)).length
  const activeOption = options.find((o: any) => String(o.value) === active)
  const openCodebook = () => {
    setPickerOpen(false)
    handleOpenChange(false)
    hint?.onOpenCodebook()
  }
  const emptyGuide = hint && options.length === 0 ? (
    <div style={{ padding: 12, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
      <span style={{ whiteSpace: 'pre-line' }}>{`${hint.roleLabel}変数がありません\nコードブックで${hint.roleLabel}変数を指定してください`}</span>
      <Button size="small" disabled={props.disabled} onClick={openCodebook}>コードブックを開く</Button>
    </div>
  ) : undefined
  // Layout constraints belong to the whole input, including its search button.
  const { width, minWidth, maxWidth, flex, flexGrow, flexShrink, flexBasis, alignSelf,
    margin, marginTop, marginRight, marginBottom, marginLeft, ...innerStyle } = style ?? {}
  const wrapStyle = { width, minWidth: minWidth ?? 0, maxWidth: maxWidth ?? '100%', flex, flexGrow, flexShrink, flexBasis, alignSelf,
    margin, marginTop, marginRight, marginBottom, marginLeft }
  const setOption = (option: any, checked: boolean) => {
    if (props.disabled || option.disabled) return
    if (!isMultiple) { setTmpValue([option.value]); return }
    if (checked && dialogValue.length >= maxCount) return
    setTmpValue(checked ? [...dialogValue, option.value] : dialogValue.filter(v => v !== option.value))
  }
  return <>
    <style>{`
      .column-select-multi-wrap { display: inline-flex; align-items: stretch; vertical-align: middle; }
      .column-select-multi-wrap .column-select-search-btn { border-start-end-radius: 0 !important; border-end-end-radius: 0 !important; border-inline-end: none; flex-shrink: 0; align-self: stretch; height: auto; padding-inline: 8px; }
      .column-select-multi-wrap .column-select-input { margin-left: 1px; }
      .column-select-multi-wrap .column-select-input .ant-select-selector { border-start-start-radius: 0 !important; border-end-start-radius: 0 !important; }
      .column-select-multi-wrap .column-select-multi-fix .ant-select-selection-overflow { max-height: 52px; overflow: hidden; }
      .column-select-multi-wrap .column-select-multi-fix.ant-select-sm .ant-select-selection-overflow { max-height: 44px; }
      .column-select-multi-wrap .column-select-multi-fix.ant-select-allow-clear .ant-select-clear { right: 30px; opacity: 1; }
      .column-select-multi-wrap .column-select-multi-fix .ant-select-arrow { right: 8px; }
    `}</style>
    <span className="column-select-multi-wrap" style={wrapStyle}>
      <Button aria-label="変数を選択" title="変数を選択" icon={<SearchOutlined />} size={props.size}
        onClick={() => { if (!props.disabled) { setTmpValue(null); setDialogSearch(''); handleOpenChange(false); setPickerOpen(true) } }}
        className="column-select-search-btn" disabled={props.disabled} />
      <Select {...selectProps} ref={ref} value={value} onChange={change}
        getPopupContainer={selectProps.getPopupContainer ?? (() => document.body)}
        showSearch={isMultiple ? false : (selectProps.showSearch ?? true)}
        filterOption={isMultiple ? undefined : (selectProps.filterOption ?? ((input: string, option: any) => searchText(option).includes(input.toLocaleLowerCase())))}
        className={`column-select-input ${isMultiple ? 'column-select-multi-fix' : ''} ${className ?? ''}`}
        style={{ ...innerStyle, flex: 1, minWidth: 0 }}
        optionRender={selectProps.optionRender ?? ((option: any) => renderValue(option.value, option.label))}
        labelRender={selectProps.labelRender ?? ((option: any) => renderLabel(option.value, option.label))}
        tagRender={selectProps.tagRender ?? ((tag: any) => <Tag style={{ display: 'inline-flex', alignItems: 'center', maxWidth: 'min(320px, 100%)', minWidth: 0 }} closable={!props.disabled && tag.closable} onClose={tag.onClose} onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}>
          {renderValue(tag.value, tag.label)}
        </Tag>)}
        onInputKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
          selectProps.onInputKeyDown?.(event)
          const input = event.currentTarget
          requestAnimationFrame(() => {
            const element = document.getElementById(input.getAttribute('aria-activedescendant') ?? '')
            const text = element?.getAttribute('aria-label') ?? element?.textContent
            const option = options.find((o: any) => String(o.label ?? o.value) === text || String(o.value) === text)
            setActive(option ? String(option.value) : null)
          })
        }}
        open={props.open ?? dropdownOpen} onOpenChange={handleOpenChange}
        notFoundContent={emptyGuide ?? selectProps.notFoundContent}
        popupRender={(menu: React.ReactNode) => <>{dropdownRender ? dropdownRender(menu) : selectProps.popupRender ? selectProps.popupRender(menu) : menu}
          {active && <div aria-live="polite" style={{ padding: 8, whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto' }}>{activeOption?.questionText ?? <ColumnQuestionText nameOrId={active} />}</div>}
        </>} />
    </span>
    <Modal title="変数を選択" zIndex={1050} open={pickerOpen} onCancel={() => setPickerOpen(false)} onDeactivate={() => setPickerOpen(false)}
      okText="決定" cancelText="キャンセル" getContainer={() => document.body}
      okButtonProps={{ disabled: props.disabled || (!isMultiple && dialogValue.length === 0 && !props.allowClear) || dialogValue.length > maxCount }}
      footer={(_, { OkBtn, CancelBtn }) => <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
        <span role="status" style={{ fontSize: 12, color: '#666' }}>{dialogValue.length}件選択中{hiddenCount ? `（検索結果外 ${hiddenCount}件）` : ''}{maxCount !== Infinity ? ` / 上限 ${maxCount}件` : ''}</span>
        <span style={{ display: 'inline-flex', gap: 8 }}><CancelBtn /><OkBtn /></span>
      </div>}
      onOk={() => {
        if (props.disabled || dialogValue.length > maxCount) return
        const next = isMultiple ? dialogValue : dialogValue[0]
        change(next, isMultiple ? dialogValue.map(v => options.find((o: any) => o.value === v)) : options.find((o: any) => o.value === next))
        setPickerOpen(false)
      }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <Input aria-label="変数名・質問文で絞り込み" placeholder="変数名・質問文で絞り込み" value={dialogSearch}
          onChange={e => setDialogSearch(e.target.value)} allowClear disabled={props.disabled} style={{ flex: '1 1 220px' }} />
        {isMultiple ? <>
          <Button type="link" disabled={props.disabled || !eligibleOptions.length || dialogValue.length >= maxCount} onClick={() => {
            const next = [...dialogValue]
            for (const option of eligibleOptions) if (!next.includes(option.value) && next.length < maxCount) next.push(option.value)
            setTmpValue(next)
          }}>検索結果を全選択（{eligibleOptions.length}件）</Button>
          <Button type="link" disabled={props.disabled || !eligibleOptions.some((o: any) => dialogValue.includes(o.value))}
            onClick={() => setTmpValue(dialogValue.filter(v => !eligibleOptions.some((o: any) => o.value === v)))}>検索結果を全解除</Button>
        </> : props.allowClear && <Button type="link" disabled={props.disabled} onClick={() => setTmpValue([])}>選択解除</Button>}
      </div>
      <div role={isMultiple ? 'group' : 'radiogroup'} aria-label="検索結果" style={{ maxHeight: 320, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {dialogOptions.map((o: any) => {
          const { primary, secondary } = details(o)
          const label = <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{primary}{secondary && <small style={{ color: '#666', display: 'block' }}>{secondary}</small>}</span>
          const checked = dialogValue.includes(o.value)
          return isMultiple
            ? <Checkbox key={String(o.value)} checked={checked} disabled={props.disabled || o.disabled || (!checked && dialogValue.length >= maxCount)} onChange={e => setOption(o, e.target.checked)} style={{ marginInlineStart: 0 }}>{label}</Checkbox>
            : <Radio key={String(o.value)} name="column-select-dialog" checked={checked} disabled={props.disabled || o.disabled} onChange={() => setOption(o, true)} style={{ marginInlineStart: 0 }}>{label}</Radio>
        })}
        {dialogOptions.length === 0 && (emptyGuide ?? <div style={{ color: '#999', padding: 8 }}>該当する変数がありません</div>)}
      </div>
    </Modal>
  </>
}) as unknown as typeof Select & { Option: typeof Select.Option; OptGroup: typeof Select.OptGroup }
type ColumnSelectType = typeof Select & { Option: typeof Select.Option; OptGroup: typeof Select.OptGroup; (props: any): React.ReactNode }
const TypedColumnSelect = ColumnSelect as unknown as ColumnSelectType
TypedColumnSelect.Option = Select.Option
TypedColumnSelect.OptGroup = Select.OptGroup
export default TypedColumnSelect
