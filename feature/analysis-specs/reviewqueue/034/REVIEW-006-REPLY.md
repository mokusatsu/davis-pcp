# Feature 034 再レビュー006 対応報告

日付: 2026-09-14／対象: REVIEW-006.md（G006-01〜11）。

## 修正内容

- G006-01: 効用範囲を下限・上限の独立したInputNumberに変更。編集中の不完全な状態でも入力を進められ、実行時に下限＜上限を検証する（エラー表示＋canRun連動）。
- G006-02: シミュレーション編集表の辞書参照を`result.details.encoding`に修正（configはリクエスト由来でencodingを含まない）。学習水準（catalogの水準配列）のみ候補にし、線形範囲は学習fitMin〜fitMaxを表示。編集表の列は保存済みモデルの属性（simAttributes）から生成し、設定欄の未実行変更から分離。送信時も保存済み属性で型変換する。
- G006-03: 行・予測タブのTableを全件＋antd pagination（50件/頁）に変更。`slice(0,50)`＋pagination=falseを除去。
- G006-04: rankingのresidual未提供を明示（Alert＋図名「残差（提供分のみ）」）。ConjointFigureはy=nullの点を描かない。残差のある点のみY配置し、便宜座標を作らない。
- G006-05: 予測に独立世代（predSequence）を導入し、fitのrunSequenceと分離。開始時のresultIdも照合。dataset変更effectで予測・simulate・expand・保存の各世代を進め、待機状態を明示的に解除。行取得は開始したfit世代にひもづけ（行取得中の予測開始で無効化されない）。保存応答にも独立世代＋開始dataset照合を追加。
- G006-06: ratings選択時にoptOutColのstateを解除し、mappingColumns構築でもratings時はopt-outを除外。表示・canRun・送信を一致させた。
- G006-07: プロフィール追加IDを削除で巻き戻らない連番（使用中IDを避けて採番）に変更。代替案IDを編集可能にし、重複時は赤枠＋警告表示。送信時に重複があればエラーにして送信しない。結果rowKeyはalternativeIdのまま。
- G006-08: 価格候補を登録済み線形属性（linAttrs）に限定。線形属性から外すと価格設定を解除する。
- G006-09: 診断タブを新設。fetchConjointTableでdiagnosticsを取得してTable表示（列・行を動的描画、全件＋50件/頁）。件数・subtablesの説明とCSV導線を維持。
- G006-10: 予測・保存ボタンにstaleのdisabledを接続。行タブの選択ボタンにもstale・rowsReadyのdisabledを接続。保存応答に開始dataset照合を追加（旧応答のキャッシュ更新・コードブック再取得を防止）。
- G006-11: 拡張結果に拡張元条件（mapping・scope・版）を保持し、設定変更時に失効表示（警告＋再実行ボタンなし）。有効時は元件数→拡張後件数（+追加件数）を表示。

## 検証

- FE型検査: tsc -b 成功。本番ビルド: vite build 成功。
- 実ブラウザ: test_conjoint_e2e・test_cj_gui2・test_cj_gui3・test_cj_gui4の計8 passed（8420配信）。
- バックエンド: test_conjoint_api・test_150_conjointの計13 passed。全体回帰443 passed（R依存除く）。
- R照合: survival::clogit係数一致（effect換算0.549306）、CR1手計算一致（SE=0.436436）。sandwichなし。
- 追加修正: WTP応答のdirection ndarray混入による500エラーを修正（wtp_tableでdirectionを除外）。線形属性付きfitの直列化を確認。

## 残作業

実ブラウザでの代表的一連操作の画面証跡の整理、Pyodide対象外の明記、run-production.bat確認は引き続き残作業。
REVIEW-006の11項目は上記の通り完了版で対応した。未検証の受入条件が残るため全体完了扱いにしない。
