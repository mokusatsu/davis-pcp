import { Alert, Space, Typography } from 'antd'

export interface DiscriminantDiagnosticsData {
  inputDimensions: number
  usedDimensions: number
  sampleCount: number
  classCounts: Record<string, number>
  totalRank: number
  withinClassRank: number
  collinear: boolean
  singularWithinClassCovariance: boolean
  qdaSmallClasses: string[]
}

export default function DiscriminantDiagnostics({ value }: { value: DiscriminantDiagnosticsData }) {
  return <Space direction="vertical" style={{ width: '100%', marginTop: 12 }} aria-label="判別分析の入力診断">
    <Typography.Text>使用行: {value.sampleCount} ・ 入力次元: {value.inputDimensions} ・ 使用次元: {value.usedDimensions}
      {' ・ '}クラス人数: {Object.entries(value.classCounts).map(([label, count]) => `${label}: ${count}`).join(' / ')}</Typography.Text>
    {value.collinear && <Alert type="warning" showIcon message="説明変数に共線性があります。"
      description={`使用${value.usedDimensions}次元に対して独立な次元は${value.totalRank}です。重複する変数や同じMA親の選択肢構成を確認してください。`} />}
    {value.singularWithinClassCovariance && <Alert type="warning" showIcon message="クラス内の共分散行列が特異です。"
      description={`クラス内の独立な次元は${value.withinClassRank}/${value.usedDimensions}です。使用変数・クラス人数・縮小推定の設定を確認してください。`} />}
    {value.qdaSmallClasses.length > 0 && <Alert type="warning" showIcon message="QDAのクラス人数が使用次元に対して不足しています。"
      description={`対象クラス: ${value.qdaSmallClasses.join(', ')}。各クラスの共分散推定が不安定になるため、変数数やクラス構成を見直してください。`} />}
  </Space>
}
