# Feature 036 ヘッダ機能ナビゲーションの整理 — 実装報告（REPORT-001）

最新版: [REPORT-002（部分対応・未完了）](REPORT-002.md)。以下は初回報告の履歴であり、最新の受入判定ではない。

- 報告版: 001
- 日時: 2026-09-17 22:20 (JST)
- branch / HEAD: `master` / `70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31`（未コミット差分として作業ツリーに存在）
- 対象ファイル（SHA-256）:
  - `fullstack/frontend/src/app/AppShell.tsx` = `cc6a64f4fbec5e838044667e9bd5ad423e3b9cc2b33e9dd8288cfa1c6a702b79`
  - `fullstack/frontend/src/theme/viz.css` = `4032ee73b7e29778703ab5012606a8d52b0ef1d043ca33eccb5fdc82350dc7a6`
  - `fullstack/frontend/tests/appNavigation.test.tsx` = `04d9b68e95699e75fcdedc365e4c59530c0c38af28413832e8f71a29fa5e7bfa`（新規・未追跡）
  - `fullstack/frontend/dist/assets/index-C6wkSuw9.js` = `3f2f19b879ce9235b1f6892e91d34b3ba2ceb3fba88dc1255d64b0e428cc1cb7`（生成物）

## 1. 変更内容と理由

| ファイル | 変更 |
|---|---|
| [AppShell.tsx](../../../fullstack/frontend/src/app/AppShell.tsx) | 2段Segmented（VIS／ANALYSIS_NAV_ITEMS）を廃止し、`NAV_GROUPS`（6分類・31葉）＋`Menu mode="horizontal"`へ置換。`FeatureNavigation` を新設し、現在地表示・URL連動・狭幅inline展開・Escape処理を実装 |
| [viz.css](../../../fullstack/frontend/src/theme/viz.css) | `.feature-navigation*` 系の局所CSS（flex伸縮・44px行高・popup最大高60vh・狭幅パネル40vh・選択太字）を追加。既存ルールは触らない |
| [appNavigation.test.tsx](../../../fullstack/frontend/tests/appNavigation.test.tsx)（新規） | 分類網羅・ルート照合・URL正規化・全遷移・履歴・再選択・境界幅・Escape・フォーカスの限定テスト22件 |

- 分類・表示名・順序は設計書3.1の対応表どおり（4＋7＋4＋4＋7＋5＝31）。
- 分類keyは`group:`接頭辞、葉keyは既存ルートパス。単一定義から現在地・所属分類・遷移判定を導出。
- ブレークポイントは`Grid.useBreakpoint().lg`。`ConfigProvider`でこのナビ限定に`screenLG=1024`を上書きし、1024px以上＝横Menu／未満＝「機能一覧」ボタン＋inline Menuとした（既存App全体のtokenへは影響しない）。
- 設計との差異: 設計書はlg＝1024pxと読めるがantd既定のlgは992pxであるため、1024px境界を成立させるためにナビ配下のみ`screenLG`を上書きした（V05の1023/1024実測が根拠）。
- 実装中の追加修正: 通常幅のEscapeで開いたSubMenuを閉じる仕様（4.4）が初回実装で抜けていたため、`feature-navigation-row`の`onKeyDown`で`openKeys`を空にする処理を追加（単体テストで担保）。

## 2. 検証結果（V01〜V12）

実行コマンドと終了コード:

| 項目 | コマンド | 結果 |
|---|---|---|
| 限定テスト（22件） | `npm --prefix fullstack/frontend test -- tests/appNavigation.test.tsx tests/keepAlive.test.tsx tests/topKSelectionKeepAlive.test.tsx` | exit 0、22 passed / 0 failed（[final-limited-tests.log](../../../.temp/header-navigation/final-limited-tests.log)） |
| 通常ビルド | `npm --prefix fullstack/frontend run build` | exit 0、✓ built（[escape-build.log](../../../.temp/header-navigation/escape-build.log)） |
| 実ブラウザ検証 | `python .temp/header-navigation/verify_nav_8420.py` | **PASS 29/29**（[verify_nav_8420.json](../../../.temp/header-navigation/verify_nav_8420.json)・スクリーンショット同フォルダ） |

