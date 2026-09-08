import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import { type FC } from 'react'
import { Card, Radio, Space, Tag, Typography } from 'antd'
import type { LineMosaicTarget } from './types'

interface MosaicControlPanelProps {
  allColumns: string[]
  colVars: string[]
  onColVarsChange: (vars: string[]) => void
  rowVars: string[]
  onRowVarsChange: (vars: string[]) => void
  targetVar: string | null
  onTargetVarChange: (target: string | null) => void
  normalization: 'global' | 'row'
  onNormalizationChange: (norm: 'global' | 'row') => void
  targetInfo: LineMosaicTarget | null
}

export const MosaicControlPanel: FC<MosaicControlPanelProps> = ({
  allColumns,
  colVars,
  onColVarsChange,
  rowVars,
  onRowVarsChange,
  targetVar,
  onTargetVarChange,
  normalization,
  onNormalizationChange,
  targetInfo,
}) => {
  return (
    <Card
      size="small"
      style={{ width: '100%', borderRadius: 8, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}
      data-testid="mosaic-controls"
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
        {/* Column variables (Horizontal / J) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Typography.Text strong style={{ fontSize: 12 }}>列変数 (奇数層):</Typography.Text>
          <Select
            mode="multiple"
            style={{ minWidth: 200, maxWidth: 360 }}
            placeholder="列変数を選択"
            value={colVars}
            onChange={onColVarsChange}
            options={allColumns.map((c) => ({ label: c, value: c }))}
            data-testid="mosaic-col-vars"
          />
        </div>

        {/* Row variables (Vertical / I) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Typography.Text strong style={{ fontSize: 12 }}>行変数 (偶数層):</Typography.Text>
          <Select
            mode="multiple"
            style={{ minWidth: 180, maxWidth: 320 }}
            placeholder="行変数を選択"
            value={rowVars}
            onChange={onRowVarsChange}
            options={allColumns.map((c) => ({ label: c, value: c }))}
            data-testid="mosaic-row-vars"
          />
        </div>

        {/* Target variable */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Typography.Text strong style={{ fontSize: 12 }}>目的変数 (Target):</Typography.Text>
          <Select
            style={{ width: 160 }}
            placeholder="なし"
            allowClear
            value={targetVar ?? undefined}
            onChange={(val) => onTargetVarChange(val ?? null)}
            options={allColumns.map((c) => ({ label: c, value: c }))}
            data-testid="mosaic-target-select"
          />
        </div>

        {/* Normalization Radio */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Typography.Text strong style={{ fontSize: 12 }}>スケール:</Typography.Text>
          <Radio.Group
            value={normalization}
            onChange={(e) => onNormalizationChange(e.target.value)}
            size="small"
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="global">全体最大値</Radio.Button>
            <Radio.Button value="row">行ごと最大値</Radio.Button>
          </Radio.Group>
        </div>

        {/* Target Legend */}
        {targetInfo && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            <Typography.Text style={{ fontSize: 12, color: '#666' }}>
              <ColumnQuestionTooltip nameOrId={targetInfo.name}>{targetInfo.name}</ColumnQuestionTooltip>:
            </Typography.Text>
            <Space size={4}>
              {targetInfo.categories.map((cat, idx) => (
                <Tag
                  key={cat}
                  color={targetInfo.colors[idx % targetInfo.colors.length]}
                  style={{ marginRight: 0, fontWeight: 'bold' }}
                >
                  {cat}
                </Tag>
              ))}
            </Space>
          </div>
        )}
      </div>
    </Card>
  )
}
