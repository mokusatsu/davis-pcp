# Feature 034 再レビュー023

判定: **修正必須・承認保留。B022-01は現在の追加修正でも未解消。**

確認日時: 2026-09-15 14:33 JST。
対象: REVIEW-021-REPLY.md、REVIEW-022.md、RUN_TAG=131936のログ、test_cj_b08i.py、現在の保存処理・KeepAlive・codebook reducer。

## 対象版と採用する証拠

報告対象ConjointPage.tsxのSHA256は `89478e8dd07a4ba309ca4739f46d786547a462fc7ea3432c7e16e0d1567789b4`。
現在の同ファイルは `71F440CA7070A142593AC97A5DDD3280DEF49778DE176570B0BE65BEA0FE352D` であり、報告後の追加修正が存在する。旧版の成功ログを現在版の検証済み証拠には転用しない。

RUN_TAG=131936では、要求遅延後の再読込なし再分析・再保存、応答保持後のA→B→A・C4生成・旧応答解放・旧通知なしまで完走した記録を確認した。この2条件の成功はREVIEW-022の評価を維持する。

## B023-01 [P1] 現在datasetの判定に、unmount済みインスタンスのrefを使っている

対象: `fullstack/frontend/src/features/models/ConjointPage.tsx:717–722`。
関連: `fullstack/frontend/src/app/KeepAliveOutlet.tsx:112`、`fullstack/frontend/src/features/dataset/codebookSlice.ts:275–293`。

追加修正は `selectionRef.current.datasetId === startedDataset` を条件にコードブック取得を制限している。しかしKeepAliveOutletはdatasetIdをkeyとして子を作り直す。Aの旧インスタンスがunmountすると、そのrefは最後のAを保持し、中央の現在datasetであるBを継続して参照しない。したがって、この条件は現在の中央状態を保証しない。

Aで保存応答を保留→Bへ切替→Bに留まって旧応答を解放すると、旧refがAのままの経路では条件が成立し、fetchCodebookThunk(A)がdispatchされる。pending処理はcodebook.datasetIdをAに変更し、Bの列・draft・選択列・hasChangesを初期化する。通知の世代ガードはこのdispatchより後なので防止できない。B022-01は未解消である。

保存完了時に、ライフサイクル終了後も有効な中央storeの現在datasetを判定すること。非表示Aのキャッシュ更新と、表示中Bのコードブック更新を分ける必要がある。

**この修正は実ブラウザで必ず検証すること。** Aの保存を保留し、Bでコードブックの未保存編集・列選択を作成してから、Bに留まったままA応答を解放する。Bのdataset・列・編集内容・選択の維持、およびAへ戻った際の新列・更新版の取得を確認する。A→B→Aの既存試験だけで完了扱いにしてはならない。

## B022-02の追加修正

現在版の724–727行はコードブック取得await後に保存世代・dataset・resultIdを再検査している。事前計算したfresh値を使う問題はソース上で解消した。

ただし、この追加修正を対象としたブラウザ証拠はREVIEW-021-REPLYに含まれない。保存200後のコードブック応答だけを保留し、dataset切替後に解放して、旧成功通知が出ず現在画面の列・結果・待機状態が維持されることを必ず確認する。ソース確認のみで操作検証済みとはしない。

## 検証範囲

対応報告・試験手順・成功ログと、追加修正の呼出先を静的に照合した。今回のブラウザ再実行、ビルド、全体テストは未実施。Pyodide実ブラウザ操作は免除範囲を維持する。

次の対応報告には、検証したソースSHA256、実際に配信したbundle名とSHA256、runを識別できるログを記録すること。REVIEW-021-REPLYの冒頭にはbundle名のみがあり、本文の「bundle hashを特定した」という記載を裏付けていない。

**既存2条件の成功は維持するが、現在版にも共有状態を壊す経路が残るため、問題なしとは判定しない。**
