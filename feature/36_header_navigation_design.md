# Feature 036 ヘッダ機能ナビゲーションの整理

版: 1.0 / 作成日: 2026-09-14 / 状態: 設計書作成済み・実装未着手

## 1. 目的と対象

ヘッダに並ぶ31機能を、Ant DesignのMenuとSubMenuによる6分類のナビゲーションへ整理する。機能を探す負担とヘッダの占有量を減らし、グラフの表示領域を確保する。

対象はAppShellの機能ナビゲーション、現在地表示、その操作・回帰検証。データセット、Import／Save／Export、コードブック、License、共通変数・ウェイト・行範囲・選択操作、右側の選択行サイドバーは既存の配置と機能を維持する。

## 2. 現状と設計の基点

| 対象 | 確認した構造 |
|---|---|
| [AppShell](../fullstack/frontend/src/app/AppShell.tsx) | VIS_NAV_ITEMS 12項目、ANALYSIS_NAV_ITEMS 19項目。main-navはSegmentedの2段構成で各段に横スクロールがある |
| [ルート定義](../fullstack/frontend/src/main.tsx) | 通常環境はBrowserRouter、staticはHashRouter。初期画面はPCP |
| [KeepAliveOutlet](../fullstack/frontend/src/app/KeepAliveOutlet.tsx) | 訪問済み画面をマウントしたまま非表示にする。データセット変更時には画面を再初期化する |
| [共通操作](../fullstack/frontend/src/features/selection/GlobalHeaderControlBar.tsx) | 中央状態を利用し、Rankingへの直接移動も持つ |
| [依存関係](../fullstack/frontend/package-lock.json) | antd 5.29.3、rc-menu 9.16.1。新しい依存関係やバージョン更新は不要 |
| [起動処理](../fullstack/run-production.ps1) | frontend/dist/index.htmlがない場合だけビルドする。既存distがある場合は自動更新しない |

既存の機能ページ、URL、分析API、計算処理は変更しない。URLを維持するための互換ルートや旧新ナビゲーションの併存は作らない。

## 3. Menu／SubMenuの構成

通常幅ではMenuを1つ置き、modeをhorizontalにする。6分類をSubMenu、そのchildrenを機能のMenuItemとする。アプリ側の階層は「分類→機能」の2階層に限定する。

記述にはMenuのitems APIを使う。childrenを持つ親項目はAnt DesignのSubMenuTypeとして扱われ、Menu.SubMenuに相当するSubMenuを構成する。6個の独立したDropdownは作らない。JSX形式のMenu.SubMenuとitems形式を重複管理しない。

MenuProps['items']に適合する固定のグループ定義を1つ持ち、葉のkeyは既存のルートパスにする。分類keyは下表のgroup:接頭辞を付け、URLと区別する。現在地の表示名、所属分類、遷移先判定は同じ定義から取得する。

### 3.1 全機能の割当

機能の表示名は次表を初期値とする。既存名の併記で従来の機能を特定できるようにする。説明が長くなるものは既存名を残し、手法そのものの名称変更は別の分析仕様へ波及させない。

| 分類key | 分類名 | 機能key（URL） | 表示名 |
|---|---|---|---|
| group:data | データ・概要 | /table | データ表（Table） |
| group:data | データ・概要 | /overview | データ概要（Overview） |
| group:data | データ・概要 | /statistics | 記述統計（Statistics） |
| group:data | データ・概要 | /covariance | 共分散（Covariance） |
| group:visual | 可視化 | /pcp | 平行座標（PCP） |
| group:visual | 可視化 | /distribution | 分布（Distribution） |
| group:visual | 可視化 | /likert | Likert |
| group:visual | 可視化 | /touring | Touring |
| group:visual | 可視化 | /fedf | FEDF |
| group:visual | 可視化 | /barchart | 棒グラフ（Bar Chart） |
| group:visual | 可視化 | /loess | Loess |
| group:relations | 関係・集計 | /relationships | 変数間の関係（Relationships） |
| group:relations | 関係・集計 | /associations | Surprise |
| group:relations | 関係・集計 | /mosaic | Mosaic |
| group:relations | 関係・集計 | /crosstab | クロス集計（Crosstab） |
| group:patterns | パターン探索 | /ranking | 変数ランキング（Ranking） |
| group:patterns | パターン探索 | /subgroups | Mining |
| group:patterns | パターン探索 | /clusters | クラスタリング（Clusters） |
| group:patterns | パターン探索 | /robustness | 頑健性（Robustness） |
| group:prediction | 予測・要因分析 | /models | 決定木・ランダムフォレスト（Models） |
| group:prediction | 予測・要因分析 | /logistic | ロジスティック回帰（Logistic） |
| group:prediction | 予測・要因分析 | /discriminant | 判別分析（Discriminant） |
| group:prediction | 予測・要因分析 | /models/linear-regression | 重回帰 |
| group:prediction | 予測・要因分析 | /key-drivers | Key Drivers |
| group:prediction | 予測・要因分析 | /penalty-reward | Penalty-Reward |
| group:prediction | 予測・要因分析 | /models/conjoint | コンジョイント |
| group:dimensions | 次元削減・因子分析 | /pca | 主成分分析（PCA） |
| group:dimensions | 次元削減・因子分析 | /models/ca | 対応分析（CA） |
| group:dimensions | 次元削減・因子分析 | /models/mca | 多重対応分析（MCA） |
| group:dimensions | 次元削減・因子分析 | /models/famd | 混合データ因子分析（FAMD） |
| group:dimensions | 次元削減・因子分析 | /models/factor-analysis | 因子分析 |

