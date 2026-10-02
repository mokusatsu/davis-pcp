export function asymmetryVerdict(p: number, alpha: number): string {
  return p < alpha
    ? `探索的閾値 ${alpha * 100}% で非対称性を検出`
    : '非対称性の証拠を検出せず（対称性の確定ではありません）'
}
