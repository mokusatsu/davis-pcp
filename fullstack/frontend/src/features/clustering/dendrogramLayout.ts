/** Linkage leaf IDs are original row indexes, not horizontal plot positions.
 * A depth-first order keeps each subtree in a contiguous interval, preventing
 * unrelated branches from crossing without changing row identity or distance.
 * Use an explicit stack so an unbalanced hierarchy does not overflow recursion.
 */
export function dendrogramLeafOrder(linkageMatrix: readonly (readonly number[])[]): number[] {
  const n = linkageMatrix.length + 1
  const pending = [2 * n - 2]
  const leaves: number[] = []
  while (pending.length) {
    const node = pending.pop()!
    if (node < n) {
      leaves.push(node)
    } else {
      const merge = linkageMatrix[node - n]
      pending.push(merge[1], merge[0])
    }
  }
  return leaves
}
