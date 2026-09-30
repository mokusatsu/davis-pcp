# Feature 034 再レビュー022

判定: **修正必須・承認保留。既定の2条件は進展したが、版更新の無条件実行に別datasetへの副作用がある。**

日付: 2026-09-15。対象: REVIEW-021-REPLY.md、RUN_TAG=131936のログ、test_cj_b08i.py、ConjointPageと共有store/codebook処理。
ConjointPage.tsx SHA256: `89478E8DD07A4BA309CA4739F46D786547A462FC7EA3432C7E16E0D1567789B4`。報告と一致。

## 採用する証拠

- 条件1で旧要求解放後、再読込なしの再分析が更新版2で成功し、新結果による再保存200・正当な新通知・版3への更新まで実行された。B10cによる代替ではなく、遅延後の復旧経路を実施している。
- 条件2は独立fixtureで保存200を保持し、A→B→A後のC4生成、版2/1の一致、旧応答解放後の旧通知なし、staleなし、保存ボタン有効を確認している。以前の409停止は解消した。
- run別ログとbundle名の記録が追加された。これらのケースの成功証拠は維持する。

## B022-01 [P1] Aの保存完了で、表示中BのコードブックをAへ切り替える

対象: `fullstack/frontend/src/features/models/ConjointPage.tsx:713〜715`、`fullstack/frontend/src/features/dataset/codebookSlice.ts:274`付近。

handleSaveは世代に関係なくfetchCodebookThunk(startedDataset)をdispatchする。codebookのpendingはその引数をstate.datasetIdに設定し、別datasetなら列・draft・選択列・hasChanges等を初期化する。fulfilledのrequestId照合だけではこのpendingの副作用を防げない。

Aで保存待機→Bへ切替→Bに留まったままA保存が完了、という経路で、Aのコードブック取得がBの現在編集状態を消し、画面のdatasetとコードブックを不一致にする。今回の試験はいずれもAへ戻してから解放するため、この問題を通らない。

実データ変更の通知は必要だが、非表示datasetの更新を現在のコードブックへロードしてはならない。応答時点の中央の現在datasetを使って、現在表示への更新と非表示datasetのキャッシュ無効化を区別すること。unmountした旧インスタンスのselectionRefだけでは判定できない。

実ブラウザでA保存待機→Bで列・コードブック状態を確認→Aの保存解放を行い、Bの列・未保存編集・選択が維持され、Aへ戻した際には新列と新しい版が取得されることを確認する。

## B022-02 [P2] 通知のfresh判定をコードブック取得後にも行うこと

対象: `ConjointPage.tsx:710〜717`。

freshを計算した後にawait dispatch(fetchCodebookThunk(...))がある。この取得待機中にdataset切替・unmount・再分析が起きても、保存済みのfresh=trueで旧成功通知を出せる。cleanupでカウンタを進めても、既に計算したbooleanには反映されない。

通知を出す直前に現在の世代と生存状態を再検査すること。保存200を受け取った後のコードブック応答だけを保留し、その間にdatasetを切り替えてから解放するブラウザ試験を追加する。旧通知が出ないことと、現在画面の列・結果・待機状態の維持を確認する。

## 検証と版の記録

今回は製品修正を行わず、対応報告・試験ソース・run別ログ・副作用の呼出先を照合した。ブラウザ再実行、build、全体テストは行っていない。Pyodide実ブラウザ操作の免除は維持する。

報告はbundle hashを特定したと記載しているが、本文冒頭はindex-CDndHXJ3.jsという名前のみ。実際のhashも記録すること。既に成功した2条件やブラシ等の一律再実行は不要だが、上記の変更影響は再検証する。

**今回の既定ケース成功は採用するが、新しい共有状態更新の回帰と通知競合が残るため、問題なしとは判定しない。**
