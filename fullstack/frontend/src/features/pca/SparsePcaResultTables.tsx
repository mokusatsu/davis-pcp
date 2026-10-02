import type { CSSProperties, ReactNode } from 'react'
import { Card } from 'antd'
import type { SparsePcaResponse } from './sparsePcaTypes'

const cellStyle: CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--border-color, #ddd)', textAlign: 'right', verticalAlign: 'top' }
const labelStyle: CSSProperties = { ...cellStyle, textAlign: 'left' }
const numberStyle: CSSProperties = { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

// Significant digits retain tiny nonzero coefficients; formatting never decides sparsity.
function formatNumber(value: number): string {
  if (value === 0) return '0'
  if (Math.abs(value) < 0.0001 || Math.abs(value) >= 1e6) return value.toExponential(6)
  return value.toLocaleString('ja-JP', { maximumSignificantDigits: 7 })
}

function NumberValue({ value }: { value: number }) {
  return <span style={numberStyle} title={String(value)}>{formatNumber(value)}</span>
}

function NullableValue({ value, reason }: { value: number | null; reason?: string | null }) {
  return value === null
    ? <span>定義不可（{reason || '理由未提供'}）</span>
    : <NumberValue value={value} />
}

function FrozenVariable({ variable }: { variable: { columnId: string; name: string; label: string } }) {
  return <span title={`列ID: ${variable.columnId}`}>
    {variable.label || variable.name}{variable.label && variable.label !== variable.name ? ` (${variable.name})` : ''}
  </span>
}

function ResultTable({ title, headers, children }: { title: string; headers: ReactNode[]; children: ReactNode }) {
  return <div style={{ overflowX: 'auto' }} tabIndex={0} role="region" aria-label={`${title}（横スクロール可能）`}>
    <table aria-label={title} style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
      <thead><tr>{headers.map((header, index) => <th key={index} scope="col" style={index === 0 ? labelStyle : cellStyle}>{header}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>
}

function Description({ term, children }: { term: string; children: ReactNode }) {
  return <div style={{ minWidth: 180 }}><dt style={{ fontSize: 12, opacity: 0.8 }}>{term}</dt><dd style={{ margin: '2px 0 8px', overflowWrap: 'anywhere' }}>{children}</dd></div>
}

const convergenceLabels: Record<SparsePcaResponse['summary']['convergence']['status'], string> = {
  tolerance_reached: '許容誤差の停止条件に到達',
  iteration_limit: '反復上限に到達（未収束の探索結果）',
  objective_increase: '学習目的関数が増加（収束成功ではありません）',
}

const scopeLabels: Record<string, string> = { all: '全行', active: 'アクティブ行', selected: '選択行', sampled: 'サンプル行', explicit: '指定行' }
const exclusionLabels: Record<string, string> = {
  missing: '欠損', missing_values: '欠損', nonfinite: '非有限値', invalid: '無効な分析値', invalid_numeric: '無効な数値',
  missing_weight: 'ウェイト欠損', zero_weight: 'ゼロウェイト', structural_task_exclusion: '解析条件による除外',
}

/** Display only the saved result. Never resolve labels or settings through live dataset state. */
export default function SparsePcaResultTables({ result }: { result: SparsePcaResponse }) {
  const { config, meta, summary, details } = result
  const components = details.componentOrder
  const convergence = summary.convergence
  const isStandardized = summary.reconstructionSpace === 'standardized'
  const variables = details.variables

  return <div data-testid="sparse-pca-result-tables" style={{ display: 'grid', gap: 12 }}>
    <Card size="small" title="保存結果の要約" data-testid="sparse-pca-summary">
      <p style={{ marginTop: 0 }}>SparsePCAの成分は必ずしも直交せず、得点同士が相関する場合があります。成分順は推定器の返却順で、分散順ではありません。</p>
      <dl style={{ display: 'flex', flexWrap: 'wrap', gap: '0 24px', margin: 0 }}>
        <Description term="実変換再構成率"><NumberValue value={summary.reconstructionFraction * 100} />%</Description>
        <Description term="再構成を評価する空間">{isStandardized ? '標準化空間（標本標準偏差・ddof=1）' : '中心化した元分析値空間（標準化なし）'}</Description>
        <Description term="学習成分数 / 有効変数数">{summary.nComponents} / {summary.nVariables}</Description>
        <Description term="再構成係数Bのランク">{summary.basisRank} / {summary.nComponents}</Description>
        <Description term="Bの厳密なゼロ比率（疎性）"><NumberValue value={summary.zeroFraction * 100} />%</Description>
        <Description term="対象scope / 対象行数">{scopeLabels[meta.scope] || meta.scope} / {meta.scopeCount}</Description>
        <Description term="学習行数（complete case）">{meta.fitCount}</Description>
        <Description term="除外行数">{meta.excludedCount}</Description>
        <Description term="利用した補完値">{meta.imputedRowCount} 行 / {meta.imputedCellCount} セル</Description>
        <Description term="ウェイト">非加重</Description>
      </dl>
      <p style={{ fontSize: 12 }}>再構成率 = 1 − ‖Zc − TB‖² / ‖Zc‖²。同じ学習行に実際のridge変換を適用した記述的指標です。</p>
      <p style={{ fontSize: 12 }}>除外内訳: {Object.entries(meta.exclusionCounts).map(([reason, count]) => `${exclusionLabels[reason] || reason}: ${count}`).join('、') || 'なし'}</p>
      <p style={{ fontSize: 12 }}>学習行内の定数列除外: {details.excludedConstantColumns.length
        ? details.excludedConstantColumns.map((variable, index) => <span key={variable.columnId}>{index > 0 ? '、' : ''}<FrozenVariable variable={variable} /></span>)
        : 'なし'}</p>
      <ResultTable title="成分別の疎性と得点分散" headers={['成分', 'Bの厳密な非ゼロ数', '得点分散']}>
        {components.map((component, index) => <tr key={component}>
          <th scope="row" style={labelStyle}>{component}</th>
          <td style={cellStyle}>{summary.nonzeroPerComponent[index]} / {summary.nVariables}</td>
          <td style={cellStyle}><NullableValue value={details.scoreVariances[index]} reason={details.scoreVarianceReasons[index]} /></td>
        </tr>)}
      </ResultTable>
      <p style={{ fontSize: 12 }}>非ゼロ数と疎性はBの厳密な0判定です。Wや相関、表示上の丸めからは算出しません。</p>
      {meta.warnings.length > 0 && <ul aria-label="保存結果の警告">{meta.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}（{warning.code}）</li>)}</ul>}
    </Card>

    <Card size="small" title="学習設定・収束診断（保存時）" data-testid="sparse-pca-diagnostics">
      <p role={convergence.status === 'tolerance_reached' ? 'status' : 'alert'}>{convergenceLabels[convergence.status]}</p>
      <dl style={{ display: 'flex', flexWrap: 'wrap', gap: '0 24px', margin: 0 }}>
        <Description term="前処理">{config.preprocessing === 'correlation' ? '標準化（correlation）' : '中心化のみ（covariance）'}</Description>
        <Description term="alpha（Bの疎性ペナルティ）"><NumberValue value={config.alpha} /></Description>
        <Description term="ridgeAlpha（得点計算の安定化）"><NumberValue value={config.ridgeAlpha} /></Description>
        <Description term="反復数 / 最大反復数">{convergence.nIterations} / {config.maxIterations}</Description>
        <Description term="許容誤差"><NumberValue value={config.tolerance} /></Description>
        <Description term="seed / solver">{config.seed} / {config.solver}</Description>
        <Description term="学習目的関数（sklearn）"><NumberValue value={convergence.finalObjective} /></Description>
        <Description term="最終目的関数改善量"><NullableValue value={convergence.finalImprovement} reason="比較する前の反復なし" /></Description>
        <Description term="ランク判定の許容誤差"><NumberValue value={details.rankTolerance} /></Description>
      </dl>
      <p style={{ fontSize: 12 }}>alphaは標本数・単位・前処理に依存します。ridgeAlphaは学習後の得点計算に使う別のパラメータです。</p>
      {config.alpha === 0 && <p data-testid="sparse-pca-alpha-zero">alpha = 0 でも通常PCAへの切替ではありません。ridgeAlphaが正なら得点は縮小され、成分別の一致も一般には保証されません。</p>}
      <p style={{ fontSize: 12 }}>学習目的関数はsklearn内部の辞書学習の値です。返却済みBと得点Tから再計算した値や実変換再構成率とは異なります。停止条件の到達は大域最適解を保証しません。</p>
      <details><summary>学習目的関数の履歴（{convergence.objectiveHistory.length} 件）</summary>
        <ol style={{ maxHeight: 160, overflowY: 'auto' }}>{convergence.objectiveHistory.map((value, index) => <li key={index}><NumberValue value={value} /></li>)}</ol>
      </details>
      <details style={{ marginTop: 8 }}><summary>凍結された結果・前処理・実行環境の詳細</summary>
        <dl style={{ display: 'flex', flexWrap: 'wrap', gap: '0 24px', marginBottom: 0 }}>
          <Description term="結果ID">{result.resultId}</Description>
          <Description term="データセットID">{meta.datasetId}</Description>
          <Description term="data / schema / mask revision">{meta.dataRevision} / {meta.schemaRevision} / {meta.maskRevision ?? 'なし'}</Description>
          <Description term="結果状態">{meta.resultState}</Description>
          <Description term="scope hash">{meta.scopeHash}</Description>
          <Description term="model fingerprint">{meta.modelFingerprint}</Description>
          <Description term="snapshot fingerprint">{meta.snapshotFingerprint ?? 'なし'}</Description>
          <Description term="アルゴリズム版">{meta.algorithmVersion}</Description>
          {Object.entries(meta.numericalRuntime).map(([key, value]) => <Description key={key} term={`runtime: ${key}`}>{value === null || value === undefined ? '未記録' : typeof value === 'object' ? JSON.stringify(value) : String(value)}</Description>)}
        </dl>
        <p style={{ fontSize: 12 }}>以下は学習時に保存した列名・ラベル・変換規則です。現在のコードブック編集には追随しません。欠損は同一のcomplete-case集合で除外し、補完は保存時のcurrent値を使用しています。</p>
        <ResultTable title="保存された変数・前処理" headers={['変数', '尺度 / 得点化 / 逆転', '欠損コード / 順序', '中心（分析値）', '標本標準偏差（分析値）', '前処理の因子表現', '推定器の追加中心化']}>
          {variables.map((variable, index) => {
            const preprocessing = details.preprocessing.columns.find(column => column.columnId === variable.columnId)
            const codeLabel = (code: string) => variable.valueLabels[code] ? `${code} (${variable.valueLabels[code]})` : code
            return <tr key={variable.columnId}>
              <th scope="row" style={labelStyle}><FrozenVariable variable={variable} /></th>
              <td style={cellStyle}>{variable.scaleType} / {variable.score === 'ordered_rank' ? '固定順序の順位得点（承認済み）' : '数値'} / {variable.isReversed ? '逆転あり' : '逆転なし'}</td>
              <td style={cellStyle}>{variable.missingCodes.map(codeLabel).join(', ') || 'なし'} / {variable.categoryOrder.map(codeLabel).join(', ') || 'なし'}</td>
              <td style={cellStyle}>{preprocessing ? <NullableValue value={preprocessing.rawMean} reason={preprocessing.rawMeanReason} /> : '未記録'}</td>
              <td style={cellStyle}>{preprocessing ? <NullableValue value={preprocessing.rawSampleSd} reason={preprocessing.rawSampleSdReason} /> : '未記録'}</td>
              <td style={cellStyle}>{preprocessing ? <><span>inputAnchor: <NumberValue value={preprocessing.inputAnchor} /></span><br /><span>inputMagnitude: <NumberValue value={preprocessing.inputMagnitude} /></span><br /><span>normalizedMeanOffset: <NumberValue value={preprocessing.normalizedMeanOffset} /></span><br /><span>normalizedMean: <NumberValue value={preprocessing.normalizedMean} /></span><br /><span>normalizedSampleSd: <NumberValue value={preprocessing.normalizedSampleSd} /></span></> : '未記録'}</td>
              <td style={cellStyle}><NumberValue value={details.preprocessing.estimatorMean[index]} /></td>
            </tr>
          })}
        </ResultTable>
      </details>
    </Card>

    <Card size="small" title="疎な再構成係数 B" data-testid="sparse-pca-b-table">
      <p style={{ marginTop: 0, fontSize: 12 }}>再構成は T × B。表は変数を行、成分を列に表示しています。B = 0 でも、Wや変数–得点相関が0になるとは限りません。</p>
      <ResultTable title="疎な再構成係数 B" headers={['変数（保存ラベル）', ...components]}>
        {variables.map((variable, variableIndex) => <tr key={variable.columnId}>
          <th scope="row" style={labelStyle}><FrozenVariable variable={variable} /></th>
          {components.map((component, componentIndex) => {
            const value = details.components[componentIndex][variableIndex]
            return <td key={component} style={cellStyle} data-exact-zero={value === 0}><NumberValue value={value} />{value === 0 && <small>（exactZero: 厳密な0）</small>}</td>
          })}
        </tr>)}
      </ResultTable>
    </Card>

    <Card size="small" title="得点計算係数 W" data-testid="sparse-pca-w-table">
      <p style={{ marginTop: 0, fontSize: 12 }}>得点は T = Zc × W。Zcは保存した前処理と推定器の追加中心化を適用した分析値です。WとBは別の係数です。</p>
      <ResultTable title="得点計算係数 W" headers={['変数（保存ラベル）', ...components]}>
        {variables.map((variable, variableIndex) => <tr key={variable.columnId}>
          <th scope="row" style={labelStyle}><FrozenVariable variable={variable} /></th>
          {components.map((component, componentIndex) => <td key={component} style={cellStyle}><NumberValue value={details.scoreCoefficients[variableIndex][componentIndex]} /></td>)}
        </tr>)}
      </ResultTable>
    </Card>

    <Card size="small" title="変数–得点の直接相関" data-testid="sparse-pca-variable-correlation-table">
      <p style={{ marginTop: 0, fontSize: 12 }}>同じ学習行の分析値と得点の直接Pearson相関です。分析値にはコードブックの逆転・順位得点化を反映します。BやWではありません。</p>
      <ResultTable title="変数–得点の直接相関" headers={['変数（保存ラベル）', ...components]}>
        {variables.map((variable, variableIndex) => <tr key={variable.columnId}>
          <th scope="row" style={labelStyle}><FrozenVariable variable={variable} /></th>
          {components.map((component, componentIndex) => <td key={component} style={cellStyle}><NullableValue value={details.variableScoreCorrelations[variableIndex][componentIndex]} reason={details.variableScoreCorrelationReasons[variableIndex][componentIndex]} /></td>)}
        </tr>)}
      </ResultTable>
    </Card>

    <Card size="small" title="得点の成分間相関" data-testid="sparse-pca-score-correlation-table">
      <p style={{ marginTop: 0, fontSize: 12 }}>同じ学習行の得点同士のPearson相関です。零・定数得点で定義できない相関は、対角も含め0や1で補いません。</p>
      <ResultTable title="得点の成分間相関" headers={['成分', ...components]}>
        {components.map((component, rowIndex) => <tr key={component}>
          <th scope="row" style={labelStyle}>{component}</th>
          {components.map((column, columnIndex) => <td key={column} style={cellStyle}><NullableValue value={details.scoreCorrelations[rowIndex][columnIndex]} reason={details.scoreCorrelationReasons[rowIndex][columnIndex]} /></td>)}
        </tr>)}
      </ResultTable>
    </Card>
  </div>
}
