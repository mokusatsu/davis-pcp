import { forwardRef, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Input, Modal, Select, Tag } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import ColumnQuestionTooltip, { ColumnQuestionText, QuestionTooltip } from './ColumnQuestionTooltip'
import { useCodebook } from '../dataset/useCodebookColumn'

export interface ColumnSelectEmptyHint {
  roleLabel: string
  onOpenCodebook: () => void
}

/** Keep option values/search text intact; decorate only their presentation. */
const ColumnSelect = forwardRef<any, any>((props, ref) => {
  const [active, setActive] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [dialogSearch, setDialogSearch] = useState('')
  const [tmpValue, setTmpValue] = useState<any[] | null>(null)
  const { getColumn } = useCodebook()
  const options = (props.options ?? []).flatMap((o: any) => o.options ?? [o])
  const isMultiple = props.mode === 'multiple'
  const committed = Array.isArray(props.value) ? props.value : (props.value == null ? [] : [props.value])
  const dialogValue = tmpValue ?? committed
  const { emptyHint, onDropdownVisibleChange: _onDropdownVisibleChange, dropdownRender: _dropdownRender, onOpenChange: _parentOnOpenChange, ...selectProps } = props as any
  const hint = emptyHint as ColumnSelectEmptyHint | undefined
  const prevOpen = useRef<boolean | null>(null)
  const handleOpenChange = (visible: boolean, notify: (v: boolean) => void) => {
    if (!visible) setActive(null)
    setDropdownOpen(visible)
    if (prevOpen.current !== visible) {
      prevOpen.current = visible
      notify(visible)
    }
  }
  const openCodebook = () => {
    setPickerOpen(false)
    setDropdownOpen(false)
    hint?.onOpenCodebook()
  }
  const emptyGuide = hint && options.length === 0 ? (
    <div style={{ padding: 12, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
      <span style={{ whiteSpace: 'pre-line' }}>{`${hint.roleLabel}変数がありません\nコードブックで${hint.roleLabel}変数を指定してください`}</span>
      <Button size="small" onClick={openCodebook}>コードブックを開く</Button>
    </div>
  ) : undefined
  const presentation = (value: any, fallback?: React.ReactNode) => {
    const option = options.find((o: any) => o.value === value)
    const column = getColumn(String(value))
    const name = option?.questionName ?? column?.name ?? String(value)
    const label = option?.questionText ?? column?.label
    return label?.trim() ? `${name} — ${label}` : (option?.label ?? fallback ?? value)
  }
  // Selected-value surface: plain text only. A nested ⓘ button inside
  // labelRender swallows the mousedown that opens the dropdown, so the info
  // icon lives only in the dropdown options (optionRender).
  const renderLabel = (value: any, fallback?: React.ReactNode) =>
    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{presentation(value, fallback)}</span>
  const renderValue = (value: any, fallback?: React.ReactNode) => {
    const info = question(value, undefined, true)
    if (!info) return renderLabel(value, fallback)
    return <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0, maxWidth: '100%', width: '100%' }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{presentation(value, fallback)}</span>
      {info}
    </span>
  }
  const question = (value: any, children?: React.ReactNode, info = false) => {
    const option = options.find((o: any) => o.value === value)
    const column = getColumn(String(value))
    // No question text anywhere: render nothing so the selector keeps its
    // native open/close behavior instead of a nested interactive element.
    if (!option?.questionText && !column?.label?.trim()) return null
    return option?.questionText
      ? <QuestionTooltip nameOrId={option.questionName ?? String(value)} question={option.questionText} tabIndex={-1} passive={!info} info={info}>{children}</QuestionTooltip>
      : <ColumnQuestionTooltip nameOrId={String(value)} tabIndex={-1} passive={!info} info={info}>{children}</ColumnQuestionTooltip>
  }
  const activeOption = options.find((o: any) => String(o.value) === active)

  const dialogOptions = useMemo(() => {
    const q = dialogSearch.trim().toLocaleLowerCase()
    if (!q) return options
    return options.filter((o: any) =>
      `${o.value ?? ''} ${o.label ?? ''} ${o.questionName ?? ''} ${o.questionText ?? ''} ${presentation(o.value)}`.toLocaleLowerCase().includes(q))
  }, [options, dialogSearch])

  const openPicker = () => {
    setTmpValue(null)
    setDialogSearch('')
    setPickerOpen(true)
  }

  const select = (
    <Select {...selectProps} ref={ref}
      getPopupContainer={selectProps.getPopupContainer ?? (() => document.body)}
      // 複数選択では検索入力を出さない（選択は🔍ダイアログで行う）
      showSearch={isMultiple ? false : (selectProps.showSearch ?? true)}
      filterOption={isMultiple ? undefined : (selectProps.filterOption ?? ((input: string, option: any) => `${option?.value ?? ''} ${option?.label ?? ''} ${presentation(option?.value)}`.toLocaleLowerCase().includes(input.toLocaleLowerCase())))}
      optionRender={selectProps.optionRender ?? ((option: any) => renderValue(option.value, option.label))}
      labelRender={selectProps.labelRender ?? ((option: any) => renderLabel(option.value, option.label))}
      tagRender={selectProps.tagRender ?? ((tag: any) => <Tag style={{ display: 'inline-flex', alignItems: 'center', maxWidth: 'min(320px, 100%)', minWidth: 0 }} closable={tag.closable} onClose={tag.onClose} onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}>
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
      onOpenChange={(visible: boolean) => handleOpenChange(visible, (v) => { _onDropdownVisibleChange?.(v); _parentOnOpenChange?.(v) })}
      notFoundContent={emptyGuide ?? selectProps.notFoundContent}
      popupRender={(menu: React.ReactNode) => <>{_dropdownRender ? _dropdownRender(menu) : selectProps.popupRender ? selectProps.popupRender(menu) : menu}
        {active && <div aria-live="polite" style={{ padding: 8, whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto' }}>{activeOption?.questionText ?? <ColumnQuestionText nameOrId={active} />}</div>}
      </>}
    />
  )

  if (!isMultiple) return select

  const currentCount = committed.length
  const { style: selectStyle, className: selectClassName, disabled: selectDisabled,
    onDropdownVisibleChange: _mDropdownVisibleChange, dropdownRender: _mDropdownRender, onOpenChange: _mOnOpenChange, ...restSelectProps } = selectProps
  // width/margin はラッパーに引き継ぎ、内側 Select からは除外（ボタンとのずれ防止）
  const { width: wrapWidth, margin: wrapMargin, marginTop: wrapMarginTop, ...innerSelectStyle } = selectStyle ?? {}
  const wrapStyle: React.CSSProperties | undefined = (wrapWidth != null || wrapMargin != null || wrapMarginTop != null)
    ? { width: wrapWidth, margin: wrapMargin, marginTop: wrapMarginTop } : undefined
  const selectWithFix = (
    <Select {...restSelectProps} ref={ref}
      getPopupContainer={restSelectProps.getPopupContainer ?? (() => document.body)}
      showSearch={false}
      filterOption={undefined}
      className={`column-select-multi-fix ${selectClassName ?? ''}`}
      style={{ flex: 1, minWidth: 0, ...innerSelectStyle }}
      optionRender={restSelectProps.optionRender ?? ((option: any) => renderValue(option.value, option.label))}
      labelRender={restSelectProps.labelRender ?? ((option: any) => renderLabel(option.value, option.label))}
      tagRender={restSelectProps.tagRender ?? ((tag: any) => <Tag style={{ display: 'inline-flex', alignItems: 'center', maxWidth: 'min(320px, 100%)', minWidth: 0 }} closable={tag.closable} onClose={tag.onClose} onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}>
        {renderValue(tag.value, tag.label)}
      </Tag>)}
      onInputKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
        restSelectProps.onInputKeyDown?.(event)
        const input = event.currentTarget
        requestAnimationFrame(() => {
          const element = document.getElementById(input.getAttribute('aria-activedescendant') ?? '')
          const text = element?.getAttribute('aria-label') ?? element?.textContent
          const option = options.find((o: any) => String(o.label ?? o.value) === text || String(o.value) === text)
          setActive(option ? String(option.value) : null)
        })
      }}
      open={dropdownOpen}
      onOpenChange={(visible: boolean) => handleOpenChange(visible, (v) => { _mDropdownVisibleChange?.(v); _mOnOpenChange?.(v) })}
      notFoundContent={emptyGuide ?? restSelectProps.notFoundContent}
      popupRender={(menu: React.ReactNode) => <>{_mDropdownRender ? _mDropdownRender(menu) : (restSelectProps as any).popupRender ? (restSelectProps as any).popupRender(menu) : menu}
        {active && <div aria-live="polite" style={{ padding: 8, whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto' }}>{activeOption?.questionText ?? <ColumnQuestionText nameOrId={active} />}</div>}
      </>}
    />
  )

  return (
    <>
      <style>{`
        .column-select-multi-wrap { display: inline-flex; align-items: stretch; vertical-align: middle; max-width: 100%; }
        .column-select-multi-wrap .column-select-search-btn { border-start-end-radius: 0 !important; border-end-end-radius: 0 !important; border-inline-end: none; flex-shrink: 0; align-self: stretch; height: auto; padding-inline: 8px; }
        .column-select-multi-wrap .column-select-multi-fix { margin-left: 1px; }
        .column-select-multi-wrap .column-select-multi-fix .ant-select-selector { border-start-start-radius: 0 !important; border-end-start-radius: 0 !important; }
        /* タグ表示は最大2行まで（はみ出しは🔍ダイアログで確認・操作） */
        .column-select-multi-wrap .column-select-multi-fix .ant-select-selection-overflow { max-height: 52px; overflow: hidden; }
        .column-select-multi-wrap .column-select-multi-fix.ant-select-sm .ant-select-selection-overflow { max-height: 44px; }
        /* ×（全解除）と∨（開閉）を横並びにして重なりを解消 */
        .column-select-multi-wrap .column-select-multi-fix.ant-select-allow-clear .ant-select-clear { right: 30px; opacity: 1; }
        .column-select-multi-wrap .column-select-multi-fix .ant-select-arrow { right: 8px; }
      `}</style>
      <span className="column-select-multi-wrap" style={wrapStyle}>
        <Button
          aria-label="変数を選択"
          title="変数を選択"
          icon={<SearchOutlined />}
          onClick={openPicker}
          className="column-select-search-btn"
          disabled={selectDisabled}
        />
        {selectWithFix}
      </span>
      <Modal
        title="変数を選択"
        zIndex={1050}
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        okText="決定"
        cancelText="キャンセル"
        getContainer={() => document.body}
        footer={(_, { OkBtn, CancelBtn }) => (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#666' }}>{dialogValue.length}件選択中{currentCount !== dialogValue.length ? `（現在 ${currentCount}件）` : ''}</span>
            <span style={{ display: 'inline-flex', gap: 8 }}><CancelBtn /><OkBtn /></span>
          </div>
        )}
        onOk={() => { selectProps.onChange?.(dialogValue, dialogValue.map((v) => options.find((o: any) => o.value === v))); setPickerOpen(false) }}
      >
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Input
            placeholder="変数名・質問文で絞り込み"
            value={dialogSearch}
            onChange={(e) => setDialogSearch(e.target.value)}
            allowClear
            style={{ flex: 1 }}
          />
          <Button type="link" onClick={() => setTmpValue(options.filter((o: any) => !o.disabled).map((o: any) => o.value))}>全選択</Button>
          <Button type="link" onClick={() => setTmpValue([])}>全解除</Button>
        </div>
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          <Checkbox.Group
            value={dialogValue}
            onChange={(v) => setTmpValue(v as any[])}
            style={{ display: 'flex', flexDirection: 'column', gap: 2, width: '100%' }}
          >
            {dialogOptions.map((o: any) => (
              <Checkbox key={String(o.value)} value={o.value} disabled={o.disabled} style={{ marginInlineStart: 0 }}>
                <span>{presentation(o.value, o.label)}</span>
                {(o.questionText ?? getColumn(String(o.value))?.label?.trim()) && (
                  <small style={{ color: '#888', display: 'block' }}>{o.questionText ?? getColumn(String(o.value))?.label}</small>
                )}
              </Checkbox>
            ))}
          </Checkbox.Group>
          {dialogOptions.length === 0 && (emptyGuide ?? <div style={{ color: '#999', padding: 8 }}>該当する変数がありません</div>)}
        </div>
      </Modal>
    </>
  )
}) as unknown as typeof Select & { Option: typeof Select.Option; OptGroup: typeof Select.OptGroup }
type ColumnSelectType = typeof Select & { Option: typeof Select.Option; OptGroup: typeof Select.OptGroup; (props: any): React.ReactNode }
const TypedColumnSelect = ColumnSelect as unknown as ColumnSelectType
TypedColumnSelect.Option = Select.Option
TypedColumnSelect.OptGroup = Select.OptGroup

export default TypedColumnSelect