件数は4＋7＋4＋4＋7＋5＝31。並び順は上表に固定し、利用履歴や現在のデータ型で並べ替え・非表示にしない。

## 4. 表示・操作仕様

### 4.1 通常表示

- 1024 CSS px以上ではhorizontal Menuを表示する。既存のmain-nav識別子を維持する。
- MenuはminWidth: 0とflexによる伸縮を許可する。横スクロール指定を除去する。
- 利用可能な幅が足りない場合はMenu標準のoverflowへ分類を退避し、入口の表示を「その他の分類」とする。内部のoverflow keyをハードコードしない。
- 6分類が収まる通常表示では、分類を開く→機能を選ぶ、の2操作。overflow経由の場合は3操作を許容する。
- 選択中の機能と親分類を強調する。現在地をMenuの横に「分類 › 機能名」と表示する。名前が長い場合は現在地だけ省略表示とし、ツールチップとアクセシブルな名前で全文を取得できるようにする。
- ナビゲーション行の高さは44px以上を確保する。機能の増加に応じてタブを折り返して段数を増やさない。

### 4.2 狭い画面

- 1024 CSS px未満は「機能一覧」ボタンと現在地を表示する。ブレークポイント判定は既存Ant Design Grid.useBreakpointのlgを利用する。
- ボタンの直下に展開領域を設け、同じitemsをmode="inline"のMenuに渡す。画面を覆うモーダルや常設の左サイドバーは追加しない。
- 展開時は現在地の分類を初期展開する。他の分類を開くと前の分類を閉じ、同時に展開する分類は1つとする。
- 展開領域は最大40vhで縦スクロール可能にし、横スクロールさせない。長いラベルは折り返し、行の高さを自動にする。
- 機能選択、Escape、機能一覧ボタンの再押下で領域を閉じる。閉じるだけなら機能一覧ボタンへフォーカスを戻す。
- 幅の切替時には古いpopup／展開領域を閉じる。URLと分析画面を変更しない。通常用と狭幅用のMenuを同時に操作可能なDOMとして残さない。

### 4.3 状態管理と遷移

| 状態・API | 方針 |
|---|---|
| selectedKeys | location.pathnameを正規化して導出する。defaultSelectedKeysや独立した選択stateを正本にしない |
| パス正規化 | 末尾スラッシュを除去し、/は/pcpとして扱う。既存KeepAliveの解釈と一致させる |
| 一致条件 | 葉のkeyと完全一致。/modelsの前方一致でCAや因子分析を誤選択しない |
| openKeys／onOpenChange | UIの開閉だけを管理する。通常幅では標準overflowの開閉も保持できるよう、分類keyだけのフィルタを適用しない。狭幅では分類を1つに制限する |
| triggerSubMenuAction | click。hoverだけで開く仕様にしない |
| onClick | 登録済みの葉keyだけnavigateへ渡す。分類のクリックでは画面移動しない |
| 同じ機能の再選択 | メニューを閉じ、履歴を追加しない。再計算・再マウントもしない |
| URL変更 | 開いているメニューを閉じ、選択と現在地を再導出する。ブラウザの戻る・進む、外部ボタンからのnavigateも対象 |
| 未登録URL | 選択を空にし、現在地は「未登録の画面」とする。ナビゲーション側で勝手にPCPへリダイレクトしない。既存ルーターの処理へ委ねる |
| datasetId変更 | メニューを閉じる。既存のデータセット初期化処理に従い、ナビゲーション側でselectionのリセットを追加しない |
| グラフ拡大表示 | 既存focused条件でヘッダを隠す際にメニューも閉じる。body側popupを残さない |

