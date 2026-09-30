# REVIEW-024 対応報告

日付: 2026-09-15。対象ソース: `fullstack/frontend/src/features/models/ConjointPage.tsx`
SHA256: `f7546ca00eb1dcd25352b3aa588f740320d5eff9013cb0b15acd881633a5477b`。
前回報告版(`89478e8d...`)からの差分: B023-01(中央store判定)のみ。B022-02の追加修正は
前回版に含まれており、今回はソース確認のみである。
配信: `fullstack/frontend/dist`(2026-09-15 14:50ビルド、`index-BHvWhWs2.js`、
SHA256: `3dc335648b1a872d85d105f4de6b2dcaeeb4f3e35f47cf27de464b3c19147a8b`)を
`http://127.0.0.1:8420/` で配信。試験時に読み込んだbundle名とSHA256を記録した。
本報告の試験はこの版で実施した。

試験: `fullstack/.temp/test_cj_b022.py` を実ブラウザで実行し成功。
RUN_TAG=152337。ログ: `fullstack/.temp/b022_log_152337.txt`(写し=`b022_log.txt`)。
画像: `fullstack/.temp/b022_caseX.png`、`b022_caseY.png`(目視済み)。

## B024-01 Bに留まったままの解放 — 成功

A保存待機→Bへ切替→Bのコードブックで未保存編集と列選択を作成→BのままA応答を解放の
実ブラウザ試験を追加した。A→B→Aの既存試験だけで完了扱いにしない。

- X1〜X2: Aでchoice実行OK(resultId=5868e288)。A保存要求を保留OK(列名=CJ_B022X_441748・未送信)。
- X3〜X5: Bへ切替(B選択表示=b01big_data 60行)。Bのコードブックで未保存編集を作成OK
  (質問文=B024-未保存-452078)。Bの列選択チェック=True。変更保留中タグあり。
- X6〜X7: B滞在のままA保存応答を解放。保存HTTP200・保存先datasetId=ds-1add524354c4・
  dataRevision=2・作成列CJ_B022X_441748。
- X8〜X8f: Bの未保存編集の維持OK(質問文が一致)。Bの未保存目印の維持OK。
  Bの列選択の維持OK(True)。B編集モーダルフッタの解放前後が一致。
  解放後のdataset表示=b01big_data(60行)でBのdataset表示の維持OK。
- X9〜X9b: Aへ戻し後に新列ありOK(CJ_B022X_441748)・版dataRevision=2・schemaRevision=1。
  Aへ戻し後の版一致OK。

今回のB023-01ブラウザ成功の記載は本試験の成功に基づく。未実施への訂正は解消した。

## B024-02 codebook応答保留 — 成功

保存APIの応答保持はcodebook応答保持の代替にしない。保存応答は通常通り返却し、
その後のコードブックGETだけを保留し、待機中にdatasetを切り替えてからGETを解放する
実ブラウザ試験を実施した。現状は未実施として扱わない。

- Y1〜Y2: 保存元Yを生成OK。保存200後のコードブックGETを保留OK
  (url=.../api/v1/datasets/ds-1add524354c4/codebook)。
- 保留URL・開始時点(t=100.8 CB-GET-HELD)・切替時点(t=107.1 CB-HOLD-SWITCHED-B)・
  解放時点(t=112.1 CB-GET-RELEASED)を記録した。
- Y3〜Y4: 待機中にBへ切替。コードブックGETを解放。
- Y5〜Y5e: 旧通知の混入なしOK。旧エラー通知の混入なしOK。
  解放後のB表示維持・dataset表示=b01big_data(60行)で現在画面(B)の維持OK。
  現在画面の列に旧保存列の混入なしOK。

## 証拠の対応

- 本報告のrunはRUN_TAG=152337の単一実行であり、ログは成功・失敗の実行ごとに
  `b022_log_<RUN_TAG>.txt` で分けている。報告対象のrun・ソースSHA256・
  配信bundle名(`index-BHvWhWs2.js`)とSHA256
  (`3dc335648b1a872d85d105f4de6b2dcaeeb4f3e35f47cf27de464b3c19147a8b`)を特定した。
- 画像2点を目視した。caseXはAへ戻し後の画面で新列・新版の取得を示し、
  caseYはB滞在中の画面でB表示の維持を示す。

## 未確認条件の正確な一覧

|条件|状態|証拠|
|---|---|---|
|B滞在中のA保存解放|成功|b022ケースX(X1〜X9b)|
|codebook GET保留|成功|b022ケースY(Y1〜Y5e)|
|旧通知なし(要求遅延)|成功(020報告)|b08i条件1|
|旧通知なし(応答遅延)|成功|b08i条件2|
|POST回数1・版照合|両条件で成功|b08i条件1・条件2|
|ブラシ・逆方向選択の等値|成功(018報告)|b06d|
|保存値のrowId全件照合|成功|b10c|
|診断待機の往復|成功(017報告)|b08f診断ケース|
|B07遅延交差|成功(016報告)|b07d|

途中で終了したログはない。期待値を変更して不具合を成功扱いにしていない。
完全な型検査付きビルド(`tsc -b`)は他機能の進行中作業のため成功しない。
`vite build`直接実行のdistであり、本番ビルド成功とは同一視しない。
検証の適用範囲はconjoint画面に限定する。
