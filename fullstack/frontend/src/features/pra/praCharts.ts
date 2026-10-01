import type { EChartsOption } from 'echarts'
import type { PraAttribute } from './PenaltyRewardPage'

const COLORS: Record<string, string> = { basic: '#d4380d', performance: '#1677ff', excitement: '#389e0d', indifferent: '#8c8c8c' }
const tooltip = (p: any) => p.data?.description ?? ''
const description = (a: PraAttribute) => `${a.label}\n既存モデルによる分類: ${a.class_label}\n低評価側係数 β_low: ${a.penalty.coef.toPrecision(4)}\nSE=${a.penalty.se}, p=${a.penalty.p}, 95% CI=[${a.penalty.ci.join(', ')}]\n高評価側係数 β_high: ${a.reward.coef.toPrecision(4)}\nSE=${a.reward.se}, p=${a.reward.p}, 95% CI=[${a.reward.ci.join(', ')}]\n不満回答者: ${a.n_dissatisfied}`

export function kanoOption(attributes: PraAttribute[], selected: string | null, selectedRowIds: string[] = []): EChartsOption {
  return {
    grid: { left: 80, right: 44, top: 64, bottom: 64 },
    legend: { top: 8 },
    tooltip: { trigger: 'item', renderMode: 'richText', formatter: tooltip },
    xAxis: { type: 'value', name: '低評価側係数 β_low', nameLocation: 'middle', nameGap: 35, min: extent => Math.min(0, extent.min), max: extent => Math.max(0, extent.max) },
    yAxis: { type: 'value', name: '高評価側係数 β_high', nameLocation: 'middle', nameGap: 50, min: extent => Math.min(0, extent.min), max: extent => Math.max(0, extent.max) },
    series: Object.entries(COLORS).map(([classification, color]) => ({
      itemStyle: { color },
      type: 'scatter', name: attributes.find(a => a.classification === classification)?.class_label ?? classification,
      data: attributes.filter(a => a.classification === classification).map(a => ({
        name: a.name, value: [a.penalty.coef, a.reward.coef], description: description(a),
        symbolSize: (a.name === selected || a.dissatisfied_row_ids.some(id => selectedRowIds.includes(id))) ? 20 : 14,
        itemStyle: { color, borderColor: (a.name === selected || a.dissatisfied_row_ids.some(id => selectedRowIds.includes(id))) ? '#2a78d6' : '#fff', borderWidth: (a.name === selected || a.dissatisfied_row_ids.some(id => selectedRowIds.includes(id))) ? 3 : 1 },
        label: { show: true, formatter: () => a.label, position: 'right', fontSize: 11, color: '#333' },
      })),
      markLine: { silent: true, symbol: 'none', label: { show: false }, data: [{ xAxis: 0 }, { yAxis: 0 }] },
    })),
  }
}

export function praImpactOption(attributes: PraAttribute[], selected: string | null, selectedRowIds: string[] = []): EChartsOption {
  return {
    grid: { left: 150, right: 42, top: 45, bottom: 45 },
    legend: { top: 4 },
    tooltip: { trigger: 'item', renderMode: 'richText', formatter: tooltip },
    xAxis: { type: 'value', name: '目的変数に対する係数 β', nameLocation: 'middle', nameGap: 28 },
    yAxis: { type: 'category', inverse: true, data: attributes.map(a => a.label), axisLabel: { width: 130, overflow: 'truncate' } },
    series: (['penalty', 'reward'] as const).map(key => ({
      itemStyle: { color: key === 'penalty' ? '#ff4d4f' : '#52c41a' },
      type: 'bar', name: key === 'penalty' ? '低評価側係数 β_low' : '高評価側係数 β_high', barMaxWidth: 18,
      data: attributes.map(a => ({ name: a.name, value: a[key].coef, description: description(a),
        itemStyle: { color: key === 'penalty' ? '#ff4d4f' : '#52c41a',
          borderColor: '#2a78d6', borderWidth: (a.name === selected || a.dissatisfied_row_ids.some(id => selectedRowIds.includes(id))) ? 2 : 0 },
      })),
      markLine: { silent: true, symbol: 'none', data: [{ xAxis: 0 }], label: { show: false }, lineStyle: { color: '#777' } },
    })),
  }
}
