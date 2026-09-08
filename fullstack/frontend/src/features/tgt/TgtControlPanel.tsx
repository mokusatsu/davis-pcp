import Select from '../common/ColumnSelect'
import { type FC } from 'react'
import { Button, Checkbox, Slider, Space, Tag, Typography } from 'antd'
import { CaretRightOutlined, PauseOutlined, RedoOutlined, StepForwardOutlined } from '@ant-design/icons'

interface TgtControlPanelProps {
  columns: string[]
  selectedColumns: string[]
  onColumnsChange: (cols: string[]) => void
  isPlaying: boolean
  onTogglePlay: () => void
  onStep: () => void
  onReset: () => void
  speed: number
  onSpeedChange: (speed: number) => void
  isTracking: boolean
  onToggleTracking: (enabled: boolean) => void
  trailLength: number
  onTrailLengthChange: (length: number) => void
}

export const TgtControlPanel: FC<TgtControlPanelProps> = ({
  columns,
  selectedColumns,
  onColumnsChange,
  isPlaying,
  onTogglePlay,
  onStep,
  onReset,
  speed,
  onSpeedChange,
  isTracking,
  onToggleTracking,
  trailLength,
  onTrailLengthChange,
}) => {
  return (
    <div
      style={{
        background: '#fff',
        padding: '10px 16px',
        borderRadius: 8,
        border: '1px solid #e8e8e8',
        boxShadow: '0 2px 6px rgba(0, 0, 0, 0.06)',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 16,
      }}
    >
      {/* Play / Pause / Step / Reset */}
      <Space>
        <Button
          type={isPlaying ? 'default' : 'primary'}
          icon={isPlaying ? <PauseOutlined /> : <CaretRightOutlined />}
          onClick={onTogglePlay}
          data-testid="tgt-play-pause"
        >
          {isPlaying ? '一時停止 (Space)' : '再生 (Space)'}
        </Button>
        <Button
          icon={<StepForwardOutlined />}
          disabled={isPlaying}
          onClick={onStep}
          data-testid="tgt-step"
        >
          1コマ送り (.)
        </Button>
        <Button
          icon={<RedoOutlined />}
          onClick={onReset}
          data-testid="tgt-reset"
        >
          視点リセット (R)
        </Button>
      </Space>

      {/* Speed Slider */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 160 }}>
        <Typography.Text style={{ fontSize: 12 }}>速度:</Typography.Text>
        <Slider
          min={0.2}
          max={3.0}
          step={0.1}
          value={speed}
          onChange={onSpeedChange}
          style={{ flex: 1, margin: '0 6px' }}
        />
        <Typography.Text style={{ fontSize: 11, width: 32 }}>{speed.toFixed(1)}x</Typography.Text>
      </div>

      {/* Tracking Toggle & Length */}
      <Space style={{ display: 'flex', alignItems: 'center' }}>
        <Checkbox
          checked={isTracking}
          onChange={(e) => onToggleTracking(e.target.checked)}
          data-testid="tgt-tracking-toggle"
        >
          Tracking軌跡
        </Checkbox>
        {isTracking && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 140 }}>
            <Typography.Text style={{ fontSize: 11 }}>残像:</Typography.Text>
            <Slider
              min={4}
              max={24}
              step={2}
              value={trailLength}
              onChange={onTrailLengthChange}
              style={{ flex: 1, margin: '0 6px' }}
            />
            <Typography.Text style={{ fontSize: 11, width: 24 }}>{trailLength}F</Typography.Text>
          </div>
        )}
      </Space>

      {/* Column Multi-Select */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
        <Typography.Text style={{ fontSize: 12 }}>対象変数 (3軸以上):</Typography.Text>
        <Select
          mode="multiple"
          style={{ minWidth: 240, maxWidth: 420 }}
          value={selectedColumns}
          onChange={onColumnsChange}
          options={columns.map((c) => ({ label: c, value: c }))}
          data-testid="tgt-columns-select"
        />
        <Tag color={isPlaying ? 'processing' : 'warning'}>
          {isPlaying ? 'Touring (Geodesic)' : 'Frozen (矩形ブラシ可能)'}
        </Tag>
      </div>
    </div>
  )
}
