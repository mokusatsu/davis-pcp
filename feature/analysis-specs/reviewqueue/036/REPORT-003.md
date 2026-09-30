# Feature 036 実装報告003（再選択修正・受入未完了）

日時: 2026-09-18 JST。対象レビュー: REVIEW-003。基点: master / 70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31。最新ソースへのレビューOKは未取得。コミット・pushなし。

## 変更と確認済みの範囲

[AppShell.tsx](../../../../fullstack/frontend/src/app/AppShell.tsx)の通常幅ナビで、葉のEnterイベントがメニュー内部のキー処理を通過した後にもopenKeysを閉じるよう修正した。既存の遷移、キーボード時の本文フォーカス通知、同一URLの履歴抑制は維持する。分類や矢印キーの処理は追加していない。

[appNavigation.test.tsx](../../../../fullstack/frontend/tests/appNavigation.test.tsx)に通常幅・狭幅の2ケースを追加した。Enter選択・同一機能のEnter再選択・ポインタ再選択について、遷移先、履歴キー、メニュー閉鎖、キーボード通知の回数を検査する。jsdomのイベント試験であり、実Tab到達や本文の実フォーカスの証明ではない。

- 修正前: 24件中23件成功・1件失敗。通常幅の再選択後にaria-expandedがtrueで残った。[失敗ログ](evidence/review003-resume/review003-keyboard-unit.log)
- 修正後: 同じ3ファイルで24件成功・失敗0、exit 0。[成功ログ](evidence/review003-resume/review003-keyboard-unit-after.log)
- 通常ビルド: exit 0。[ビルドログ](evidence/review003-resume/review003-keyboard-build.log)
- テストコマンド: `npm --prefix fullstack/frontend test -- tests/appNavigation.test.tsx tests/keepAlive.test.tsx tests/topKSelectionKeepAlive.test.tsx`
- ビルドコマンド: `npm --prefix fullstack/frontend run build`

ソース・成果物のSHA256とHTTP配信物の照合は[manifest](evidence/review003-resume/keyboard-fix-manifest.json)に保存した。新JSはindex-CKY31PSW.js、CSSはindex-ln5rxMhz.css。8420のindex.htmlと両assetの取得内容がローカル成果物と一致した。ただし配信ファイルの照合は、修正後のブラウザ操作成功を意味しない。

本セッションではpreview_startのdavis-pcp-production-036が2026-09-17T15:28:19.493Zに8420で起動し、server IDは78475199-236e-4931-a466-8ba0244be16e。新規プロセス起動のツール結果は会話にあるが、独立した永続起動ログの保存は未完了。

## 試行した検証の問題と成功主張の訂正

[verify_r003.py](evidence/review003-resume/verify_r003.py)と[最終JSON](evidence/review003-resume/verify_r003.json)は診断用の未完成試験として保存する。会話中の「7/10」「10/12」「残り2件」等は受入の達成数ではなく、撤回する。次の理由から、このスクリプトのtrueを指摘解消の根拠にしない。

- overflow親の低高スクロールを狭幅パネルで代用し、末尾分類を末尾機能として記録している。
- 同一機能のキーボード再選択ではなく、別ページへの合成クリックや遷移を実施していた。
- 固定キー列の前提となる実フォーカスを待たず、datasetのロード完了も十分に待っていない。
- main配下のセレクターが非表示KeepAlive画面や欠損設定を拾っていた。目的変数・説明変数を正しく設定した証拠がない。
- 入力文字列や本文長のみで結果保持を判定し、解析成功・結果値・計算中状態の保持を測定していない。
- V09の変数・ウェイト・行範囲は表示の存在確認だけで、変更前後の値の一致を測定していない。
- V10は任意の別datasetと先頭のmain本文の比較にとどまり、全NaN列を含むdatasetや分析結果の排除を証明しない。
- 複数試行の出力が同名ファイルへ上書きされており、すべての失敗runを保存できていない。

[最小キー診断](evidence/review003-resume/minimal-key-sequence.json)は通常幅でEscape後の分類復帰とOverviewへの選択後の本文フォーカスを観測したが、再選択・overflowを網羅せず、修正前bundleでの診断にすぎない。

[選択往復診断](evidence/review003-resume/selection-roundtrip-diag.json)は合成クリックによるTable→PCP→TableのIRIS-001保持であり、実ポインタによる受入試験ではない。

previewではvisibilityState=hidden、innerWidth=0、別呼び出しでabout:blankになる状態を観測した。実画面の反復検証を阻害しているが、製品側の不具合を否定する証拠ではない。「製品バグではない」とした先の断定は取り消し、再検証が必要とする。

## 指摘別状態と再開条件

| 指摘 | 現状・残条件 |
|---|---|
| N001-01 | 前報告のCSS修正はREVIEW-003で採用済み。低高の通常幅overflow親で実スクロールを発生させ、葉へ到達する検証は未完了。 |
| N001-02 | 全機能到達、長ラベル、狭幅の末尾機能、幅往復は未完了。 |
| N001-03 | V08〜V11の受入は未完了。分析成功・入力・計算中・結果、中央状態、全NaN datasetを含む比較が必要。 |
| N001-04 | 通常幅Enter再選択後の閉鎖を限定テストで修正。修正後の実Tab、通常幅とoverflowのEscape復帰、同一／異なる機能選択後の本文フォーカスは未確認。 |
| N001-05 | ソース・ビルド・配信ハッシュと修正前後の限定テストログを保存。起動経路の独立ログと初回失敗runの証拠は未完了。 |

V01〜V04は限定テストの範囲で成功。V05〜V11は必須の実画面検証が未完了。V12は通常ビルドとHTTP配信の一致のみ確認し、修正後bundleでの本番実操作は未確認。

再開時は可視タブ・非ゼロ幅を前提条件として記録し、満たさなければ試験を未実施で止める。各ケースは独立のrun IDと出力先を持ち、URL・bundle・入力方法・期待値・実測値を同じrunに残す。表示中ページはdata-tab-pathとdata-tab-activeで限定する。ナビの分類タイトルがaria-controlsで指すメニューの葉を操作し、移動後はpathnameと現在地の両方を検査する。完了条件を緩めて試験を通してはならない。

本報告は部分対応の記録であり、承認依頼の前提である全必須検証は満たしていない。レビュー監視タイマーは未設定。レビュー文書は編集していない。
