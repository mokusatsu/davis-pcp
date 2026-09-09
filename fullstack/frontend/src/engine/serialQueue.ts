/** Keep one Python operation active, including initialization. */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation)
    tail = result.catch(() => undefined)
    return result
  }
}
