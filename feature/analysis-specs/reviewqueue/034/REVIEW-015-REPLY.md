# REVIEW-015 対応報告

日付: 2026-09-14。対象ソース: `fullstack/frontend/src/features/models/ConjointPage.tsx`
SHA256: `25E83D11E648F999F03BACE709A5EA481F23FBC3AE847EA46c14bcf62d427d1d`(前回と同一)。
型検査成功。配信 `http://127.0.0.1:8420`。

## B015-01 同期routeの非ブロッキング化(B07/B08) — 対応完了

B07は `test_cj_b07d.py`(async)に作り替えた(詳細はREVIEW-014-REPLY)。
B08前半(dataset切替)は同期版 `test_cj_b08c.py` のまま残すが、後述の通り
後半とは分離し、前半の成功ログは前半の証拠としてのみ使う。
非ブロッキング・pending管理・タイムアウト失敗・時刻順序assertはB07新試験と
B08失敗シナリオ新試験(`test_cj_b08d.py`、async)で満たす。
Event.setだけで既解放要求を解放扱いにしない(pending存在assert後に解放する)。

## B015-02 必須条件の維持 — 対応完了

- 再分析中の診断ボタン無効: B07新試験で `無効=True` を確認(削らず検証した)。
- 診断失効: tbody不在の直接検査(常設ボタン条件を廃止)。
- 保存元不変: 実値で検査(結果A `予測:14de1537` → 結果B `予測:4d302196`)。

## B015-03 行取得中の再分析失敗 — 対応完了

旧 `test_b08_rows_held_rerun_fail`(dataset切替のみ)を廃止し、
新試験 `fullstack/.temp/test_cj_b08d.py`(async)で以下を実施した。

操作手順:

1. b01_dataでchoice実行(結果A)→行表に全30件表示(行取得完了の裏付け)。
2. 行取得の保留を武装し、成功fitで gut 行取得を保留させる(pending=rows)。
3. 行取得保留中に同一datasetでGUIから再分析を開始し、対象fitへ明示的な失敗応答
   (`route.fulfill` 422 `CONJOINT_INVALID_RESPONSE`「試験注入の失敗応答です。」)を返す。
4. エラー表示(失敗しました)を確認。画像目視済み(旧結果Cardは残るが、
   「行の取得が完了していないため選択できません」表示あり)。
5. 旧行取得の保留を解放。行取得中表示が残らないこと(待機解除)を確認。
6. 武装解除後に再実行し成功・行表全30件に復旧(再実行可能性)。
7. 時刻付き順序assert(`RESULT-A→ROWS-HELD→FAIL-FIT→RERUN-FAILED→OLD-ROWS-RELEASED`)。

実際の結果: すべて成功。pytest終了コード0。

証拠: `fullstack/.temp/b08d_log.txt`、`b08d_fail.png`(目視済み。失敗Alert表示あり)、
`b08d_recovered.png`。

## 継続条件への対応状況

- 選択集合・ブラシ・双方向連携: B06新試験で点クリック・共通色・PCP往復・選択情報を検証。
  ブラシは試験基盤の壁で未発火として記録(成功と記載しない)。
- 診断実値: B09新試験でchoice(行数30・stage/taskヘッダ)・ratings(行数1・診断ヘッダ)をtbodyに絞って検証。
  固定効果・rankingは未確認として残す。
- 保存実列: B10新試験で通知DOM+応答200+実列+実値+stale無効化を検証。
- 予測のページ送り: B05新試験で予測表全60件・2ページ目51件目以降を検証。
- 版説明の訂正: REVIEW-013-REPLYのB013-05に記載。

試験ファイル: `test_cj_b07d.py`、`test_cj_b08d.py`(async・非ブロッキング)。
旧同期試験(`test_cj_b07c.py`、`test_cj_b08c.py`後半)は本報告の証拠に使わない。
