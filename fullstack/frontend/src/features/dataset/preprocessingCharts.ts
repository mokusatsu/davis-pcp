import type { EChartsOption } from 'echarts'

export interface ImputationHistogramBin {
  binLabel: string
  beforeCount: number
  afterCount: number
  imputedAdded: number
}

/** Received bin counts are preserved, with observation and imputation contributions stacked. */
export function imputationHistogramOption(bins: ImputationHistogramBin[]): EChartsOption {
  return {
    grid: { left: 130, right: 65, top: 42, bottom: 40 },
    legend: { top: 0 },
    xAxis: { type: 'value', min: 0, name: '件数', nameLocation: 'middle', nameGap: 26 },
    yAxis: { type: 'category', inverse: true, data: bins.map(bin => bin.binLabel), axisLabel: { width: 115, overflow: 'truncate' } },
    tooltip: { trigger: 'axis', renderMode: 'richText', formatter: (params: any) => {
      const bin = bins[params[0]?.dataIndex]
      return bin ? `${bin.binLabel}\n観測値: ${bin.beforeCount}\n補完追加: ${bin.imputedAdded}\n補完後: ${bin.afterCount}件` : ''
    } },
    series: [
      { type: 'bar', name: '観測値', stack: 'total', itemStyle: { color: '#3b82f6' }, data: bins.map(bin => bin.beforeCount), barMaxWidth: 22 },
      { type: 'bar', name: '補完生成値', stack: 'total', itemStyle: { color: '#10b981' }, data: bins.map(bin => bin.imputedAdded), barMaxWidth: 22,
        label: { show: true, position: 'right', formatter: (params: any) => `${bins[params.dataIndex].afterCount}件` } },
    ],
  }
}
