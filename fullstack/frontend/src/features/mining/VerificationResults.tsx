import { Alert, Col, Row, Space, Statistic, Tag, Typography } from 'antd'
import type { CSSProperties } from 'react'
import Table from '../common/ColumnTable'
import {
  METHOD_LABEL, REPLICATION_COLOR, REPLICATION_LABEL, hasAdjustedInference,
  isFiniteNumber, isIndependentInference, isPosthocStability, isPValue,
  untestableReason, verificationIntervalLabel,
  type VerificationInfo, type VerificationResultItem,
} from './verification'

export function VerificationSummary({ info, results, prefix, style }: {
  info: VerificationInfo
  results: VerificationResultItem[] | null
  prefix: string
  style?: CSSProperties
}) {
  const stability = isPosthocStability(info)
  const independent = isIndependentInference(info)
  const tested = (results ?? []).filter(item => hasAdjustedInference(info, item))
  const decisions = tested.filter(item => typeof item.test?.significant === 'boolean')
  const details = [
    `手法: ${METHOD_LABEL[info.method] ?? info.method}`,
    `固定候補=${info.pinnedCandidateCount}`,
    `評価可能=${(results ?? []).filter(item => item.testable).length}`,
    `対象外=${info.mExcluded}`,
    `nSelection=${info.nSelection}`, `nEvaluation=${info.nEvaluation}`, `seed=${info.seed}`,
  ]
  if (independent && tested.length > 0) {
    details.push(`検定: ${info.testUsed.join(', ') || '名称なし'}`,
      `補正: ${info.correction}（α=${info.alpha}）`, `family=${info.mHypotheses}`)
    if (decisions.length > 0) details.push(`有意性判定あり=${decisions.length}`, `補正後有意=${decisions.filter(item => item.test?.significant === true).length}`)
  } else if (independent) {
    details.push('推測統計を算出できた候補: 0')
  }
  if (stability) details.push('探索後の分割による参考評価です。独立データによる確証ではありません。')
  if (info.note) details.push(info.note)
  return <Alert type="info" showIcon
    message={stability ? '探索後の安定性確認（参考）' : independent ? '独立データでの評価結果' : '評価結果（参考）'}
    description={details.join('／')} style={style} data-testid={`${prefix}-badge`} />
}

