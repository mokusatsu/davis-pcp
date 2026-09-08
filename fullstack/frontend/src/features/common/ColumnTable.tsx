import { Table } from 'antd'
import { Children, isValidElement, type ReactNode } from 'react'
import ColumnQuestionTooltip from './ColumnQuestionTooltip'

function hasQuestion(node: ReactNode): boolean {
  return Children.toArray(node).some(child => isValidElement(child) &&
    (child.type === ColumnQuestionTooltip || hasQuestion((child.props as { children?: ReactNode }).children)))
}

/** Decorate identifiable column references without changing table values or sorting. */
const ColumnTable = ((props: any) => {
  const decorate = (columns: any[]): any[] => columns.map(column => {
    if (column.children) return { ...column, children: decorate(column.children) }
    const key = typeof column.dataIndex === 'string' ? column.dataIndex : ''
    const isReference = ['column', 'name', 'variable', 'feature', 'predictor'].includes(key)
    return { ...column,
      render: isReference ? (value: any, record: any, index: number) => {
        const rendered = column.render ? column.render(value, record, index) : value
        if (typeof value !== 'string' || (rendered && typeof rendered === 'object' && 'children' in rendered && 'props' in rendered)) return rendered
        return hasQuestion(rendered) ? rendered : <ColumnQuestionTooltip nameOrId={value}>{rendered}</ColumnQuestionTooltip>
      } : column.render,
    }
  })
  return <Table {...props} columns={props.columns ? decorate(props.columns) : undefined} />
}) as typeof Table
ColumnTable.Summary = Table.Summary
ColumnTable.Column = Table.Column
ColumnTable.ColumnGroup = Table.ColumnGroup
ColumnTable.EXPAND_COLUMN = Table.EXPAND_COLUMN
ColumnTable.SELECTION_COLUMN = Table.SELECTION_COLUMN
export default ColumnTable
