import React, { useState, useEffect } from 'react'
import { Modal, Input, Select, Button, Space, Typography, List, Card, message } from 'antd'
import { ArrowRightOutlined, ArrowLeftOutlined, UpOutlined, DownOutlined, BarChartOutlined } from '@ant-design/icons'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import type { RootState, AppDispatch } from '../../app/store'
import { activeVariablesSet, variableOrderReordered } from '../../app/store'

interface VariableSelectionModalProps {
  open: boolean
  onClose: () => void
}

export const VariableSelectionModal: React.FC<VariableSelectionModalProps> = ({ open, onClose }) => {
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const globalVars = useSelector((s: RootState) => s.globalVariables)
  const [searchTerm, setSearchTerm] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | 'numeric' | 'nominal'>('all')

  const [availableList, setAvailableList] = useState<string[]>([])
  const [selectedList, setSelectedList] = useState<string[]>([])
  const [selectedAvailable, setSelectedAvailable] = useState<string[]>([])
  const [selectedActive, setSelectedActive] = useState<string[]>([])

  useEffect(() => {
    if (open) {
      const activeSet = new Set(globalVars.activeVariableIds)
      const order = globalVars.variableOrder.length > 0 ? globalVars.variableOrder : globalVars.allVariables
      
      const sel = order.filter((id) => activeSet.has(id))
      const avail = globalVars.allVariables.filter((id) => !activeSet.has(id))
      
      setSelectedList(sel)
      setAvailableList(avail)
      setSelectedAvailable([])
      setSelectedActive([])
    }
  }, [open, globalVars])

  const matchesFilter = (varName: string) => {
    if (searchTerm && !varName.toLowerCase().includes(searchTerm.toLowerCase())) return false
    const meta = globalVars.variableMeta[varName]
    if (typeFilter === 'numeric') return meta?.semanticType === 'numeric'
    if (typeFilter === 'nominal') return meta?.semanticType === 'nominal' || meta?.semanticType === 'ordinal' || meta?.semanticType === 'text'
    return true
  }

  const moveToSelected = () => {
    if (selectedAvailable.length === 0) return
    const toMove = new Set(selectedAvailable)
    setAvailableList((prev) => prev.filter((id) => !toMove.has(id)))
    setSelectedList((prev) => [...prev, ...selectedAvailable])
    setSelectedAvailable([])
  }

  const moveToAvailable = () => {
    if (selectedActive.length === 0) return
    const toMove = new Set(selectedActive)
    setSelectedList((prev) => prev.filter((id) => !toMove.has(id)))
    setAvailableList((prev) => [...prev, ...selectedActive])
    setSelectedActive([])
  }

  const moveUp = () => {
    if (selectedActive.length !== 1) return
    const id = selectedActive[0]
    const idx = selectedList.indexOf(id)
    if (idx <= 0) return
    const next = [...selectedList]
    next[idx] = next[idx - 1]
    next[idx - 1] = id
    setSelectedList(next)
  }

  const moveDown = () => {
    if (selectedActive.length !== 1) return
    const id = selectedActive[0]
    const idx = selectedList.indexOf(id)
    if (idx < 0 || idx >= selectedList.length - 1) return
    const next = [...selectedList]
    next[idx] = next[idx + 1]
    next[idx + 1] = id
    setSelectedList(next)
  }

  const handleApply = () => {
    if (selectedList.length === 0) {
      message.warning('少なくとも1つの変数を選択してください。')
      return
    }
    dispatch(activeVariablesSet(selectedList))
    const remaining = globalVars.allVariables.filter((id) => !selectedList.includes(id))
    dispatch(variableOrderReordered([...selectedList, ...remaining]))
    message.success(`変数選択を更新しました（${selectedList.length}変数）`)
    onClose()
  }

  const filteredAvailable = availableList.filter(matchesFilter)
  const filteredSelected = selectedList.filter(matchesFilter)

  return (
    <Modal
      title="変数マネージャ (Variable Selection Manager)"
      open={open}
      onCancel={onClose}
      width={720}
      footer={[
        <Button
          key="ranking"
          icon={<BarChartOutlined />}
          style={{ float: 'left' }}
          onClick={() => {
            onClose()
            navigate('/ranking')
          }}
          data-testid="var-manager-ranking-link"
        >
          特徴量ランキングから上位を選択 (Top-K)
        </Button>,
        <Button key="cancel" onClick={onClose}>
          キャンセル
        </Button>,
        <Button key="apply" type="primary" onClick={handleApply} data-testid="var-manager-apply-btn">
          適用 (Apply)
        </Button>,
      ]}
      data-testid="variable-selection-modal"
    >
      <Space direction="horizontal" style={{ width: '100%', marginBottom: 12 }} wrap>
        <Input.Search
          placeholder="変数名を検索..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: 260 }}
          allowClear
          data-testid="var-manager-search"
        />
        <Select
          value={typeFilter}
          onChange={(v) => setTypeFilter(v)}
          style={{ width: 140 }}
          data-testid="var-manager-type-filter"
          options={[
            { value: 'all', label: 'すべての型' },
            { value: 'numeric', label: '数値型のみ' },
            { value: 'nominal', label: 'カテゴリ型のみ' },
          ]}
        />
      </Space>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        {/* Left Column: Available */}
        <Card
          size="small"
          title={`利用可能変数 (Available: ${availableList.length})`}
          style={{ flex: 1, height: 350, display: 'flex', flexDirection: 'column' }}
          bodyStyle={{ flex: 1, overflow: 'auto', padding: 4 }}
        >
          <List
            size="small"
            dataSource={filteredAvailable}
            renderItem={(item) => {
              const isSel = selectedAvailable.includes(item)
              const meta = globalVars.variableMeta[item]
              return (
                <List.Item
                  style={{
                    padding: '4px 8px',
                    cursor: 'pointer',
                    background: isSel ? '#e6f7ff' : 'transparent',
                    borderRadius: 4,
                  }}
                  onClick={() => {
                    setSelectedAvailable((prev) =>
                      prev.includes(item) ? prev.filter((i) => i !== item) : [...prev, item]
                    )
                  }}
                  onDoubleClick={() => {
                    setAvailableList((prev) => prev.filter((id) => id !== item))
                    setSelectedList((prev) => [...prev, item])
                    setSelectedAvailable((prev) => prev.filter((id) => id !== item))
                  }}
                  data-testid={`var-available-${item}`}
                >
                  <Space direction="horizontal" style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Typography.Text>{item}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {meta?.semanticType ?? 'variable'}
                    </Typography.Text>
                  </Space>
                </List.Item>
              )
            }}
          />
        </Card>

        {/* Center Move Buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Button
            icon={<ArrowRightOutlined />}
            onClick={moveToSelected}
            disabled={selectedAvailable.length === 0}
            data-testid="var-move-to-selected"
            title="選択に追加"
          />
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={moveToAvailable}
            disabled={selectedActive.length === 0}
            data-testid="var-move-to-available"
            title="選択から除外"
          />
        </div>

        {/* Right Column: Selected */}
        <Card
          size="small"
          title={`選択・表示変数 (Active: ${selectedList.length})`}
          extra={
            <Space size={4}>
              <Button
                size="small"
                icon={<UpOutlined />}
                disabled={selectedActive.length !== 1 || selectedList.indexOf(selectedActive[0]) <= 0}
                onClick={moveUp}
                title="上へ"
                data-testid="var-move-up"
              />
              <Button
                size="small"
                icon={<DownOutlined />}
                disabled={
                  selectedActive.length !== 1 ||
                  selectedList.indexOf(selectedActive[0]) === selectedList.length - 1
                }
                onClick={moveDown}
                title="下へ"
                data-testid="var-move-down"
              />
            </Space>
          }
          style={{ flex: 1, height: 350, display: 'flex', flexDirection: 'column' }}
          bodyStyle={{ flex: 1, overflow: 'auto', padding: 4 }}
        >
          <List
            size="small"
            dataSource={filteredSelected}
            renderItem={(item, index) => {
              const isSel = selectedActive.includes(item)
              const meta = globalVars.variableMeta[item]
              return (
                <List.Item
                  style={{
                    padding: '4px 8px',
                    cursor: 'pointer',
                    background: isSel ? '#e6f7ff' : 'transparent',
                    borderRadius: 4,
                  }}
                  onClick={() => {
                    setSelectedActive((prev) =>
                      prev.includes(item) ? prev.filter((i) => i !== item) : [...prev, item]
                    )
                  }}
                  onDoubleClick={() => {
                    setSelectedList((prev) => prev.filter((id) => id !== item))
                    setAvailableList((prev) => [...prev, item])
                    setSelectedActive((prev) => prev.filter((id) => id !== item))
                  }}
                  data-testid={`var-active-${item}`}
                >
                  <Space direction="horizontal" style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Typography.Text>
                      {index + 1}. {item}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {meta?.semanticType ?? 'variable'}
                    </Typography.Text>
                  </Space>
                </List.Item>
              )
            }}
          />
        </Card>
      </div>
    </Modal>
  )
}

export default VariableSelectionModal
