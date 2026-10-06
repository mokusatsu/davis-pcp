# DAVIS-PCP コードブック仕様

コードブックは、データCSVの列に質問文、尺度、役割、値ラベル、カテゴリ順序、欠損定義を付与する辞書です。データの生値を置き換えず、表示と分析に適用します。

## JSONの基本形式

新しく辞書を作る場合は、以下のように `columns` 配列に列定義を入れ、`name` をデータCSVの列名に一致させます。ファイルはUTF-8で保存します。BOM付きUTF-8も読込可能です。

```json
{
  "columns": [
    {
      "name": "gender",
      "label": "性別",
      "scaleType": "nominal",
      "role": "attribute",
      "valueLabels": {"1": "男性", "2": "女性"},
      "categoryOrder": ["1", "2"],
      "missingCodes": [],
      "missingReasons": {},
      "isReversed": false,
      "multiResponseGroup": null
    },
    {
      "name": "Q1",
      "label": "総合満足度",
      "scaleType": "ordinal",
      "role": "question",
      "valueLabels": {"1": "不満", "2": "やや不満", "3": "普通", "4": "満足", "5": "大変満足", "98": "非該当", "99": "無回答"},
      "categoryOrder": ["1", "2", "3", "4", "5"],
      "missingCodes": ["98", "99"],
      "missingReasons": {"98": "非該当", "99": "無回答"},
      "isReversed": false,
      "multiResponseGroup": null
    }
  ]
}
```

この例は[csv-spec.md](csv-spec.md)のCSVに適用できます。辞書に列を含めなかった `respondent_id` と `comment` の設定は保持されます。

## 列の照合と読込動作

- JSONは `name` が指定されていれば、その名前で既存列に照合します。名前が一致しなくても `columnId` にフォールバックしません。`name` を省略した場合だけ、取込先の `columnId` で照合します。どちらか一方が必要です。
- 手書きの部分辞書は `name` だけで指定できます。別データセットのエクスポートJSONを再利用する場合は、`name` と出力元の `columnId` を保持してください。列名による対応付けを使い、MA選択肢順・重み・調査設計内の出力元IDを取込先のIDに解決します。
- 重複する出力元の列名または列IDはエラーです。MA・重み・調査設計内の列参照が解決できない場合も読込全体がエラーになり、保存されません。
- 未知の列は読み飛ばされます。新しいデータ列の作成や列名変更は行いません。読込後に更新列数を確認してください。
- 指定した属性だけを更新し、省略した属性と列は保持します。`valueLabels` や配列は属性全体の置換であり、要素単位の追加ではありません。空にするには `{}` または `[]` を指定します。
- 列の `multiResponseGroup: null` または空文字列は既存グループへの所属を解除します。他の列属性のnullは更新されませんが、このスキーマでは曖昧な入力を避けるため許可しません。ラベルの消去には空文字列、辞書・配列の消去には `{}` / `[]` を使います（順序尺度では空のカテゴリ順が補完される場合があります）。
- `datasetId`、`schemaRevision`、`licenseRevision` は出力元の情報です。読込先は画面で選択中のデータセット／APIのURLで決まり、取込先のID・リビジョンをファイルの値で上書きしません。
- 列・設問定義を含む通常の読込は取込先の `schemaRevision` を1増やし、分析の再計算に使われます。`licenseText` を含めると `licenseRevision` も1増えます。同じ内容の再読込でも増えるため、リビジョンの巻き戻しには使えません。ライセンスだけの読込は `schemaRevision` を変更しません。
- JSON配列だけの形式も読込可能ですが、辞書作成には `{"columns": [...]}` を推奨します。

## フィールド定義

| フィールド | 型 | 意味 |
|---|---|---|
| `columnId` | string | アプリが発行した列ID。エクスポートした同じデータセットの編集では保持 |
| `name` | string | データの列名。大文字・小文字や空白も含めて一致させる |
| `label` | string | 質問文または変数の表示名 |
| `scaleType` | string | 下表の尺度 |
| `role` | string | 下表の役割 |
| `valueLabels` | object | コード文字列をキー、表示ラベル文字列を値とする辞書 |
| `categoryOrder` | string[] | 有効カテゴリのコードを意味上の順序で並べる |
| `missingCodes` | string[] | 分析から除外するコード |
| `missingReasons` | object | 欠損コード文字列をキー、理由文字列を値とする辞書 |
| `isReversed` | boolean | trueで逆転項目として扱う |
| `multiResponseGroup` | string / null | 複数回答設問の列を関連付けるグループ名。指定だけで列結合や複数回答集計が自動実行されるわけではない |
| `multiResponseOptionLabel` | string | 複数回答設問の子列の選択肢ラベル |

保存済みJSONには `datasetId`、`schemaRevision`、`licenseText`、`licenseRevision`、`columns` が入り、各列に `columnId` と `name` が含まれます。MA親設問、重み設定、調査設計も保存されていれば出力します。初期モデルの既定値は、空ラベル、`nominal`、`attribute`、空辞書・空配列、`isReversed: false`、`multiResponseGroup: null`、`multiResponseOptionLabel: ""` です。実際の新規取込では列型・列名から推定した設定が入るため、読込後に確認してください。部分辞書で省略した属性が、この既定値にリセットされるわけではありません。

