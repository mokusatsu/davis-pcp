import RowScatter from '../charts/RowScatter'

export interface RelationshipPoints { rowIds: string[]; x: number[]; y: number[] }

export default function RelationshipCanvas({ data, labels, colorOf }: {
  data: RelationshipPoints; labels: [string, string]; colorOf: (id: string) => string
}) {
  return <RowScatter points={data.rowIds.map((rowId, i) => ({ rowId, x: data.x[i], y: data.y[i] }))}
    xName={labels[0]} yName={labels[1]} colorOf={colorOf} ariaLabel="焦点ペア散布図" clickOperation="menu" testId="relationship-canvas" />
}
