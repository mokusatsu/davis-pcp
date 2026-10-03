import React, { useEffect, useRef, useState } from 'react'
import { Modal, Tabs, Radio, InputNumber, Button, Space, Typography, Alert, message } from 'antd'
import { useDispatch, useSelector } from 'react-redux'
import type { RootState, AppDispatch } from '../../app/store'
import { samplingApplied, samplingCleared, rangeSelectionApplied } from '../../app/store'
import { api } from '../../api/client'

interface ObservationModalProps {
  open: boolean
  defaultTab?: 'sampling' | 'range'
  onClose: () => void
}

export const ObservationModal: React.FC<ObservationModalProps> = ({ open, defaultTab = 'sampling', onClose }) => {
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const obs = useSelector((s: RootState) => s.globalObservations)
  const schemaRevision = useSelector((s: RootState) => s.codebook.schemaRevision)
  const contextKey = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, selection.activeRowIds, open])
  const contextRef = useRef(contextKey)
  contextRef.current = contextKey
  const requestVersion = useRef(0)

  // Sampling form state
  const [method, setMethod] = useState<'without_replacement' | 'with_replacement'>('without_replacement')
  const [mode, setMode] = useState<'count' | 'ratio'>('count')
  const [size, setSize] = useState<number>(Math.min(50, selection.activeRowIds.length || 50))
  const [ratio, setRatio] = useState<number>(30)
  const [seed, setSeed] = useState<number | undefined>(42)
  const [targetScope, setTargetScope] = useState<'active' | 'all'>('active')
  const [samplingLoading, setSamplingLoading] = useState(false)
  const [samplingError, setSamplingError] = useState<string | null>(null)
  const [serverSeedError, setServerSeedError] = useState<string | null>(null)
  const seedHint = 'Seedは0以上9007199254740991以下の整数で入力してください（例: 42）。空欄なら新しいシードを生成します。'
  const seedInvalid = seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0)
  const seedError = seedInvalid ? seedHint : serverSeedError

  // Range form state (1-indexed inclusive)
  const [fromIndex, setFromIndex] = useState<number>(1)
  const [toIndex, setToIndex] = useState<number>(Math.min(100, selection.allRowIds.length || 100))
  const [rangeSource, setRangeSource] = useState<'active' | 'all'>('active')
  const [rangeTarget, setRangeTarget] = useState<'active' | 'selected'>('active')
  const [rangeLoading, setRangeLoading] = useState(false)

  useEffect(() => { requestVersion.current++; setSamplingLoading(false); setRangeLoading(false); setSamplingError(null); setServerSeedError(null) }, [contextKey])
  useEffect(() => {
    if (!open || !obs.sampling.enabled) return
    setMethod(obs.sampling.method)
    setMode(obs.sampling.mode)
    setSize(obs.sampling.size)
    setRatio(obs.sampling.ratio * 100)
    setSeed(obs.sampling.seed)
    setTargetScope(obs.sampling.sourceScope ?? 'active')
    // Refresh the draft only on opening; a pending request must not rewrite its own inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])


  const candidatePool = targetScope === 'active' ? selection.activeRowIds : selection.allRowIds
  const totalCandidates = candidatePool.length

  const previewCount = mode === 'count' ? Math.min(size, totalCandidates) : Math.max(1, Math.round(totalCandidates * (ratio / 100)))

  const handleApplySampling = async () => {
    if (samplingLoading || seedInvalid) return
    if (!selection.datasetId) {
      message.error('データセットが読み込まれていません。')
      return
    }
    const version = ++requestVersion.current, startedContext = contextRef.current
    const current = () => version === requestVersion.current && startedContext === contextRef.current
    setSamplingLoading(true)
    setSamplingError(null)
    setServerSeedError(null)
    try {
      const payload: Record<string, unknown> = {
        method,
        seed: seed ?? null,
        expectedDataRevision: selection.dataRevision,
        expectedSchemaRevision: schemaRevision,
        activeRowIds: targetScope === 'active' ? selection.activeRowIds : undefined,
      }
      if (mode === 'count') {
        payload.size = size
      } else {
        payload.ratio = ratio / 100
      }

      const res = await api.post<{
        sampledRowIds: string[]
        sampledRowWeights: Record<string, number>
        sampleSize: number
        seed: number
        datasetId: string
        dataRevision: number
        schemaRevision: number
        sourceScopeHash: string
        sourceOrderHash: string
        sourceRowCount: number
        sampleId?: string
      }>(`/datasets/${selection.datasetId}/observations/sample`, payload)

      if (!current()) return
      dispatch(
        samplingApplied({
          enabled: true,
          method,
          mode,
          size: res.sampleSize,
          ratio: ratio / 100,
          seed: res.seed,
          sourceScope: targetScope,
          sourceScopeHash: res.sourceScopeHash,
          sourceOrderHash: res.sourceOrderHash,
          sourceRowCount: res.sourceRowCount,
          datasetId: res.datasetId,
          dataRevision: res.dataRevision,
          schemaRevision: res.schemaRevision,
          sampleId: res.sampleId,
          sampledRowIds: res.sampledRowIds,
          sampledRowWeights: res.sampledRowWeights,
        })
      )
      message.success(`無作為サンプリング完了: ${res.sampleSize}行を抽出しました。`)
      onClose()
    } catch (err) {
      if (!current()) return
      const error = err as { message?: string; details?: { fieldErrors?: Record<string, string> } }
      if (error.details?.fieldErrors?.seed) setServerSeedError(seedHint)
      setSamplingError(error.message || 'サンプリングに失敗しました。入力内容を確認して再試行してください。')
    } finally {
      if (current()) setSamplingLoading(false)
    }
  }

  const handleApplyRange = async () => {
    if (!selection.datasetId) {
      message.error('データセットが読み込まれていません。')
      return
    }
    if (fromIndex > toIndex) {
      message.warning('開始行番号は終了行番号以下である必要があります。')
      return
    }
    const version = ++requestVersion.current, startedContext = contextRef.current
    const current = () => version === requestVersion.current && startedContext === contextRef.current
    setRangeLoading(true)
    try {
      // Convert 1-indexed inclusive [from, to] to 0-indexed [from-1, to)
      const res = await api.post<{ rowIds: string[]; count: number }>(
        `/datasets/${selection.datasetId}/observations/range`,
        {
          fromIndex: Math.max(0, fromIndex - 1),
          toIndex: toIndex,
          activeRowIds: rangeSource === 'active' ? selection.activeRowIds : undefined,
          expectedDataRevision: selection.dataRevision,
          expectedSchemaRevision: schemaRevision,
        }
      )

      if (!current()) return
      dispatch(
        rangeSelectionApplied({
          from: fromIndex,
          to: toIndex,
          rowIds: res.rowIds,
          asSelected: rangeTarget === 'selected',
        })
      )
      message.success(
        `行範囲指定完了: 行${fromIndex}〜${toIndex}（${rangeTarget === 'selected' ? res.rowIds.filter(id => selection.activeRowIds.includes(id)).length : res.count}行）を${
          rangeTarget === 'selected' ? '選択行' : '有効行'
        }に設定しました。`
      )
      onClose()
    } catch (err) {
      if (!current()) return
      const error = err as { message: string }
      message.error(error.message || '行範囲指定に失敗しました。')
    } finally {
      if (current()) setRangeLoading(false)
    }
  }

  const handleClearSampling = () => {
    dispatch(samplingCleared())
    message.info('サンプリングを解除しました。')
  }

  return (
    <Modal
      title="観測行選択・サンプリングマネージャ (Observation Manager)"
      open={open}
      onCancel={onClose}
      footer={null}
      width={600}
      data-testid="observation-modal"
    >
      <Tabs
        key={defaultTab}
        defaultActiveKey={defaultTab}
        items={[
          {
            key: 'sampling',
            label: '無作為サンプリング (Sampling)',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <Typography.Text strong>抽出方式:</Typography.Text>
                  <div style={{ marginTop: 4 }}>
                    <Radio.Group
                      value={method}
                      onChange={(e) => setMethod(e.target.value)}
                      data-testid="sampling-method-radio"
                    >
                      <Radio value="without_replacement">非復元抽出 (Without Replacement)</Radio>
                      <Radio value="with_replacement" disabled>復元抽出 / ブートストラップ（未対応）</Radio>
                    </Radio.Group>
                  </div>
                </div>

                <div>
                  <Typography.Text strong>抽出サイズ指定:</Typography.Text>
                  <div style={{ marginTop: 4 }}>
                    <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
                      <Space direction="vertical">
                        <Radio value="count">
                          件数指定:{' '}
                          <InputNumber
                            min={1}
                            max={method === 'without_replacement' ? totalCandidates : undefined}
                            value={size}
                            onChange={(v) => setSize(v ?? 1)}
                            disabled={mode !== 'count'}
                            data-testid="sampling-size-input"
                          />{' '}
                          行 / 全 {totalCandidates} 行
                        </Radio>
                        <Radio value="ratio">
                          比率指定:{' '}
                          <InputNumber
                            min={1}
                            max={100}
                            value={ratio}
                            onChange={(v) => setRatio(v ?? 1)}
                            disabled={mode !== 'ratio'}
                            data-testid="sampling-ratio-input"
                          />{' '}
                          %
                        </Radio>
                      </Space>
                    </Radio.Group>
                  </div>
                </div>

                <div>
                  <Typography.Text strong>乱数シード (Seed):</Typography.Text>
                  <div style={{ marginTop: 4 }}>
                    <InputNumber
                      placeholder="完全ランダム"
                      aria-label="乱数シード (Seed)"
                      aria-describedby="sampling-seed-help"
                      aria-invalid={Boolean(seedError)}
                      status={seedError ? 'error' : undefined}
                      step={1}
                      value={seed}
                      onChange={(v) => { setSeed(v ?? undefined); setServerSeedError(null); setSamplingError(null) }}
                      data-testid="sampling-seed-input"
                    />{' '}
                    <Typography.Text type="secondary">（空欄は新しいシードを生成。抽出元と実効シードを保存します）</Typography.Text>
                  </div>
                  <Typography.Text id="sampling-seed-help" type={seedError ? 'danger' : 'secondary'} role={seedError ? 'alert' : undefined}>
                    {seedError ?? seedHint}
                  </Typography.Text>
                </div>

                <div>
                  <Typography.Text strong>抽出元の母集団:</Typography.Text>
                  <div style={{ marginTop: 4 }}>
                    <Radio.Group value={targetScope} onChange={(e) => setTargetScope(e.target.value)}>
                      <Radio value="active">現在の有効行 (Active: {selection.activeRowIds.length}行)</Radio>
                      <Radio value="all">全行データ (All: {selection.allRowIds.length}行)</Radio>
                    </Radio.Group>
                  </div>
                </div>

                <Alert
                  type="info"
                  message={`プレビュー: 抽出予定 ${previewCount} 行 (${
                    totalCandidates > 0 ? ((previewCount / totalCandidates) * 100).toFixed(1) : 0
                  }%)`}
                />

                {samplingError && <Alert type="error" showIcon message="サンプリングに失敗しました"
                  description={samplingError} data-testid="sampling-error" />}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                  {obs?.sampling?.enabled ? (
                    <Button danger onClick={handleClearSampling} data-testid="clear-sampling-btn">
                      サンプリング解除（Activeに戻る）
                    </Button>
                  ) : <div />}
                  <Space direction="horizontal">
                    <Button onClick={onClose}>閉じる</Button>
                    <Button
                      type="primary"
                      loading={samplingLoading}
                      disabled={seedInvalid || totalCandidates === 0}
                      onClick={handleApplySampling}
                      data-testid="apply-sampling-btn"
                    >
                      サンプリング実行 (Apply Sample)
                    </Button>
                  </Space>
                </div>
              </div>
            ),
          },
          {
            key: 'range',
            label: '行番号範囲指定 (Range)',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Typography.Text>
                  行番号の区間を指定して、該当する観測行を一括して有効行または選択行に設定します。
                </Typography.Text>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Typography.Text strong>開始行 (From):</Typography.Text>
                  <InputNumber
                    min={1}
                    max={selection.allRowIds.length}
                    value={fromIndex}
                    onChange={(v) => setFromIndex(v ?? 1)}
                    data-testid="range-from-input"
                  />
                  <Typography.Text strong>〜 終了行 (To):</Typography.Text>
                  <InputNumber
                    min={1}
                    max={selection.allRowIds.length}
                    value={toIndex}
                    onChange={(v) => setToIndex(v ?? 1)}
                    data-testid="range-to-input"
                  />
                  <Typography.Text type="secondary">（1始まり・両端を含む）</Typography.Text>
                </div>

                <div>
                  <Typography.Text strong>範囲の基準:</Typography.Text>
                  <Radio.Group value={rangeSource} onChange={e => setRangeSource(e.target.value)}>
                    <Radio value="active">現在のActive順</Radio><Radio value="all">全データの行順</Radio>
                  </Radio.Group>
                  <Typography.Text strong>適用先:</Typography.Text>
                  <div style={{ marginTop: 4 }}>
                    <Radio.Group value={rangeTarget} onChange={(e) => setRangeTarget(e.target.value)}>
                      <Radio value="active">有効行 (Active Rows) に設定</Radio>
                      <Radio value="selected">選択行に設定（Active内の行だけをハイライト）</Radio>
                    </Radio.Group>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                  <Space direction="horizontal">
                    <Button onClick={onClose}>閉じる</Button>
                    <Button
                      type="primary"
                      loading={rangeLoading}
                      onClick={handleApplyRange}
                      data-testid="apply-range-btn"
                    >
                      範囲選択実行 (Apply Range)
                    </Button>
                  </Space>
                </div>
              </div>
            ),
          },
        ]}
      />
    </Modal>
  )
}

export default ObservationModal