/** Both mining views must apply the same inference gates to the completed result. */
export function VerificationFindings({ info, item, candidateId, prefix, precision = 4 }: {
  info: VerificationInfo | null
  item: VerificationResultItem | null
  candidateId: string
  prefix: string
  precision?: number
}) {
  const stability = isPosthocStability(info)
  const independent = isIndependentInference(info)
  const adjusted = item ? hasAdjustedInference(info, item) : false
  const hasRawP = independent && item?.testable && isPValue(item.test?.pValue)
  const direction = adjusted && item?.replicationStatus ? item.replicationStatus : null
  const folds = info?.folds?.map(fold => {
    const result = fold.effects.find(effect => effect.candidateId === candidateId)
    return { key: fold.fold, fold: fold.fold + 1, nEvaluation: fold.nEvaluation, result }
  }) ?? []

  return <div data-testid={`${prefix}-findings`} style={{ marginTop: 12 }}>
    <Typography.Text strong>
      {stability ? '安定性確認（固定候補・参考）:' : independent ? '独立データでの評価（固定候補）:' : '評価結果（固定候補・参考）:'}
    </Typography.Text>
    {!item ? <Typography.Paragraph type="secondary" data-testid={`${prefix}-not-pinned`}>
      この候補は探索時の固定候補に含まれていないため、評価の対象外です。
    </Typography.Paragraph> : !item.testable ? <Alert type="warning" showIcon style={{ marginTop: 8 }}
      data-testid={`${prefix}-untestable`} message={`評価できません（${item.reason ?? 'UNKNOWN'}）`}
      description={untestableReason(item)} /> : <>
      {independent && !adjusted && <Alert type="info" showIcon style={{ marginTop: 8 }}
        data-testid={`${prefix}-inference-unavailable`} message="推測統計を算出できません"
        description="効果の推定を参考表示します。有意性や再現性は判定できません。" />}
      <Row gutter={[8, 8]} style={{ marginTop: 8 }}>
        {hasRawP && <Col xs={24} sm={12}><Statistic
          title={`p値 (${item.test?.name ?? '名称なし'})`} value={item.test!.pValue!}
          data-testid={`${prefix}-p-value`} /></Col>}
        {adjusted && <Col xs={24} sm={12}><Statistic
          title={`補正後p値 (${info?.correction ?? '補正方法不明'})`} value={item.test!.pAdjusted!}
          data-testid={`${prefix}-p-adjusted`} /></Col>}
        <Col xs={24} sm={12}><Statistic title={verificationIntervalLabel(info)}
          value={item.effect?.ci95?.length === 2 && item.effect.ci95.every(isFiniteNumber)
            ? `[${item.effect.ci95[0].toFixed(precision)}, ${item.effect.ci95[1].toFixed(precision)}]` : '-'}
          valueStyle={{ fontSize: 14 }} data-testid={`${prefix}-ci`} /></Col>
        <Col xs={24} sm={12}><Statistic title="点推定（評価に使った行数）"
          value={isFiniteNumber(item.effect?.estimate) ? `${item.effect.estimate.toFixed(4)}（${item.n.used}行）` : `算出不可（${item.n.used}行）`}
          valueStyle={{ fontSize: 14 }} data-testid={`${prefix}-estimate`} /></Col>
      </Row>
      {adjusted && <Space wrap size={4} style={{ marginTop: 8 }} data-testid={`${prefix}-replication`}>
        {direction && <Tag color={REPLICATION_COLOR[direction]}>{REPLICATION_LABEL[direction]}</Tag>}
        {item.test?.significant === true ? <Tag color="green">補正後も有意</Tag>
          : item.test?.significant === false ? <Tag>補正後は非有意</Tag> : <Tag>有意性判定なし</Tag>}
      </Space>}
      {item.effect?.weighted && <Tag color="blue">加重</Tag>}
      {!!item.effect?.groupStats?.length && <Table size="small" pagination={false} style={{ marginTop: 8 }}
        dataSource={item.effect.groupStats.map((group, index) => ({ ...group, key: index }))}
        data-testid={`${prefix}-group-stats`} columns={[
          { title: '群', dataIndex: 'label', key: 'label' },
          { title: 'n', dataIndex: 'n', key: 'n' },
          { title: '平均 / 比率', key: 'location', render: (_: unknown, group: { mean?: number | null; pct?: number | null }) =>
            isFiniteNumber(group.mean) ? group.mean.toFixed(3) : isFiniteNumber(group.pct) ? group.pct.toFixed(3) : '-' },
          { title: 'SD', dataIndex: 'sd', key: 'sd', render: (value: unknown) => isFiniteNumber(value) ? value.toFixed(3) : '-' },
        ]} />}
    </>}
    {stability && folds.length > 0 && <div style={{ marginTop: 12 }} data-testid={`${prefix}-folds`}>
      <Typography.Text strong>fold別の点推定（参考）</Typography.Text>
      <Typography.Paragraph type="secondary">
        固定候補を各foldで評価しています。見出しの結果は全行での評価です。
      </Typography.Paragraph>
      <Table size="small" pagination={false} scroll={{ x: 'max-content' }} dataSource={folds} columns={[
        { title: 'fold', dataIndex: 'fold', key: 'fold' },
        { title: '評価行数', dataIndex: 'nEvaluation', key: 'nEvaluation' },
        { title: '使用行数', key: 'used', render: (_: unknown, fold: typeof folds[number]) => fold.result?.n?.used ?? '-' },
        { title: '点推定', key: 'estimate', render: (_: unknown, fold: typeof folds[number]) =>
          fold.result?.testable !== false && isFiniteNumber(fold.result?.effect) ? fold.result.effect.toFixed(4) : '算出不可' },
        { title: '状態', key: 'status', render: (_: unknown, fold: typeof folds[number]) =>
          fold.result?.testable !== false && isFiniteNumber(fold.result?.effect) ? '参考評価' : fold.result?.reason ?? '推定値なし' },
      ]} />
    </div>}
  </div>
}