Menuの描画や分類を開く操作ではAPI呼び出し、分析の開始、履歴更新を行わない。

### 4.4 キーボード・フォーカス・popup

- 外側をnav要素とし「機能ナビゲーション」のアクセシブルな名前を付ける。Menuの標準roleとキーボード操作を利用し、tablistへの置換や独自の矢印キー操作を追加しない。
- Tabで到達でき、矢印キーで移動し、Enterで機能を選択できることを実ブラウザで確認する。現在の機能は色だけに頼らず、選択状態と現在地テキストでも示す。
- 通常幅のEscapeはSubMenuを閉じて開いた分類へ戻す。画面移動を伴わない閉じ操作で本文へフォーカスを飛ばさない。
- キーボードによる機能選択後は表示中の本文へフォーカスを移す。非表示のKeepAlive画面へ送らない。通常のポインタ操作で入力欄を不用意にフォーカスしない。
- AppShellのlocation.pathname変更時の既存blur処理と調整する。設問ツールチップを閉じる既存イベントは維持し、blurより後に必要なフォーカス移動を行う。二つのeffectの順序に依存してフォーカスが消えない構成にする。
- popupは既存のbody表示方針と整合させ、ヘッダ／本文のoverflowで切れないことを確認する。Menuのpopupに限定したclassで最大高さ・縦スクロールを調整し、全てのAnt Design popupへCSSを波及させない。

## 5. 実装範囲と依存関係

| ファイル | 予定する変更・確認 |
|---|---|
| fullstack/frontend/src/app/AppShell.tsx | 2段SegmentedをMenu／SubMenuへ置換。分類定義・現在地・開閉・狭幅展開・フォーカス連携を実装する。既存exportの全参照を検索して、必要な参照を同時更新する |
| fullstack/frontend/src/theme/viz.css | 必要な場合だけ、機能ナビゲーションに限定した幅・折り返し・popupのスタイルを追加する |
| fullstack/frontend/tests/appNavigation.test.tsx（新規予定） | 分類の網羅性、ルート連動、開閉、操作、履歴に絞った回帰検証 |
| fullstack/frontend/tests/keepAlive.test.tsx | 既存検証を実施。ナビゲーション経由の状態保持の不足分だけ追加する |
| fullstack/frontend/src/main.tsx、src/app/KeepAliveOutlet.tsx | 登録済みルートとの照合対象。ページ登録とKeepAliveのライフサイクルは原則変更不要 |
| fullstack/frontend/src/features/selection/GlobalHeaderControlBar.tsx | Rankingへの直接移動と共通操作の回帰確認。業務処理は変更しない |

最初はAppShellの既存ナビゲーション定義を整理する。汎用ナビゲーション基盤や別のルートレジストリは新設しない。機能ページを新しいMenuの子としてマウントしない。

Feature 035もAppShellを変更するため、同じファイルの同時編集を避ける。実装開始時に最新の作業ツリーを確認し、035のヘッダ表示・拡大表示の変更と統合する。分析機能032〜034の既存変更も保持する。

旧タスク内のVIS_NAV_ITEMS／ANALYSIS_NAV_ITEMSへの追加指示は当時の構造を記録したものとして残す。036の実装後に機能を追加する場合は本書の分類定義に従い、main／KeepAliveの登録と合わせて照合する。

## 6. 実装段階

| 段階 | 内容 | 終了条件 |
|---|---|---|
| S0 基準確認 | git状態、AppShellの既存差分、31機能とルート、導入antd型、035との重複を確認 | 編集範囲と分類の集合が確定し、既存差分を識別できる |
| S1 通常Menu | items／SubMenu、現在地、URL連動、通常popupの開閉を実装 | V01〜V04の対象範囲に合格 |
| S2 狭幅・操作 | inline表示、overflow、フォーカス、Escape、幅切替を実装 | V05〜V07に合格 |
| S3 連携回帰 | KeepAlive、選択、dataset切替、拡大表示、共通操作を確認 | V08〜V11に合格 |
| S4 提供確認 | 許可されたビルド・本番起動確認、証拠とタスク状態の更新 | V12に合格。未実施ゲートは残作業として明示 |

コーディングはリポジトリのAGENTS.mdに従い、範囲を明確にしたclaude_coder等に委譲する。cwd、対象ファイル、上記契約、検証内容、既存差分の保持を明示する。両方の指定エージェントが利用不能の場合は規約のフォールバックを適用する。親担当が差分採否と最終検証を行う。

## 7. 受入・検証計画

