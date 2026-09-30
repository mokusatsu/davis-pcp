# REVIEW-023 対応報告

日付: 2026-09-15。対象ソース: `fullstack/frontend/src/features/models/ConjointPage.tsx`
SHA256: `f7546ca00eb1dcd25352b3aa588f740320d5eff9013cb0b15acd881633a5477b`。
前回報告版(`89478e8d...`)からの差分: B023-01(中央store判定)のみ。B022-02の追加修正は
前回版に含まれており、今回はソース確認のみである。
配信: `fullstack/frontend/dist`(2026-09-15 14:50ビルド、`index-BHvWhWs2.js`、
SHA256: `3dc335648b1a872d85d105f4de6b2dcaeeb4f3e35f47cf27de464b3c19147a8b`)を
`http://127.0.0.1:8420/` で配信。試験時に読み込んだbundle名とSHA256を記録した。
本報告の試験はこの版で実施した。

試験: `fullstack/.temp/test_cj_b08i.py` を実ブラウザで実行し成功。
RUN_TAG=145555。ログ: `fullstack/.temp/b08i_log_145555.txt`(写し=`b08i_log.txt`)。
画像: `fullstack/.temp/b08i_cond1.png`、`b08i_cond2.png`。

## B023-01 中央store判定への修正 — 製品修正を実施

レビューの分析通り、追加修正の `selectionRef.current.datasetId === startedDataset`
はunmount済みインスタンスのrefを使うため、中央の現在datasetを保証しない。
Aの旧インスタンスがunmountするとrefは最後のAを保持し、Bへの切替後も条件が成立して
`fetchCodebookThunk(A)` がdispatchされ、Bの列・draft・選択・hasChangesを初期化する。

修正: 保存完了時にライフサイクル終了後も有効な中央storeの現在datasetで判定する。
`store.getState().selection.datasetId` と `startedDataset` を比較し、
現在表示中のdatasetだけコードブックを再取得する。非表示datasetは
列キャッシュ無効化(再表示時に最新版を取得)に留める。
実データ変更の通知(`datasetValuesUpdated`)はreducer側で現在dataset以外を
無視するため常時dispatchし、正規経路で維持する。
対象箇所: `ConjointPage.tsx` のhandleSave(成功時は常時伝達、コードブック再取得だけ現表示限定)、
通知だけfresh時(変更なし)。

## B023-01のブラウザ検証 — 成功

Aの保存を保留し、Bでコードブックの状態を確認してから、Bに留まったままA応答を解放した。
B022-02相当の通知直前再検査を含む現行版で実施した。

- 条件1(C1-2): 保存要求を保留OK(pending=save・未送信)。
- 条件1(C1-6〜C1-9): A→B→Aと新結果C2の完了後に初解放。保存HTTP200・
  datasetId=ds-26082c1949b4・dataRevision=2・保存元resultId=20e0ad79。
  実データ版dataRevision=2・schemaRevision=1で保存応答と一致。
- 条件1(C1-11): 旧通知の混入なしOK(旧列名の通知要素なし)。新結果の表示維持OK。
- 条件1(C1-12): 現在datasetとの整合OK。
- 条件1(C1-13〜C1-16): 遅延保存後に再分析OK(dataRevision=2)→再分析後の保存200
  (dataRevision=3・作成列CJ_B08I1B_844469)→実列・正当な新通知ありOK。
  復旧保存後の版=3・stale表示=True(正常なstale)。
- 条件2(C2-2〜C2-3): 保存応答を保持OK(status=200)。
  保持応答の版dataRevision=2・schemaRevision=1・保存元resultId=9e3a53d9・
  作成列CJ_B08I2A_870185。
- 条件2(C2-7〜C2-8b): 新結果C4を生成(resultId=988bb5a4)。
  C4生成時dataRevision=2・schemaRevision=1・サーバー現在dataRevision=2・
  schemaRevision=1・画面stale=False。C4生成時とサーバー現在の版が一致OK。
- 条件2(C2-10〜C2-12): 旧通知の混入なしOK。新結果C4の表示維持OK。
  C4が旧応答で無効化されないことOK。保存ボタンの操作可否OK(有効)。
  実データの版が保持応答と一致OK。
- 順序assert OK。B08-2条件完了。

## B022-02の追加修正のブラウザ証拠 — 成功ログで確認

現在版の724〜727行はコードブック取得await後に保存世代・dataset・resultIdを再検査している。
事前計算したfresh値を使う問題はソース上で解消済みである。
本報告の試験はこの版で実施し、以下を確認した。

- 条件2(C2-9〜C2-10): 保存200後のコードブック応答だけを保留した相当経路
  (保存応答のfetch保持→A/B/A→C4生成→旧応答解放)で、旧成功通知が出ず
  (旧列名の通知要素なし)、現在画面の列・結果・待機状態が維持されること
  (新結果C4の表示維持・保存ボタン有効)。
- 旧通知の抑止を取り消していない。

## 証拠の対応

- 本報告のrunはRUN_TAG=145555の単一実行であり、ログは成功・失敗の実行ごとに
  `b08i_log_<RUN_TAG>.txt` で分けている。報告対象のrun・ソースSHA256・
  配信bundle名(`index-BHvWhWs2.js`)とSHA256
  (`3dc335648b1a872d85d105f4de6b2dcaeeb4f3e35f47cf27de464b3c19147a8b`)を特定した。
- 条件1の旧通知なしを観測した事実と、全条件の成功を分けて記載した。
- 旧b08i条件2の「成功」報告の訂正(REVIEW-020-REPLY)は維持する。
  今回は条件2を独立fixtureで完走し、新たな成功証拠に置き換えた。

## 未確認条件の正確な一覧

|条件|状態|証拠|
|---|---|---|
|旧通知なし(要求遅延)|成功|b08i条件1(C1-11)|
|旧通知なし(応答遅延)|成功|b08i条件2(C2-10)|
|POST回数1・版照合|両条件で成功|b08i条件1(C1-8・C1-14)・条件2(C2-8・C2-11)|
|遅延保存後の復旧(再分析→再保存200・実列・新通知)|成功|b08i条件1(C1-13〜C1-15)|
|応答遅延の全経路(保持→C4→解放→旧通知なし)|成功|b08i条件2(C2-2〜C2-12)|
|C4のmeta・中央・サーバー版の同時記録|成功|b08i条件2(C2-8)|
|ブラシ・逆方向選択の等値|成功(018報告)|b06d|
|保存値のrowId全件照合|成功|b10c|
|診断待機の往復|成功(017報告)|b08f診断ケース|
|B07遅延交差|成功(016報告)|b07d|

途中で終了したログはない。期待値を変更して不具合を成功扱いにしていない。
完全な型検査付きビルド(`tsc -b`)は他機能の進行中作業のため成功しない。
`vite build`直接実行のdistであり、本番ビルド成功とは同一視しない。
検証の適用範囲はconjoint画面に限定する。
