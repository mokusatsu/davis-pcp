# REVIEW-014 対応報告

日付: 2026-09-14。対象ソース: `fullstack/frontend/src/features/models/ConjointPage.tsx`
SHA256: `25E83D11E648F999F03BACE709A5EA481F23FBC3AE847EA46c14bcf62d427d1d`(前回と同一)。
型検査成功。配信 `http://127.0.0.1:8420`(dist 20:47ビルド)。

## B014-01 非ブロッキング保留への作り替え — 対応完了

同期route+threading.Eventを廃止し、新試験 `fullstack/.temp/test_cj_b07d.py` を
async Playwright + asyncio.Event で実装した。ハンドラは `await asyncio.wait_for(ev.wait())` で止まるが
イベントループは回るため試験本体のGUI操作は進む。Playwright同期オブジェクトの別スレッド操作は不使用。
タイムアウト(`asyncio.TimeoutError`)はFAIL記録+試験失敗扱い(無条件continueしない)。

## B014-02 pending管理・初回除外 — 対応完了

- pending辞書 `{req_id: {url, ev, kind}}` で現在保留中だけを管理し、明示解放時に除去する。
- 初回fit・予測は `armed=False` で保留対象外。検証区間で `arm()` して対象要求だけ保留する。
- `pending_kinds()` で現在の保留をassertし、HELD件数の累積では判定しない。
- ログ例: `HOLD-PREDICT ... → PREDICT-HELD → HOLD-FIT → RERUN-STARTED → RESULT-B-DONE → OLD-RELEASE`。
  初回要求の即時通過は `t=16.0 HOLD-FIT`(armed前)と区別される。

## B014-03 途中ログの扱い — 対応完了

旧b07cの途中版ログではなく、新試験の完了ログ `b07d_log.txt`(B07完了まで到達)を提出する。
pytest終了コード0・失敗箇所なし。途中ログを成功証拠にしない。

## B014-04 診断失効・保存元の直接確認 — 対応完了

- 旧診断の失効: 診断表tbody数==0を直接assert(常設ボタン存在では通さない)。
  ログ: `旧診断Aの失効OK(診断表のtbodyなし)`、`旧診断表の不在を直接確認OK`。
- 保存元: 保存タブの実値を取得。結果A時 `予測:14de1537` → 結果B時 `予測:4d302196`。
  旧応答解放後も新結果の保存元が不変であることをassertした。
- 再分析完了: 「結果: choice」文言に加え、新予測の成功・保存元の更新・loading解除後の操作可能性で確認。
  時刻付き順序assert(`RESULT-A→PREDICT-A→DIAG-A→PREDICT-HELD→RERUN→RESULT-B→OLD-RELEASE`)あり。

## 副産物: 再分析中の診断ボタン無効を確認

正しい保留成立状態で `再分析保留中の診断読込ボタン無効=True` を確認した。
旧同期試験で観測できなかったのは保留タイミングの問題であり、製品のloading不具合と断定しない。

証拠: `fullstack/.temp/b07d_log.txt`、`b07d_rerun.png`(目視済み)。