| ID | 合格条件 | 検証方法 |
|---|---|---|
| V01 | 6分類・31葉で重複なし。現行ナビ、main、KeepAliveとの対応に欠落がない | ソース集合照合＋限定テスト。新機能が増えていれば実装前に台帳更新 |
| V02 | 分類を開いても遷移しない。各機能選択で対応する画面が表示される | 全31遷移の限定テスト＋実ブラウザで全分類を開く |
| V03 | /、末尾/、/models、/models/ca、/models/factor-analysis等で現在地が正しい | MemoryRouterによる完全一致・正規化テスト |
| V04 | 戻る・進む、直接URL、Rankingへの外部移動に追従。同じ項目の再選択で履歴が増えない | 限定テスト＋実ブラウザ履歴操作。Browser／Hash両方式を対象 |
| V05 | 1440、1280、1024、1023、768、390pxで機能が到達可能。ナビ領域に横スクロール・重なりがない | 実ブラウザで寸法と画面を記録。1280pxの200%拡大も確認 |
| V06 | overflow配下からも全機能へ到達し、長い項目が読める。幅切替後に古いpopupが残らない | 実幅を縮めて標準overflowを発生させ、クリック・縦スクロール・幅往復を確認 |
| V07 | キーボードだけで到達・選択・Escapeが可能。閉じた後のフォーカスと現在地が正しい | 実キー操作。非表示画面の要素へのfocusがないことを確認 |
| V08 | 分析中／結果表示中／入力途中の画面を往復しても状態が保持される | 既存keepAlive、topKSelectionKeepAliveの限定実行＋PCP、重回帰、因子分析、コンジョイントの実画面往復 |
| V09 | 中央選択・変数・ウェイト・行範囲が移動前後で維持され、Table／PCPに反映される | 行選択後に複数分類を往復。選択行IDと件数を照合 |
| V10 | dataset切替時に従来の再初期化が行われ、旧datasetの結果やpopupが残らない | 別datasetへ切替→訪問済みページを再訪。通常データ、全NaN列を含むデータで確認 |
| V11 | グラフ拡大中にメニューが残らず、解除後に利用できる。共通ヘッダ・右サイドバーの操作も維持 | Feature 035の現行構成で拡大・解除、Import／Save／Export等の既存操作を確認 |
| V12 | 最新変更を反映したdistをrun-production.bat経由で確認できる | ビルド指示の有無、生成日時・ハッシュ、起動URL、現在地と分類の実画面証拠を記録 |

検証順は静的照合→変更対象の限定テスト→実ブラウザの連携確認。最初から巨大な全体テストは実行しない。全体テストは実装範囲の問題が解消してから、必要性がある場合に行う。

jsdomの合格だけで幅、popup位置、スクロール、フォーカス、描画状態の検証済みとはしない。テスト件数・失敗内容・対象コミットまたは作業ツリー・ブラウザ幅・スクリーンショットを実装タスクへ記録する。

## 8. ビルド・提供と停止条件

本書の作成は製品実装・ビルドの開始を含まない。実装指示後も、ビルドは明示的な指示がある場合に実施する。run-production.batは古いdistを自動更新しないため、起動できただけではV12を達成したことにならない。ビルド指示がない場合はソースと限定検証まで記録し、V12を未実施として残す。起動スクリプトの自動ビルド条件も無断で変更しない。

static成果物が必要な場合はstaticビルドの指示に従う。HashRouterの限定テストと実際のstatic配布物の検証を区別する。

分析・選択・データの契約変更、互換設計、別タスクとの編集競合が必要になった場合は、該当変更を止めて影響を示す。不要なお気に入り、検索、利用履歴、自動並べ替え、画面の統合・削除は追加しない。

一時作業の出力はリポジトリの.temp/配下へ集約する。正式な設計はfeature/、進捗と検証記録はtasks/に置く。

## 9. 参照と成果物

- [設計記録](../tasks/DAVIS-FEAT-036-DESIGN.md)
- [実装タスク・計画](../tasks/DAVIS-FEAT-036.md)
- [開発タスク一覧](../tasks/task-list.md)
- [グラフ拡大設計](35_graph_expansion_design.md)
- [Ant Design Menu公式API](https://ant.design/components/menu/): items／SubMenuType、mode、selectedKeys、openKeys、triggerSubMenuAction、onOpenChange、overflowedIndicator、FlexのFAQを確認した。公式サイトは6系のため、採用APIは導入済み5.29.3の型定義と照合する。6系専用APIは採用しない。

ローカルで確認した型定義: fullstack/frontend/node_modules/antd/es/menu/interface.d.ts、menu.d.ts、およびrc-menu/lib/interface.d.ts。最終的な動作保証はS1〜S3の検証で行う。