### データセット単位のJSONフィールド

| フィールド | 型 | 読込動作 |
|---|---|---|
| `licenseText` | string | 出典・ライセンス本文。省略は保持、空文字列は消去。`{"licenseText": "出典とライセンス"}` だけでも読込可能 |
| `multiResponseGroups` | object[] | 下表の親設問を `groupId` で追加・更新。省略・空配列で既存の親設問を一括削除しない |
| `weightConfig` | object / null | `weightColumnId` と `weightType`（`survey` / `frequency`）が必須。省略は保持、nullは解除 |
| `surveyDesign` | object / null | `weightColumnId`、`strataColumnId`、`psuColumnId`、`fpcColumnId` は列参照またはnull。`replicateWeightColumnIds` は重複のない列参照配列。省略は保持、nullは解除 |

列参照には、列照合で対応付けた出力元ID、取込先の列ID、列名を使えます。出力元IDの対応付けは、取込先で偶然同じID・名前が見つかる場合にも優先します。調査設計の `weightColumnId` が省略またはnullなら `weightConfig` の列を使います。最終的に重み列が必要で、両方に指定する場合は同じ列でなければなりません。重み列を層・PSU・FPC列にも指定することはできません。

重み列または `weightType` を変更して `surveyDesign` を再指定しない場合、既存の調査設計は解除されます。重み・調査設計を変更する部分辞書にも、照合できる列定義（例: `"columns": [{"name": "weight"}]`）を含めてください。読込には、照合できる列、空でない親設問配列、または `licenseText` のいずれかが必要です。

| MA親設問のフィールド | 型・既定値 | 意味 |
|---|---|---|
| `groupId` | 空でないstring、必須 | 子列の `multiResponseGroup` と対応するID |
| `label` | string、必須 | 親設問のラベル。空ならgroupIdを使用 |
| `selectedCodes` | string[]、既定 `["1"]` | 選択コード。空・重複不可 |
| `unselectedCodes` | string[]、既定 `["0"]` | 非選択コード。空・重複不可、選択コードと重複不可 |
| `allUnselectedMeaning` | `valid` / `missing` / `notApplicable`、既定 `valid` | 全選択肢が非選択のときの意味 |
| `maxSelections` | 正のinteger / null、既定null | 選択数の上限 |
| `optionOrder` | string[]、既定 `[]` | 子列の参照を表示順に並べる。空の場合は列順から補完 |
| `optionOrderNames` | string[]、読込専用 | 取込先の列名で順序を指定。`optionOrder` と同時指定不可 |

親設問は所属する子列を必要とします。親設問を指定するとその定義を追加・更新し、省略した親設問内の属性には上表の既定値が使われます。コード・子列・順序の整合性は読込時に検証されます。

JSONは指定項目を反映する更新形式です。ファイルにない列・属性・親設問の一括削除や、過去の保存状態への完全な置換を意味しません。

### 尺度と役割

| `scaleType` | 尺度 | 例 |
|---|---|---|
| `nominal` | 名義尺度。コードの大小に意味を持たせない | 性別、地域 |
| `ordinal` | 順序尺度。`categoryOrder` が得点順を決める | 満足度5件法 |
| `interval` | 間隔尺度 | 摂氏温度 |
| `ratio` | 比例尺度 | 年齢、購入金額 |
| `text` | 自由記述 | コメント |
| `id` | 識別子 | 回答者番号 |

| `role` | 用途 |
|---|---|
| `question` | マイニングの評価対象となる設問 |
| `attribute` | マイニングの条件候補となる属性 |
| `weight` | 重み列を示すメタデータ。設定だけで全分析が加重集計になるわけではない |
| `id` | 識別子。内部行IDの指定とは別 |
| `other` | その他 |

`numeric`、`categorical`、`numeric_axis` はこのコードブックの尺度・役割の値ではありません。

### コード、順序、逆転

コードはJSON内では文字列で記述します。たとえば `[1, 2]` ではなく `["1", "2"]` とします。数値データの `1.0` はコード `"1"` と照合しますが、文字列 `"01"` は `"1"` と区別します。未定義ラベルは生コードで表示されます。

`categoryOrder` には欠損コードを除いた全水準を重複なく記載してください。観測数0の水準も維持されます。空でない `categoryOrder` は有効な値の範囲を確定します。そこにない観測値は無効値として数え、分析値・有効回答数・逆転得点から除外します。データCSVの生値は変更しません。`categoryOrder` が未設定の場合は、値ラベルと観測値からカテゴリを補います。ラベルだけを付けても有効な値の範囲は限定されません。

順序尺度の補助平均・中央値は、この順序の1～kの等間隔得点から計算します。Top-2は末尾2水準、Bottom-2は先頭2水準です。`isReversed: true` はPCPの軸方向と順序得点を反転します。数値尺度の逆転は最小値＋最大値－値を使います。データCSVの生値は変更しません。

