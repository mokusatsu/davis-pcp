import type { EChartsOption } from 'echarts'
import type { VariableRankItem } from './FeatureRankingPage'

export const RANKING_METHOD_COLORS: Record<string, string> = {
  relieff: '#1890ff', mutualInfo: '#52c41a', randomForest: '#722ed1', fStatistic: '#fa8c16', pcaDispersion: '#13c2c2',
}

export function rankingBarsOption(rankings: VariableRankItem[], highlighted: string | null,
  topKVariables: string[]): EChartsOption {
  const methods = Object.keys(RANKING_METHOD_COLORS).filter(key => rankings.some(row => row.scores[key as keyof typeof row.scores]))
  return {
    grid: { left: 155, right: 36, top: 40, bottom: 54 },
    legend: { top: 0 },
    tooltip: { trigger: 'item', renderMode: 'richText', formatter: (p: any) => p.data?.description ?? '' },
    xAxis: { type: 'value', min: 0, max: 1, name: 'Normalized score', nameLocation: 'middle', nameGap: 30 },
    yAxis: { type: 'category', inverse: true, data: rankings.map(row => row.variable), axisLabel: { width: 140, overflow: 'truncate' } },
    series: methods.map(method => ({
      type: 'bar', name: method, barMaxWidth: 12,
      // Legends inherit the series visual, not per-row item styles.
      itemStyle: { color: RANKING_METHOD_COLORS[method] },
      data: rankings.map(row => {
        const score = row.scores[method as keyof typeof row.scores]
        return { name: row.variable, value: score?.normalizedScore ?? null,
          description: `${row.variable}\n${method}: raw=${score?.rawScore ?? '—'}, normalized=${score?.normalizedScore ?? '—'}\nBorda: ${row.bordaScore} (rank ${row.overallRank})`,
          itemStyle: { color: RANKING_METHOD_COLORS[method], borderColor: '#2a78d6', borderWidth: row.variable === highlighted ? 2 : 0,
            opacity: row.variable === highlighted || topKVariables.includes(row.variable) ? 1 : 0.6 } }
      }),
    })),
  }
}

export function rankingScatterOption(rankings: VariableRankItem[], highlighted: string | null,
  topKVariables: string[], redundancy: (variable: string, fallback: number) => number, topK: number): EChartsOption {
  return {
    grid: { left: 75, right: 45, top: 25, bottom: 62 },
    tooltip: { trigger: 'item', renderMode: 'richText', formatter: (p: any) => p.data?.description ?? '' },
    xAxis: { type: 'value', name: '統合重要度 (Borda Score)', nameLocation: 'middle', nameGap: 35 },
    yAxis: { type: 'value', name: `動的冗長性 (vs Top-${topK})`, nameLocation: 'middle', nameGap: 46, min: 0, max: 1 },
    series: [{ type: 'scatter', data: rankings.map(row => {
      const dynamic = redundancy(row.variable, row.meanRedundancy)
      return { name: row.variable, value: [row.bordaScore, dynamic],
        description: `${row.variable}\nBorda Score: ${row.bordaScore} (rank ${row.overallRank})\nmRMR Redundancy vs Top-${topK}: ${dynamic.toFixed(4)}\nStatic mean redundancy: ${row.meanRedundancy.toFixed(4)}`,
        symbolSize: row.variable === highlighted ? 20 : topKVariables.includes(row.variable) ? 16 : 12,
        itemStyle: { color: row.variable === highlighted ? '#ff4d4f' : topKVariables.includes(row.variable) ? '#2f54eb' : '#8c8c8c', borderColor: '#fff', borderWidth: 1.5 },
        label: { show: true, formatter: () => row.variable, position: 'right', fontSize: 10, color: '#333' } }
    }) }],
  }
}

/** Received importance values stay signed, including negative permutation means. */
export function importanceBarsOption(items: import('./FeatureRankingPage').ImportanceEntry[], kind: 'mdi' | 'permutation'): EChartsOption {
  return {
    grid: { left: 160, right: 105, top: 24, bottom: 45 },
    tooltip: { trigger: 'item', renderMode: 'richText', formatter: (p: any) => p.data?.description ?? '' },
    xAxis: { type: 'value', name: kind === 'mdi' ? 'MDI' : 'Permutation importance', nameLocation: 'middle', nameGap: 28 },
    yAxis: { type: 'category', inverse: true, data: items.map(item => item.featureName), axisLabel: { width: 145, overflow: 'truncate' } },
    series: [{ type: 'bar', barMaxWidth: 20, data: items.map(item => {
      const value = kind === 'mdi' ? item.importance : item.importanceMean
      const label = value == null ? '—' : kind === 'mdi' ? value.toFixed(3) : `${value.toFixed(3)} ± ${(item.importanceStd ?? 0).toFixed(3)}`
      return { name: item.featureName, value: value ?? null, description: `${item.featureName}\n${label}\nRank: ${item.rank}`,
        itemStyle: { color: kind === 'mdi' ? '#722ed1' : '#1890ff' }, label: { show: true, position: value != null && value < 0 ? 'left' : 'right', formatter: label } }
    }), markLine: { silent: true, symbol: 'none', data: [{ xAxis: 0 }] } }],
  }
}
