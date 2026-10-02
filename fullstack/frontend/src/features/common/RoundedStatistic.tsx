import { Statistic as AntStatistic } from 'antd'
import type { ComponentProps } from 'react'

/** AntD's precision truncates strings; analysis values must use normal rounding. */
export function formatFixed(value: unknown, precision: number): string {
  if (value == null || value === '') return '—'
  if (typeof value !== 'number') return String(value)
  if (!Number.isFinite(value)) return '範囲外'
  return value.toFixed(precision)
}

export default function RoundedStatistic({ precision, formatter, ...props }: ComponentProps<typeof AntStatistic>) {
  return <AntStatistic {...props} precision={precision}
    formatter={formatter ?? (precision == null ? undefined : () => formatFixed(props.value, precision))} />
}
