/** Graph IDs include unmodified dataset column names. Compare attribute values
 * literally so quotes, brackets and backslashes can never become CSS syntax. */
export function findGraphElement(attribute: 'data-graph-origin' | 'data-testid', value: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(`[${attribute}]`))
    .find(element => element.getAttribute(attribute) === value) ?? null
}
