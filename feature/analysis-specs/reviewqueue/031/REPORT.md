# Feature 031 FAMD 実装報告（レビュー依頼）

## 変更内容・ファイル
- 新規kernel: `fullstack/backend/app/algorithms/models/famd.py`
- 新規API: `fullstack/backend/app/api/famd.py`（POST /api/v1/models/famd）
- 共通基盤（FAMD必須追加のみ）:
  - `domain/analysis_contracts.py`（FAMDRequest、predict文言一般化）
  - `domain/analysis_frame.py`（PreparedFamdFrame、prepare_famd_frame、numpy import）
  - `api/analysis_results.py`（famd分岐、_famd_predict、_famd_materialize、variables export）
  - `main.py`（famd router登録）
  - `analysis_result_store.py` は既存rows/prediction保存を再利用（新規変更なし）
- 画面: `FamdPage.tsx`（/models/famd「混合データ因子分析（FAMD）」）、`FamdFigure.tsx`、`famdTypes.ts`、`famdApi.ts`、main.tsx/KeepAliveOutlet.tsx/AppShell.tsxへ登録（各1行、MCA行と重複なし）
- テスト: `test_120_famd.py`（10件）、`test_121_famd_api.py`（3件）、`frontend/tests/famd.test.tsx`（1件）
- 記録: `tasks/DAVIS-FEAT-031.md`

## 共有基盤への変更
- MCA/CAの既存路は無変更。predict interval文言のみ一般化（MCAテスト18件で回帰確認）。
- 共有FE 3ファイルはMCA+FAMD登録行のみ。MCA専用ファイルは未編集。

## 受入項目別の結果
- FAMD01 達成（全慣性5.0、fixture不均等3水準＋数値2列）
- FAMD02 達成（+1000・×100・符号反転で距離不変）
- FAMD03 達成（水準順逆転で固有値・距離・重心多重集合不変）
- FAMD04 達成（√p分散1-pk、√p(1-p)とは不一致）
- FAMD05 達成（重心直接平均、λV/√p恒等式、λ²規約、CA式不一致を確認）
- FAMD06 達成（変数寄与軸内合計1、relationStrength合計1を要求しない）
- FAMD07 達成（r²・η²が0〜1、η²恒等式）
- FAMD08 達成（fit再射影一致、固定μσpk、未知カテゴリ未計算、外挿警告）
- FAMD09 達成（survey×100不変、frequency複製一致）
- FAMD10 達成（重複・尺度・MA・定数を規定エラー）
- COM-01/07/08/10: materialize冪等・stale拒否・全ページrows/exportで達成（実ブラウザでも保存後stale・FAMD1列を確認）
- COM-05: survey/frequency確認済み、不正重みは共通路
- COM-11: KeepAlive PCP往復で結果保持・dataset切替で設定リセットを確認
- 画面系残り: カテゴリ点の実ポインタclick選択が未達（JS合成clickは有効）。個体矩形の実ポインタ選択は35行で達成

## 実行コマンドと件数
- `python -m pytest fullstack/backend/tests/stats_tests/test_120_famd.py fullstack/backend/tests/stats_tests/test_121_famd_api.py` → 13 passed
- `python -m pytest ... test_110_mca test_111_mca_api test_100_ca` 合計 → 37 passed
- `python -m pytest fullstack/backend/tests/stats_tests/ -k "not r_90 and not test_r_90"` → 421 passed
- `npx --prefix fullstack/frontend vitest run tests/famd.test.tsx tests/mca.test.tsx` → 2 passed
- reference_kernels.famd照合 → 固有値・F・重心・相関・η²差分0

## 実ブラウザ確認結果
- 環境: 独自backend :8421（FAMD含む）＋独自FE :5175（proxy→:8421）。他者サーバ（:8420/:5174）に触れず。
- データ: Iris 150行。数値sepal_width/petal_length＋species。p2 m1 K3 rank4、全慣性4.0、固有値2.332/1.183/0.461/0.024。
- 実行→個体図150・重心図3・相関円（viewBox 340, [-1,1]）・変数関係（r²/η²）・表診断→export 5種→保存FAMD1→stale→KeepAlive PCP往復→dataset切替リセットを確認。
- 実ポインタ矩形選択: padding起点ドラッグで sidebar 35行（達成）。点上開始ドラッグはガードで抑止されるため起点に注意。
- カテゴリ点click: JS合成clickは解決ボタン有効化（1件）を確認。実ポインタclickはbrushガード吸収で未達。
- 証拠: .temp/famd-verify-run.png, famd-verify-corr.png, famd-verify-relation.png, famd-verify-tables.png, famd-verify-brush2.png, famd-verify-keepalive.png, famd-verify-dsswitch.png。

## 未検証事項・残作業
- カテゴリ点の実ポインタclick選択の改善
- FactoMineR oracle比較、static配布確認
- reviewqueue監視タイマーは本セッションでは設定せず、レビュー返答待ち
