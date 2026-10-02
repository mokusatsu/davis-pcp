/** Consume a Python response while owning every proxy acquired from it.
 * Conversion can throw at any step; cleanup must not depend on later gets or
 * conversions succeeding, nor let one failed destroy skip the other proxies. */
export function consumePythonResponse(pyResult: any): {
  statusCode: number
  resHeaders: Record<string, string>
  isBinary: boolean
  rawBytes: Uint8Array
  text: string | null
} {
  const proxies = new Set<any>([pyResult])
  const get = (key: string): any => {
    const value = pyResult.get(key)
    if (typeof value?.destroy === 'function') proxies.add(value)
    return value
  }
  try {
    const statusCode: number = get('status_code')
    const resHeaders: Record<string, string> = get('headers').toJs({ dict_converter: Object.fromEntries })
    const isBinary = Boolean(get('is_binary') ?? get('is_arrow'))
    const rawBytes: Uint8Array = get('content').toJs()
    const text: string | null = get('text')
    return { statusCode, resHeaders, isBinary, rawBytes, text }
  } finally {
    for (const proxy of proxies) {
      try { proxy?.destroy?.() } catch { /* Continue releasing the remaining owned proxies. */ }
    }
  }
}
