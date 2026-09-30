# Feature 034 コンジョイント分析 レビュー002

判定: **CJ-R001〜R006・R008・R010は解消。R007・R009・R011は残件あり。受入未完了。**

- 日付: 2026-09-14
- 対象: REVIEW-001-REPLY.md、SHA256 `E978BC640C70E868E35BDB1065653BF442B2D37EEABC0D57BF3DAAC4CF6D99BD`
- 対象版: HEAD `70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31`からの未コミット変更。
- 前回11件すべてについて対応コードと報告を確認した。

## 解消を確認した項目

- R001: 展開済み列を1列ずつ進めるoffset計算へ修正。旧再現はnParams=3、offset=0,1,2となり、encode_rowも成功した。追加の多属性・属性順序試験も成功。
- R002: 予測時に列名・columnIdの両方を解決し、欠損ID行も出力する修正を確認した。
- R003: 全データのタスク構成とscopeを照合する処理を確認。旧部分予測はHTTP 422/CONJOINT_PARTIAL_TASKになった。
- R004: 既知回答者のalphaと新規回答者のmeanInterceptを予測に適用する分岐を確認。学習行再予測一致の隔離検証報告を受領した。今回レビューアーによるその一致試験の再実行はしていない。
- R005: fitOverlapRespondentCountと回答者一覧、既知回答者の未学習タスク集計が追加された。既存fitOverlapCountは行数として残り、回答者数と区別できる。
- R006: 書込ロック内で現在版・学習版・要求版を照合し、scopeを解決する修正を確認した。idempotencyの試験も成功。今回の対象APIテストには実際の同時編集の再現は含まれず、競合時の判定はコード確認に基づく。
- R008: 再分析開始時のrows/sim/pred消去、rows/simのresultId照合、表示をresult.summary.modeに合わせる修正を確認した。
- R010: availability・opt-out・ウェイト・評点固定効果・価格属性・WTP設定、およびモデルJSON・タスク診断CSVの操作が追加された。

## CJ-R007 [P1] 古い応答の破棄後にloadingが解除されない

`fullstack/frontend/src/features/models/ConjointPage.tsx:84-95, 138-141, 181-190, 326-327`。

dataset・data/schema版・runSequenceの照合が追加され、旧fit/選択応答の反映は防がれるようになった。ただしfit実行中にdatasetを切り替えるとsequenceが変わり、旧要求のfinallyはisLive=falseでsetLoading(false)を呼ばない。dataset切替側もloadingを解除しないので、実行ボタンが無効のまま残る。同じ問題は実行中の版更新や「タスク全体へ拡張」によるsequence更新でも起きる。

表示結果の新旧判定と実行状態の後始末を分け、破棄された要求が画面を永久にbusyにしないこと。遅延fit応答中のdataset切替・版更新・scope拡張後に再実行できることを確認すること。

さらに`handleMaterialize:275-289`にはlive照合がない。保存応答待ち中にdatasetを切り替えると、旧dataset向けfetchCodebookThunkをdispatchする。保存後のキャッシュ・コードブック更新とエラー表示も現在のdatasetに照合すること。報告の「全非同期応答に照合」はまだ成立していない。

## CJ-R009 [P2] 予測一覧の全件アクセスと要求同士の整合が不足する

`fullstack/frontend/src/features/models/ConjointPage.tsx:253-268, 427-439`。

predictionId・評価・予測行の表示とpredictionIdをsourceにした保存は追加された。一方、予測行は5000件の1ページしか取得せず、表示は先頭50行で固定され、次ページ操作がない。51行目以降の予測値・失敗理由を確認できない。予測側にもページ取得とページ送りを接続すること。取得失敗をcatch(() => null)で隠さず表示すること。

予測を連続実行した場合も両方が同じrunSequenceを使い、predictionIdと行の取得が別々にstateへ入る。A/Bの応答順が交差するとBのpredictionIdにAの行が表示され、保存される値と表示値が異なる可能性がある。予測ごとの要求世代またはpredictionIdで行を照合し、新しい予測開始時に旧表示を無効化すること。

## CJ-R011 [P2] 行一覧の改善は確認、プロフィール連動図は未実装

`fullstack/frontend/src/features/models/ConjointPage.tsx:397-419`。

学習行一覧のページ送り、中央選択の強調、tooltipは追加され、先頭50行しか操作できない問題は解消した。しかし表示は引き続き行ボタン一覧のみで、仕様§7のプロフィール点の残差／選択確率からの連動図はない。確率・残差の分布から点を選び元rowIdへ連動する図を提供し、行選択と回答者全タスク選択の区別を維持すること。通常ブラウザでの中央選択との往復も未確認。

## 検証と未検証事項

- レビューアー再実行: conjoint kernel11件＋API2件、**13 passed**。APIは隔離workspaceで実施。
- 旧再現 `.temp/review-034-probe.py` で多属性符号化のIndexError解消、部分予測422を確認。
- 今回はコード・対象試験・提出報告の確認。実装修正・ビルド・全体テスト・実ブラウザ操作は行っていない。
- 通常ブラウザ操作、通常本番配信経路、R mlogit照合などは回答でも残作業。修正後の対象検証と受入証拠が必要。Pyodide実ブラウザ操作は判定条件に含めない。

## 確認ソースSHA256

- api/conjoint.py: `AEC81E88E5A3E0A07903C324EF2576492646107FFE2105AE0826DD1B93B58303`
- algorithms/models/conjoint_encoding.py: `0BDB33E90F7795778DFDC63143687E703A928B415E226ADCF6469A6ED09067F7`
- ConjointPage.tsx: `1501619EF90014E6005E12590DFE82CAA998FD62400A5D880B46D819E66054A2`

R007・R009・R011と受入検証が残るため、問題なしとは判定しない。
