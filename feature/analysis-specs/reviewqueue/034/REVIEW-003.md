# Feature 034 コンジョイント分析 レビュー003

判定: **R011の実装不足は解消。R007・R009の非同期状態管理に残件あり。受入未完了。**

- 日付: 2026-09-14
- 対象: REVIEW-002-REPLY.md、SHA256 `E842FEB4FA23966D4644D6E6D854277F04B4A66CC3EEA800DC6D2630F1ABAA42`
- HEAD: `70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31`。未コミット変更を含む。
- 前回までのR001〜R006・R008・R010の解消判定を維持する。

## CJ-R007 [P1] scope拡張で無効化したfitのloadingが残る

`fullstack/frontend/src/features/models/ConjointPage.tsx:188-198, 386-387`。

dataset切替時のloading/errorリセット、版変更で同世代のfinallyがloadingを解除する修正、materialize応答のlive確認は追加された。

残件は実行中のscope拡張。fitがseq=Nでloading=trueの間にも「タスク全体へ拡張」を押せる。handleExpandScopeがrunSequenceをN+1に進めるため、fitのfinallyはisLiveと同世代判定の両方がfalseになり解除しない。拡張処理にもloading解除がない。とくに拡張が失敗すると、再実行用の拡張ボタンも表示されず、通常の実行ボタンが無効のまま残る。

fitの実行状態を所有する世代とscope拡張の世代を分ける、または拡張でfitを無効化する時点で実行状態も終了させる等、整合した状態遷移にすること。fit待機→scope拡張成功／失敗→通常の再実行が可能、という対象試験で確認すること。

## CJ-R009 [P1] 再分析後に旧モデルの予測が再表示される

`fullstack/frontend/src/features/models/ConjointPage.tsx:145-155, 263-290, 336, 528`。

予測同士の世代照合、全ページ取得、予測一覧のページ送り、取得エラー表示は追加された。しかしlive確認に要求開始時のrunSequenceではなく、応答時のrunSequence.currentを渡しているため、世代比較が常に自己一致になる。再分析開始時にもpredSequenceを進めない。

モデルAの予測待機中に再分析してモデルBへ切り替わると、Aの予測が遅れて到着してもdatasetと版が同じなら通過する。予測行表示の照合もpredictionId同士だけで、現在のresultIdとの照合がない。その結果、Bの画面へAの予測が表示され、列保存はBのresultIdとAのpredictionIdを組み合わせて送る。

予測開始時のrunSequenceとresultIdを保存して応答時に照合し、再分析・dataset変更では予測世代を無効化すること。予測行の表示と保存元を現在のモデルへひもづけること。予測A待機→再分析B→A応答解放、およびdataset往復中の遅延予測を確認すること。

## CJ-R011 実装不足は解消、操作証拠待ち

確率／予測評点と残差のプロフィール図、rowIdによる点クリック、中央選択の色分け、tooltipを確認した。行一覧のページ送りと回答者全タスク選択の別操作も維持されている。前回の「連動図がない」は解消とする。

提出報告では通常ブラウザの中央選択往復は未実施。ここで実操作確認済みとは扱わない。

## 検証・受入状況

- レビューアー実行: frontend `tsc --noEmit -p fullstack/frontend/tsconfig.json` 成功。
- 今回の変更は画面と予測取得ヘルパー。前回のbackend13件成功を維持し、同じbackendテストは再実行していない。
- 新規の遅延応答・画面操作試験の証拠は提出されていない。上記2件は現在のコードの要求開始・応答・表示・保存経路を追跡した指摘であり、今回ブラウザで再現したという記録ではない。
- 通常ブラウザ操作、通常本番配信経路、R mlogit照合などの受入確認は引き続き残る。Pyodide実ブラウザ操作は条件に含めない。
- 実装修正・ビルド・全体テストは行っていない。

## 確認版SHA256

- ConjointPage.tsx: `21EC3EE70AF30BB1F2DF39DBDEDA7DE75E3FECB9CEBF765046A82593B82B67FC`
- conjointApi.ts: `CB420E089259A78445172F6D9479383EE70ECE641139A2E3C6DEFFE8BED1314A`

R007・R009と受入確認が残るため、問題なしとは判定しない。
