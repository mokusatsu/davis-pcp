# 原典反映: DAVIS-PCP仕様確定差分

この文書は `davis.pdf`（2002原論文）と `LINE MOSAIC PLOT.pdf`（2004）を読み込んだ結果、既存のDAVIS-PCP調査で「確定したもの」「訂正するもの」「後期仕様へ移すもの」をまとめる。

## A. 2002初版で確定

### PCP

- Horizontal / Vertical
- database arrangement
- component method arrangement
- permutation arrangement
- PCPはIrisのclassのようなカテゴリ変数も軸表示している
- clustering/group colorがPCPへ即時伝播
- brushingによるselected groupがPCPへ即時伝播

### 共通interaction

- mouse brushingで選択
- selected pointは赤
- selected / non-selected の2群化
- selected状態でright click
- Focus / Delete / Identify
- 他のopened toolsへ即時propagation

### data layer

- file load
- ASCII paste
- variable selection
- observation subset
- simple random sampling
- table sort

### shared visualization UI

- Print（PDF出力）
- High Quality

## B. 既存記述を訂正

### Boxplot / Histogramからのbrush

2002初版では未実装。

両者は他plotで生じたgroupingを受信して表示できるが、selection originにはなれない。

したがって「全plotで完全対称なlinked brushing」という理解は誤り。

DAVISのlinkingは共通データ状態を共有するが、各viewが持つinteraction capabilityは非対称である。

この点は現代版のView Capability設計でも明示すべき。

例:

- `canInitiateSelection`
- `canDisplaySelection`
- `canDisplayGroups`
- `canFocus`
- `canIdentify`

をviewごとに宣言する。

## C. 2002初版と後期版を分離

### Jitter

2002原論文には見当たらない。

後期発表資料で確認されるため「DAVIS後期仕様」とする。

### Line Mosaic Plot

2004年にはDAVISへ実装済み。

PCP-first MVPには入れないが、full DAVIS cloneの後続plotとして登録する。

## D. ソース回収方針を強化

2002原論文に:

`the source is available to the public`

と明記されている。

従ってソース探索は「存在したか不明」ではなく「当時公開されていた公開物の所在を復元する」作業と定義し直す。

Wayback探索候補:

1. `/~myhuh/softwares/Davis.html`
2. `/~myhuh/software/DAVIS/`
3. `/~myhuh/davis.html`
4. `/myhuh/DAVIS.html`
5. 各path配下の `.java`, `.jar`, `.zip`, `.class`, `.jnlp`

## E. PCP設計時の証拠レベル

設計文書では全仕様に以下のラベルを付ける。

- `DAVIS-2002-CONFIRMED`: 原論文本文・図で確認
- `DAVIS-LATER-CONFIRMED`: 2003-2005資料で確認
- `INFERRED`: 複数資料から妥当だが直接記述なし
- `MODERN-ADDITION`: 現代版として追加

特に軸brush、drag reorder、log scale、WebGL等は `MODERN-ADDITION` とし、オリジナルDAVIS由来と混同しない。