| ID | 判定 | 証拠 |
|---|---|---|
| V01 | **合格** | 6分類31葉がmain.tsxの全ルート・KeepAliveOutletの全キーと完全一致（単体テスト1件目）。実画面で6分類表示（verify_nav_8420.json: V01） |
| V02 | **合格（一部限定）** | 分類クリックで遷移しない・6分類から代表機能へ遷移・現在地表示（実ブラウザ6遷移PASS）。全31葉の個別実遷移はjsdomの全31遷移テストでカバー、実ブラウザは分類ごとの代表のみ |
| V03 | **合格** | `/`、`/pcp/`、`/models`、`/models/ca`、`/models/factor-analysis/`、`/unknown` の正規化テスト＋実ブラウザで `/models`・`/models/ca` の現在地が正しい（前方一致誤選択なし） |
| V04 | **合格** | 戻る・進む・外部Ranking・再選択で履歴が増えない（単体テスト）＋実ブラウザで戻る/進むの現在地追従 |
| V05 | **合格** | 実ブラウザで1440／1280／1024／1023／768／390pxを確認。1024以上＝横Menu（1024のみoverflow入口へ退避）、1023以下＝機能一覧ボタン。1440で横スクロールなし |
| V06 | **部分合格** | 1024で標準overflow入口（その他の分類）が出現することを確認。overflow配下からの全機能到達の実幅クリック試験は未実施 |
| V07 | **合格** | 実キー操作（Arrow→Enter→ArrowDown→Enter）で分類を開き本文へフォーカス。狭幅Escapeで閉じてボタンへフォーカス（実ブラウザ） |
| V08 | **合格（限定）** | `keepAlive.test.tsx`＋`topKSelectionKeepAlive.test.tsx`合格。PCP／重回帰／因子分析／コンジョイントの実画面往復は未実施 |
| V09 | **合格（限定）** | 共通操作バー・サイドバーは実ブラウザ確認で表示維持。行選択の複数分類往復照合は未実施 |
| V10 | **部分** | dataset切替時のメニュー閉じは実装済み（`useEffect`依存）。旧dataset結果の残存確認は未実施 |
| V11 | **部分** | 拡大表示への遷移でメニューが閉じる実装済み（`expanded`依存）。拡大中の実画面確認は未実施 |
| V12 | **合格** | `dist/assets/index-C6wkSuw9.js` を生成後、既存8420プロセス（PID 15320）を停止し、`run-production.bat` 経由で新規起動（preview server d3436f1d）。新規プロセス（PID 29684）が同一bundle名を配信、実画面検証スクリプト29/29 PASS（結果JSONのbundle記録 = `http://127.0.0.1:8420/assets/index-C6wkSuw9.js`） |

- 未実施・未確認: V06の実幅overflow試験、V08の実画面往復、V09の選択往復照合、V10の旧dataset残存確認、V11の拡大中実画面。
- 補足: 初回の8420検証（既存プロセス上）で28/29だった1件は、新規起動後の再実行で29/29となり再現しなかった（起動直後のdataset自動ロードと競合したタイミング依存と判断）。
- 既存の無関係な問題との切り分け: ビルド時の`node:url`等externalize警告、chunk 500kB超過警告、`createRoot`重複呼び出しコンソール警告は本変更以前からの既存事象。
- アクティブ変数選択等ヘッダ他要素の変更はなし。GlobalHeaderControlBar・サイドバー・Import/Save/Exportは既存のまま。

## 3. レビュー依頼事項

1. `screenLG=1024`のローカルConfigProvider上書きが設計意図（1024px境界）と整合するか。
2. EscapeでのSubMenu非表示方式（`setOpenKeys([])`）が4.4の趣旨（本文へフォーカスを飛ばさない）を満たすか。
3. V02/V08〜V11の未実施範囲の受入可否、または追加実施の必要性。

レビュー指摘には`REPORT-002.md`以降で対応します。作業ツリーには他機能（035・分析機能）の既存差分が多数残っており、本変更はAppShell.tsx／viz.css／appNavigation.test.tsx／launch.jsonに限定されています。
