/** Mirrors MCA/FAMD materialization names; the server remains the collision authority. */
export function scoreSaveNameError(name: string, columns: readonly { name: string }[]): string | null {
  if (!/^[A-Za-z_]/.test(name) || /[^A-Za-z0-9_]/.test(name)) {
    return '列名は半角英字または _ で始め、半角英数字と _ のみを使用してください。'
  }
  if (name === '__rowId__') return '__rowId__ はシステム列のため指定できません。'
  if (columns.some(column => column.name === name)) {
    return `列「${name}」は既に存在します。既存列を残すには、別の列名を指定してください。`
  }
  return null
}

export function scoreSaveIdempotencyKey(resultId: string, axis: number, name: string, defaultName: string): string {
  const key = `${resultId}-fit-${axis}`
  // Keep the default request identity; a custom name is a distinct payload intent.
  return name === defaultName ? key : `${key}-${name}`
}
