# Feature 029 実装レビュー 004

判定: **コード指摘8件の解消を維持。最終受入は引き続き保留。**

- レビュー日: 2026-09-13
- 対象: 更新された`REPORT.md`と最終受入の追加記録
- 報告 SHA256: `3bf6b4d6f8b59b2ed6fde0f1ef42477e51a008aec818398cee749be6f54b64a8`
- 現在HEAD: `6a3058553d0c14dd276bdf2a301dd6fe5620d2dd`
- 実装確認済み版: `71df4b55`。その後のコミットはtasks/DAVIS-FEAT-029.mdへの5行追記のみ。コードの変更はない。

## 追加証拠の評価

### Pyodideブラウザ操作: 未検証のまま

static配信のHTTP200、ZIP収録、ZIPから取り出したkernelの実行は配信・同梱コードの確認として有用だが、ブラウザのPyodide worker内での実行証拠ではない。今回の追記もREVIEW-003で区別した確認範囲と同じであり、受入確認の代替にはならない。

根拠: `feature/analysis-specs/tasks/ACCEPTANCE_AND_HANDOFF.md:94`はlocal/staticの実ブラウザに同じfixtureを投入して分析・選択・export・stale・KeepAlive復帰を確認することを定めている。`feature/analysis-specs/tasks/DAVIS-FEAT-029-034-COMMON-DESIGN.md:148`もlocal API、型検査、static実機を別の確認段階としている。

CAでは未対応と明示されたmaterializeを成功させる必要はない。対象版、ブラウザ、fixture、Pyodide側の実行結果、カテゴリ選択と中央selection、複数ページ取得/export、stale、再実行、KeepAlive復帰を確認した証拠が必要。

### 起動バッチ: 直接起動の未検証を維持

REPORT.mdは「pause付きのため直接実行せず」と記載している。実際の`fullstack/run-production.bat`を確認したところ、pauseはPowerShellスクリプト呼出の後にある。サーバー起動前に入力を要求する処理ではなく、pauseの存在は起動確認を省略する根拠にならない。

既存backendの応答成功だけでは、この入口からの作業ディレクトリ、PowerShell呼出、python解決、uvicorn起動まで通ることは確認できない。「残る未検証はPyodideのみ」という報告のまとめは、起動バッチ未実行という記載と整合しない。直接起動の証拠が得られるまでは未検証として記録すること。

## 検証と結論

今回確認したのは報告、タスク記録、差分、起動スクリプト、受入仕様である。コード変更がないため、REVIEW-003のテストは重複実行していない。今回の配信・kernel実行の記載も独立再実行したものではない。

R001〜R008の修正確認は取り消さず、新たなコード修正要求もない。一方、上記2項目の実行証拠は追加されていないため、最終受入の「問題なし」はまだ記載できない。必要な操作の実施結果を追記後、最終確認する。
