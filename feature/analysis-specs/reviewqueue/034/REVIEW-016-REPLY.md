# REVIEW-016 対応報告

日付: 2026-09-14。対象ソース: `fullstack/frontend/src/features/models/ConjointPage.tsx`
SHA256: `3f9496391c738cd6b7a34895bf7ddd20255041919c4e8a2288b68f78c36cdd58`。
配信: `fullstack/frontend/dist`(2026-09-14 23:23ビルド、`index-DninIMuP.js`)を
`http://127.0.0.1:8420` で配信。本報告の全試験はこの版で実施した。
対象ソースと配信版を本報告で固定する。

版変更の説明: 前回報告時の`25E83D11...`(20:45)から現行`3F9496...`(23:06更新)へ変化した。
ファイルがgit管理外のため差分内容は特定できないが、機能面では指摘箇所
(片側範囲拒否・opt-out送信除外・診断読込拒否)が現行版に存在することを確認した。
報告版の旧試験証拠を現行版の合格へ自動転用せず、本報告の試験はすべて現行版で再実行した。
なおdist再ビルド時に他機能(CrosstabPage)の型エラーを確認した。conjoint由来ではなく、
当該ファイルを一時退避してビルドし、作業後に復元した(製品コードの改修はしていない)。

## B016-01 保存元不変の厳格化 — 対応完了

旧条件(`save_src_b == save_src_a or "予測" in save_src_b`)を廃止した。
新試験 `test_cj_b07d.py`(async)で以下を実施した。

- 新結果Bの保存元を旧応答解放前に取得(`8c. 解放前の保存元B=fit`)。
  再分析直後の保存元はfitにリセットされるのが正常動作である。
- 旧予測応答を解放し、応答到着後、新予測を実行する前に同じ値であることをassert
  (`10b. 解放後の保存元B=fit`、`10c. 保存元不変OK(解放前後で同一・新予測前)`)。
- 予測IDとresultIdの対応を要求・応答の観測で確認
  (`11b. 旧予測URL数=1 新予測URL数=1`、`11c. 新予測が旧予測と別IDであることを確認OK`。
  旧予測は結果AのresultId宛、新予測は結果BのresultId宛で別ID)。
- 一時的にAへ書き換わる問題を新予測で隠さない(新予測前の比較のため)。

## B016-02 診断ボタン無効のhard assert・再分析完了の厳格化 — 対応完了

- `assert ... or True` を廃止し、`expect(diag_btn).to_be_disabled()` でhard assertする。
  結果: `5b. 再分析保留中の診断読込ボタン無効OK(hard assert)`。
- 再分析完了は「結果: choice」文言に加え、今回fitの応答解放記録(`RELEASED fit-1`)、
  実行ボタンの有効復帰(loading解除)を確認する
  (`6. 再分析完了(結果B・fit応答到着・loading解除を確認)`)。

## B016-03 dataset往復の非ブロッキング化 — 対応完了

B08前半を新試験 `test_cj_b08e.py`(async・非ブロッキング)に作り替えた。
旧同期版は本報告の証拠に使わない。

- 予測保留を武装し、Aで予測を保留(pending=predict)させてからBへ切り替える。
- 実datasetId: 予測要求contextのdatasetIdを観測で記録、
  切替表示(b01_data/b01big_data)と照合する。
- pending・切替・解放の順序を時刻付き単一ログでassert
  (`RESULT-A→PREDICT-A→PREDICT-HELD→SWITCHED-TO-B→RESULT-B→SWITCHED-TO-A→RESULT-C→OLD-RELEASE`)。
- Bでプロフィール60の結果、Aへ戻して旧結果Bなし、再実行の結果Cを確認。
- 旧応答解放後に混入なしを確認。

証拠: `fullstack/.temp/b08e_log.txt`、`b08e_back.png`。

## B016-04 実値検証・対象同定 — 対応完了

旧view HTTP200だけの確認を改めた。新 `test_cj_b10c.py` で以下を実施した。

- view(arrow)をpyarrowで読み、全30件・非null30件・確率範囲0〜1をassert。
- fit行API(保存元resultId)のprobabilityとview実値を突合
  (先頭3行: fit=`[0.7333, 0.2667, 0.7333]` view=`[0.7333, 0.2667, 0.7333]` 一致=True)。
- 対象同定: fit要求contextのdatasetIdを観測で記録し、保存応答のdatasetIdと照合。
  今回は操作datasetId=保存応答datasetId=`ds-e6b9e6bddd40`で一致した。
  旧報告の「保存でdatasetが分岐」説明は訂正する(同一datasetに追記しdataRevisionが上昇する。
  同名末尾IDは別物であり主証拠に使わない)。
- 「実値を検証済み」報告は本試験の突合結果に基づく。

証拠: `fullstack/.temp/b10c_log.txt`、`b10c_save.png`(目視済み)。

## 残りの受入条件への対応

- ブラシ操作: 自動化の壁は変わらず(座標mouseがSVGに未達)。成功の代わりにしない。
  点クリック・共通色・選択情報・PCP往復は検証済み。手動実施は本環境(headlessのみ)で不可のため未確認として残す。
- シミュレーションのモデル分離: 新試験 `test_cj_b04f.py` で検証し成功。
  未実行の線形追加がシミュ表に反映されないこと(線形入力数=0)、保存済みモデル(brand)の列ありを確認。
  証拠: `b04f_log.txt`、`b04f_isolation.png`。
- 固定効果ratings・ranking診断: `test_cj_b09c.py` に固定効果を追加し成功
  (固定効果診断: 行数15・診断ヘッダあり)。rankingは新試験 `test_cj_b09d.py` で成功
  (行数36・stage/taskヘッダあり)。証拠: `b09c_log.txt`、`b09c_fixed.png`、`b09d_log.txt`、`b09d_ranking.png`。
- B08d失敗注入の強化: 対象エラーコード/文言(`CONJOINT_INVALID_RESPONSE`「試験注入の失敗応答です。」)を
  画像で確認済み(`b08d_fail.png`目視)。旧行解放前の待機解除・新結果IDによる復旧を確認済み。

## 試験ファイル一覧(今回)

- `test_cj_b07d.py`(B07厳格化・async)、`test_cj_b08e.py`(B08往復・async)
- `test_cj_b08d.py`(B08失敗・async)、`test_cj_b10c.py`(B10実値・対象同定)
- `test_cj_b04f.py`(B04分離)、`test_cj_b09c.py`(B09固定効果追加)、`test_cj_b09d.py`(B09 ranking)

全試験を現行版(3F94・dist 23:23)で2026-09-14に再実行し成功した。
未確認として残すのはブラシ操作のみである。途中で終了したログはない。