### 欠損と分母

`missingReasons` だけでは欠損指定になりません。必ず対応するコードを `missingCodes` にも含めます。

- 理由に `非該当` を含む欠損コードは非該当数に分類します。英語表記では `not_applicable` または `skip` を含む理由も同じ分類になります。
- その他の欠損コードとnullは無回答です。理由が省略されている欠損コードも無回答です。
- 全体数 − 非該当数 ＝ 設問対象数、設問対象数 − 無回答数 − 無効値数 ＝ 有効回答数です。
- `valueLabels` に `非該当` と表示するだけでは、非該当分類になりません。

## コードブックCSV

データCSVとは別の辞書CSVです。UTF-8、カンマ区切り、ヘッダー付きで保存します。エクスポートにはライセンス用の `recordType=dataset` レコードが1件、その後に変数ごとの `recordType=column` レコードが入ります。ヘッダーの順序は次のとおりです。

`name,label,scaleType,role,valueLabels,categoryOrder,missingCodes,missingReasons,isReversed,multiResponseGroup,multiResponseOptionLabel,recordType,licenseText`

列設定だけを作成する場合、不要なヘッダーは省略できます。`recordType` の省略・空欄は `column` として扱います。

```csv
name,label,scaleType,role,valueLabels,categoryOrder,missingCodes,missingReasons,isReversed,multiResponseGroup
gender,性別,nominal,attribute,"{""1"":""男性"",""2"":""女性""}","[""1"",""2""]",[],{},false,
```

JSON辞書・配列のフィールドは、JSON文字列をCSVセルに格納します。CSVの規則に従い、セル内の `"` を `""` にします。`categoryOrder` と `missingCodes` もJSON配列が必要です。単なるカンマ区切りのセル値は受け付けません。

CSVは正確な `name` で照合し、`columnName` や `columnId` では照合しません。空欄は多くの属性で「保持」になります。`multiResponseGroup` はヘッダーが存在して空欄なら所属を解除します。`isReversed` は大文字・小文字を区別せず `true` / `1` / `yes` がtrue、`false` / `0` / `no` がfalseです。他の非空欄値はエラーになるため、`true` / `false` に統一してください。

`recordType=dataset` は最大1件で、`name` を空欄、`licenseText` に本文を指定します。本文の空欄は消去、datasetレコード自体の省略は保持です。改行・カンマ・引用符を含むライセンスはCSVの引用符で囲みます。レコード数は改行数と一致するとは限りません。

CSVは列定義とライセンスの交換用です。MA子列の所属・選択肢ラベルは含みますが、MA親設問の設定、データセットの重み設定、調査設計は含みません。列の `role: weight` だけでは重み種別・使用する重み列を再現できません。これらも引き継ぐにはJSONを選んでください。また、出力時に空の辞書・配列・ラベルはCSVでは空欄になり、読込時に既存値を保持するため、空値の消去を含む更新にもJSONを使います。

## 読込・出力とJSON Schema

画面の **コードブック → CSV辞書読込** はCSVとJSONの両方に対応します。コードブック内の **エクスポート** は保存済みの設定を出力し、未保存の編集は含みません。**JSON形式** にはMA親設問・重み・調査設計を含む対応メタデータが入ります。

ファイルの選択だけでは検証・保存されません。**インポート実行** を押すと検証後すぐに選択中のデータセットへ保存され、外側の **保存** は不要です。実行後に外側の **キャンセル** を押しても取り消せず、データ操作のUndoでインポートを元に戻すこともできません。未保存の編集は別に保持されるため、インポート前に整理してください。残った編集を後から **保存** すると、インポートした設定を上書きする場合があります。

| API | 用途 |
|---|---|
| `GET /api/v1/datasets/{datasetId}/codebook` | 現在のコードブック取得 |
| `POST /api/v1/datasets/{datasetId}/codebook/import` | multipartの `file` にCSV／JSONを指定して読込 |
| `GET /api/v1/datasets/{datasetId}/codebook/export?format=json` | JSON出力 |
| `GET /api/v1/datasets/{datasetId}/codebook/export?format=csv` | 辞書CSV出力 |

[codebook.schema.json](codebook.schema.json)はJSON Schema Draft 2020-12形式です。エクスポートJSON、`columns` 形式の部分辞書、列配列形式、ライセンスだけの形式、MA親設問の定義を検証できます。

このスキーマは辞書作成時の入力検査用です。アプリの読込APIが自動適用するものではありません。未知のプロパティ、不正な列挙値、解除に使わないnullによる曖昧な更新を防ぐため、取込処理より厳しく検査します。`schemaRevision` と `licenseRevision` は1以上を要求します。列名／列IDの実在、重複する列定義、コードと実データの一致、選択・非選択コードの重複、辞書間の整合性はJSON Schemaだけでは検証できません。スキーマを通っても、照合できる列や親設問・ライセンス更新がなければ読込はエラーになります。

実装の参照先: `fullstack/backend/app/domain/codebook.py`、`domain/codebook_adapter.py`、`api/datasets.py`、`algorithms/summaries/core.py`。
