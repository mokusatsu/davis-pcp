# Feature 034 再レビュー008 対応報告

日付: 2026-09-14／対象: REVIEW-008.md（G008-01〜05）。

## 修正内容

- G008-01: 効用範囲を下限・上限の独立したnullable値（utilLo/utilHi）として保持し、反対側を補正しない。片側クリアは片側だけ消える。不正な大小は表示＋実行時検証で扱い、canRunにも範囲条件を追加した（報告との不一致を解消）。送信は両側入力かつ下限＜上限のときだけutilityRangeを付与する。
- G008-02: 予測開始時のfit世代・版・モデルを開始値として保持し、応答時にrunSequence.current・selectionRef・schemaRefと比較する（クロージャ同士の比較を廃止）。行取得後・失敗時も同様に確認し、保存元は現在のモデルと一致する場合だけ遷移させる。fit開始時に旧予測を失効させ、待機表示を解除する。予測ボタンはstale・loading中に無効化した。
- G008-03: fit開始時にdiagSequence・diagResultId・diagLoading・diagErrorを初期化し、診断の世代・待機・結果IDをそろえて失効させる。診断の成功・失敗・finallyは要求世代・fit世代・モデルで照合する。dataset変更時も同様に初期化する。
- G008-04: diagnostics exportを空診断と未保存の区別に対応させた。診断0件は空表ではなく理由行（note「診断はありません…」）を返す。旧来の行確率フォールバックは除去した。pooled ratings（total=0→理由行）、固定効果ratings（total=4・respondent_intercept）、choice（total=8・stage/task）の索引件数とexport行数を照合した。
- G008-05: 順位図のツールチップを「行順=i/N（観測順位=…）」に統一し、表示位置と回答順位の混同をなくした。回答順位はobservedを別項目として示す。

## 検証

- FE型検査: tsc -b 成功。本番ビルド: vite build 成功。
- 実ブラウザ: test_conjoint_e2e・test_cj_gui2・test_cj_gui3・test_cj_gui4の計8 passed（8420配信）。
- バックエンド: test_conjoint_api・test_150_conjointの計13 passed。全体回帰443 passed（R依存除く）。
- 追加検証: pooled空診断の理由行、固定効果4件・choice 8件の件数一致、モデル間予測ID流用404（前回実施分）。
- R照合: survival::clogit係数一致、CR1手計算一致（前回実施分）。

## 残作業

実ブラウザでの代表的一連操作の画面証跡の整理、Pyodide対象外の明記、run-production.bat確認は引き続き残作業。
REVIEW-008の5項目は上記の通り完了版で対応した。未検証の受入条件が残るため全体完了扱いにしない。
