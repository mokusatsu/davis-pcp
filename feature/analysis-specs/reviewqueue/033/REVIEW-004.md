# Feature 033 EFA レビュー004

判定: **E006・E012・E013は解消。E009・E011は残件あり。受入未完了。**

- 日付: 2026-09-14
- 対象: REVIEW-003-REPLY.md、SHA256 `5671AC58B97F23E8AE55B20385FF15CD906CC2F331A349976DEDD616AD1024CC`
- 対象版: HEAD `70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31`からの未コミット実装。
- E001〜E005・E007・E008・E010の解消判定を維持する。

## 解消を確認した項目

- E006: 連続項目でもmissingReasonsによる無回答／非該当の分類を行い、分布・除外内訳へ反映する修正を確認した。追加のAPI試験も成功した。
- E012: カテゴリ件数・割合、最小件数、最大割合、床／天井集中、順位歪度の表示が追加され、前回指摘の連続近似の判断材料を確認できる。回答にある「全文表示」の漠然とした残件だけでは本指摘を継続しない。
- E013: 名義・尺度不明は根拠なしで拒否される。ordinal指定のscaleBasisを許可値で検証し、codebookScaleとともにmeasurementResolutionへ保存する。continuousへの名義・尺度不明の指定は拒否される。追加試験も成功した。

## E009 [P2] 空の共通範囲でreplace選択が適用されない

`fullstack/frontend/src/features/models/FactorAnalysisPage.tsx:239-248`。

同一因子のX/Y範囲の共通部分を取る修正は正しい。ただし空共通の場合はメッセージだけ更新してreturnし、中央選択へ空集合を適用しない。既に選択がある状態でreplace操作を行うと、通常の0件矩形なら選択を解除するところ、既存選択が残る。`app/store.ts:101-105`のreplace規則に合わせ、空集合も現在の選択操作へ渡すこと。add/subtract/toggleでは空集合が無操作となることも維持する。

異なる因子の点クリック0→1→0、矩形0→146、KeepAlive、因子数2→1の結果交替については、提出された通常ブラウザの記録 `.temp/review-033-e2e/e2e_log.txt` と対応コードを確認した。この証拠は同一因子・既存選択あり・空共通のケースを含まない。

## E011 [P1] 非同期化は追加されたが中断・永続化の終端状態が保護されていない

主結果と別のスレッド、比較IDでのpoll、PAの進捗callback、中断イベントが追加されたことを確認した。OSレベルの即時killは要求しない。残件は次のとおり。

1. **保存失敗を再び握り潰している。** `api/factor_analysis.py:232-246`の進捗更新、`554-566`のworker失敗記録、`1482-1494`のcancel保存は広いexceptで失敗を捨てる。save_artifactをOSErrorにした隔離確認で、_note_progressはTrueを返し、cancelはstatus=success/cancelled=Trueを返した。`_remember_comparison`の500変換だけでは報告の「永続失敗が伝播する」を満たさない。保存できなかった状態を成功扱いせず、poll/cancelで判別できる失敗として扱うこと。
2. **cancel後にworkerがcompleted/failedを上書きできる。** `_run_sensitivity`は`418`などでロック・終端確認なしに保存し、その後で_backgroundの`549-553`がcancelledを確認する。PA終了後の比較処理中にcancelがタイムアウトしてcancelledを保存した場合、workerがその後completedを保存してから確認するので保護にならない。各終端遷移を同じロック内で最新状態と照合し、中断後に完了へ戻さないこと。主結果IDの紐付けも同じ状態更新規則に統一すること。
3. **自動テストが通常の非同期経路を通らない。** `569`のPYTEST_CURRENT_TEST分岐は比較を同期化するため、既存テスト成功では上記競合を検証できない。通常経路を明示的に通し、主結果先行・進捗・実行中cancel・失敗・終端状態維持を確認する対象試験が必要。

## 検証と受入状況

- レビューアー再実行: EFA kernel13件＋API9件、**22 passed**。隔離workspaceを使用。
- 保存失敗注入: 進捗更新がTrue、cancelがsuccessを返すことを再現。実データへの書込みはない。
- 通常ブラウザ初回の提出ログを確認。今回レビューアーがブラウザ操作を再実行したものではない。ML／none／Bartlettの組合せは提出報告でも未検証。
- polychoricの外部照合は許容差未達（報告の最悪比1.755／1.307）、ULS外部照合、B02/B03不変性、失敗・境界・比較・中断、代表サイズ性能は引き続き未完了。既存22件と初回画面検証だけで受入完了にはしない。
- Pyodide実ブラウザ操作は受入条件に含めない。実装修正・ビルド・全体テストは行っていない。

## 確認ソースSHA256

- api/factor_analysis.py: `FD450614AC62D949CE448862848900C032E566D2E43DDF6C1A5C957B34F8BD28`
- services/factor_analysis_service.py: `4AB4E5EC5D710391D9F972078D525591E71F51751234748C2FF2BEC6BCB35D4E`
- FactorAnalysisPage.tsx: `926AB50F3390BA4099BCE856ED1C161AA6D63DAD66FF80D67D9051C3E93FA8DA`

未解消のコード指摘はE009・E011。受入検証も残っているため、問題なしとは判定しない。
