import { api } from '../../api/client'

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function escapeFormula(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value
}

export async function exportCaTable(
  resultId: string,
  table: 'eigenvalues' | 'categories' | 'manifest' | 'table',
  format: 'json' | 'csv',
): Promise<void> {
  if (table === 'manifest') {
    const res = await api.post<{ mime: string; fileName: string; payload: string }>(
      `/analysis-results/${resultId}/export`,
      { format, table },
    )
    downloadBlob(new Blob([res.payload], { type: 'application/json;charset=utf-8' }), res.fileName)
    return
  }
  if (format === 'json') {
    let offset = 0
    const columns: string[] = []
    const rows: unknown[][] = []
    let fileName = `${resultId}-${table}.json`
    for (;;) {
      const res = await api.post<{ fileName: string; payload: string; nextOffset: number | null }>(
        `/analysis-results/${resultId}/export`,
        { format, table, offset, limit: 5000 },
      )
      fileName = res.fileName
      const body = JSON.parse(res.payload) as { columns: string[]; rows: unknown[][] }
      if (offset === 0) columns.push(...body.columns)
      rows.push(...body.rows)
      if (res.nextOffset === null || res.nextOffset === undefined) break
      offset = res.nextOffset
    }
    downloadBlob(
      new Blob([JSON.stringify({ columns, rows }, null, 2)], { type: 'application/json;charset=utf-8' }),
      fileName,
    )
    return
  }
  const parts: string[] = []
  let fileName = `${resultId}-${table}.csv`
  let offset = 0
  for (;;) {
    const res = await api.post<{ fileName: string; payload: string; nextOffset: number | null }>(
      `/analysis-results/${resultId}/export`,
      { format, table, offset, limit: 5000 },
    )
    fileName = res.fileName
    const lines = res.payload.split('\n')
    if (offset === 0) {
      parts.push(res.payload)
    } else {
      const headerEnd = lines.findIndex((l) => l.length > 0 && !l.startsWith('#'))
      parts.push(lines.slice(headerEnd + 1).join('\n'))
    }
    if (res.nextOffset === null || res.nextOffset === undefined) break
    offset = res.nextOffset
  }
  downloadBlob(new Blob([parts.join('')], { type: 'text/csv;charset=utf-8' }), fileName)
}

export function categoriesToCsv(
  rows: { categoryId: string; label: string; side: string; mass: number; coord: number[] }[],
): string {
  const header = ['categoryId', 'label', 'side', 'mass', 'coord1', 'coord2']
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push([
      r.categoryId,
      escapeFormula(r.label),
      r.side,
      String(r.mass),
      String(r.coord[0] ?? ''),
      String(r.coord[1] ?? ''),
    ].join(','))
  }
  return lines.join('\n')
}

export function downloadSvg(svg: SVGSVGElement, fileName: string): void {
  const text = new XMLSerializer().serializeToString(svg)
  downloadBlob(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }), fileName)
}

export function downloadPng(svg: SVGSVGElement, fileName: string): void {
  const text = new XMLSerializer().serializeToString(svg)
  const img = new Image()
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }))
  img.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width = 960
    canvas.height = 640
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, fileName)
        URL.revokeObjectURL(url)
      })
    } else {
      URL.revokeObjectURL(url)
    }
  }
  img.src = url
}
