# Feature 032 REVIEW-004 修正報告

日付: 2026-09-14 / 対象REVIEW-004（コード指摘なし、受入証拠待ち）

## surveyのAPI経由E2E → 実施済み
- 2層×各3PSU・PSU内4行（n=24、層間でPSU番号重複p0〜p2）の隔離データでHTTP実行。
- auto解決=taylor、参照df=3（D=4、p=2、切片あり）を確認。
- 1PSU除外scopeで設計保持（参照df=3維持・fitCount=20）を確認。
- 重み100倍で係数・SE不変を確認。

## 選択応答待ち中の版変更 → 実施済み
- select要求をroute保留し、応答前にcodebook編集でschemaを+1して解放。
- 旧版rowIdsは選択へ適用されず（sidebar 0件維持）。サーバ409またはFE版照合で破棄。
- 証拠: .temp/lr-race.png。

## 本番配信経路 → 実施済み
- build_static.pyで再構築済み。静的実機でLR実行→有効3列R2=0.8402（local一致）。
- dev実ブラウザでも実行・係数・矩形選択135件・KeepAlive・予測150件・保存を確認済み。

## 再検証
- test_130＋131: 11 passed、MCA/FAMD API 12 passed（計23 passed）、tsc正常。
