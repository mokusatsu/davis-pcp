# Feature 036 実装報告002（部分対応・未完了）

日時: 2026-09-17。対象: REVIEW-001／REVIEW-002。最新レビューOKは未取得。
基点: master / 70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31。コミット・pushは実施していない。

## 今回の変更

[viz.css:71](../../../../fullstack/frontend/src/theme/viz.css:71)のセレクターを`.feature-navigation-popup.ant-menu-submenu-popup .ant-menu-vertical.ant-menu-sub`へ変更した。Ant Designの3クラスの高さ指定に優先し、ナビ専用の60vh制限を適用する。overflow親へpopupClassNameを指定するAppShellの変更は引継ぎ時点で存在し、今回編集していない。

`.claude/launch.json`には他スレッドのサーバーを止めずに検証するための`davis-pcp-036-resume`を追加した。preview server IDは`200bb7fb-efcc-4402-95f5-d5dd4798f318`、起動portは5197。

## 識別情報

| 対象 | SHA-256 |
|---|---|
| fullstack/frontend/src/app/AppShell.tsx | a1705fa0d61b349c56e64b02425da4c345820ee106cadbea7e4347c66ffa7a5f |
| fullstack/frontend/src/theme/viz.css | 1545f863af6ca3ddeca7239f09f5087440665017d7a511eb410b1ce133fa58db |
| fullstack/frontend/tests/appNavigation.test.tsx | 04d9b68e95699e75fcdedc365e4c59530c0c38af28413832e8f71a29fa5e7bfa |
| dist/assets/index-BKo4d9vi.js | 4673460b7e226d678ac52ac9b86dd0a1cecb79ff11a029c47b1cc3c61ef10e80 |
| dist/assets/index-ln5rxMhz.css | d0c199dc0be0016e315437985b11e4254f925e0fafcb3c0d39b576bbd806ab05 |

## 確認結果

- `npm --prefix fullstack/frontend test -- tests/appNavigation.test.tsx tests/keepAlive.test.tsx tests/topKSelectionKeepAlive.test.tsx`: exit 0、3ファイル22件成功。ナビ単独は18件。[ログ](evidence/resume-css/resume-036-css-tests.log)。React Router／act／jsdom等の警告は残る。
- `npm --prefix fullstack/frontend run build`: exit 0。[ログ](evidence/resume-css/resume-036-css-build.log)。生成CSSに`max-height:60vh;overflow-y:auto`を含む新セレクターが存在することを別途assertした。
- 実ブラウザ5197、1024×600: 可視のoverflow親popupに専用classが付き、子ulのcomputed max-height=360px、overflow-y=auto、height=48pxを確認。親popupの実矩形はx=569、y=124、幅184、高さ56で画面内だった。このケースはscrollHeight=clientHeight=48で、実際にスクロールが必要な低高ケースを証明しない。
- 同画面で「その他の分類」→「次元削減・因子分析」→「因子分析」をクリックし、pathname=/models/factor-analysis、現在地=「次元削減・因子分析 › 因子分析」を確認。
- 既存8420へブラウザ移動し、同じ現在地と`http://127.0.0.1:8420/assets/index-BKo4d9vi.js`の読込を確認。今回run-production.batによる新規起動はしておらず、起動経路の独立証拠は未取得。
- 上記DOM実測は本スレッドのpreview_eval出力の転記であり、再実行可能な証拠ファイル・成功画像の保存は未完了。描画が進まない場面でdocument.visibilityState=hiddenを観測し、画像取得のタイムアウトも発生した。popup消失の遅延が製品か検証環境かは未切り分け。

## 追加確認（compactナビの1往復）

既存8420・約1022px幅で、因子分析→Table（IRIS-001を選択）→PCP→因子分析のメニュー操作往復を実施し、sidebarの「選択行 1」を選択前行と同じrowIdで確認した。ページリロードを挟まないSPA遷移。証拠は[spa-roundtrip-v09-partial.json](evidence/resume-css/spa-roundtrip-v09-partial.json)。複数分類往復、変数・ウェイト・行範囲の照合は未実施であり、V09全体の合格とはしない。

## 指摘別状態

| 指摘 | 状態と残作業 |
|---|---|
| N001-01 | クラス指定を引継ぎ、CSS優先順位を修正。60vh適用は実測。低い通常幅で実スクロールと末尾到達の検証は残るため完全解消とはしない。 |
| N001-02 | overflow経由の因子分析への1遷移を確認。全機能、390pxスクロール、長ラベル、幅往復は未完了。 |
| N001-03 | V08〜V11実画面連携は未完了。 |
| N001-04 | 実Tab、通常幅・overflowのEscape復帰、同一／異なる機能選択後の本文focusは未完了。 |
| N001-05 | 本報告のリンクを修正しログを永続配置。新版bundle配信確認済み。run-production起動経路の独立証拠、初回失敗runの保存は未解消。 |

## 旧検証結果の扱いと再開点

`.temp/header-navigation/verify_n001.py`とJSONはそのまま保存し、受入成功の証拠には使わない。子葉を正しく特定せずURL未変化でも成功にする判定、body全体の文字列でも通るfocus判定、状態保持検証でpage.gotoを使うフル再読み込み、誤ったAPIパス、本文文字数だけの結果保持判定がある。これらを修正した試験はまだ作成していない。

V01〜V04は既存限定テストの範囲で成功。V05〜V07は前報告の不足を引継ぎ未完了、V08〜V11は未完了。V12はビルドと新版配信のみ確認し、起動経路の証拠を残す。

次の担当は既存スクリプトの成功数を増やすのではなく、SPAメニュークリック後のpathname・現在地、実フォーカス要素、rowId集合、入力値、解析結果を直接比較すること。N001-01の低高スクロールから再開する。レビュー文書は変更していない。レビュー監視タイマーは本スレッドでは未設定であり、監視中ではない。
