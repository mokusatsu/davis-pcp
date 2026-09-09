import type { CodebookColumn, MultiResponseGroup } from '../../api/client'

export type VariableEntity = { kind: 'column'; columnId: string } | { kind: 'ma'; groupId: string }
export type VariableCatalogItem = { entity: VariableEntity; key: string; label: string; name: string; scaleType: string; role: string }

export const entityKey = (entity: VariableEntity) => JSON.stringify(entity)

export function variableCatalog(columns: CodebookColumn[], groups: MultiResponseGroup[]): VariableCatalogItem[] {
  const result: VariableCatalogItem[] = []
  const seen = new Set<string>()
  for (const column of columns) {
    const groupId = column.multiResponseGroup
    const entity: VariableEntity = groupId ? { kind: 'ma', groupId } : { kind: 'column', columnId: column.columnId }
    const key = entityKey(entity)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ entity, key, label: groupId ? groups.find(g => g.groupId === groupId)?.label || groupId : column.label || column.name,
      name: groupId || column.name, scaleType: groupId ? 'ma' : column.scaleType, role: column.role })
  }
  return result
}

export function reconcileEntities(entities: VariableEntity[] | null, columns: CodebookColumn[], groups: MultiResponseGroup[]): VariableEntity[] {
  const catalog = variableCatalog(columns, groups)
  if (entities === null) return catalog.map(item => item.entity)
  const available = new Map(catalog.map(item => [item.key, item.entity]))
  const byId = new Map(columns.map(column => [column.columnId, column]))
  const result = new Map<string, VariableEntity>()
  for (const entity of entities) {
    const groupId = entity.kind === 'column' ? byId.get(entity.columnId)?.multiResponseGroup : null
    const next: VariableEntity = groupId ? { kind: 'ma', groupId } : entity
    if (available.has(entityKey(next))) result.set(entityKey(next), next)
  }
  return [...result.values()]
}
