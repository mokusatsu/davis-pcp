# Feature 034 コンジョイント分析 レビュー004

判定: **既存のコード指摘R001〜R011は解消。受入検証の証拠待ち。**

- 日付: 2026-09-14
- 対象: REVIEW-003-REPLY.md、SHA256 `3C593035AC1FF97E3DA93B0789CAC1F2F9A7F0B57EC03F026C2D56BBE69FD9D3`
- 対象版: HEAD `70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31`からの未コミット変更。
- ConjointPage.tsx SHA256: `3DD843EDDE54D7975C94D2E64C2D36F736FF650C7EF27DDD8B24D8D8C51F7266`

## R007 解消

scope拡張の世代がexpandSequenceへ分離され、fitのrunSequenceを進めなくなった。拡張の成功・失敗がfitのfinallyによるloading解除を妨げる経路は解消した。dataset変更時のリセット、版変更時の同世代要求の後始末、materialize応答のlive照合も維持されている。

## R009 解消

予測開始時にstartSeqを保存し、API応答・行取得応答・失敗のすべてでisLive(startSeq, ...)を確認する。再分析開始とdataset変更でpredSequenceも更新するため、旧モデルの予測応答は無効化される。表示行はresultId:predictionIdで現在のモデルと照合され、別モデルの予測を保存する操作も無効となる。

resultIdのクロージャ内比較だけでは現在値との照合にならないが、開始時runSequenceとpredSequenceの無効化、および描画時のモデル照合があるため、前回指摘した予測A待機→再分析B→A応答の経路は防がれる。

## 検証と残る受入条件

- レビューアー実行: frontend `tsc --noEmit -p fullstack/frontend/tsconfig.json` 成功。
- 前回までのbackend13件成功とR001〜R006・R008・R010・R011の解消判定を維持。今回backend変更は報告されておらず、同じ試験は再実行していない。
- 今回の判定は修正コードの照合と型検査による。遅延応答を使った通常ブラウザ検証は報告でも未実施。fit待機中のscope拡張成功／失敗後の再実行、予測A待機中の再分析B、dataset往復中の旧予測破棄、予測ページ送り、中央選択との往復について検証証拠が必要。
- 通常本番配信物で当該画面が動作する証拠、R mlogit照合など残る受入条件の確認も未完了。対象試験・型検査だけで全体の受入完了とは扱わない。
- Pyodide実ブラウザ操作は受入条件に含めない。レビューアーによる実装修正・ビルド・実ブラウザ操作・全体テストは行っていない。

新しいコード指摘はない。ただし未検証の受入条件が残るため、「レビュー対象範囲に問題はありません」という最終判定は保留する。
