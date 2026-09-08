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

- JSONは `columnId` を優先し、一致しなければ `name` で既存列に照合します。どちらか一方が必要です。
- 別データセットへ再利用する辞書は `columnId` を省略し、`name` だけを指定してください。
- 未知の列は読み飛ばされます。新しいデータ列の作成や列名変更は行いません。読込後に更新列数を確認してください。
- 指定した属性だけを更新し、省略した属性と列は保持します。`valueLabels` や配列は属性全体の置換であり、要素単位の追加ではありません。空にするには `{}` または `[]` を指定します。
- JSON読込では値がnullの属性は更新対象になりません。`multiResponseGroup: null` も既存グループを解除しません。解除にはエディタの編集を利用してください。
- `datasetId` と `schemaRevision` はエクスポートに含まれますが、取込先の選択には使いません。読込先は画面で選択中のデータセット／APIのURLで決まります。
- 読込時は取込先の `schemaRevision` が1増え、分析の再計算に使われます。ファイルのリビジョン値を設定する操作ではありません。
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

完全な保存形式は `datasetId`、`schemaRevision`、`columns` を持ち、各列に `columnId` と `name` が含まれます。初期モデルの既定値は、空ラベル、`nominal`、`attribute`、空辞書・空配列、`isReversed: false`、`multiResponseGroup: null` です。実際の新規取込では列型・列名から推定した設定が入るため、読込後に確認してください。部分辞書で省略した属性が、この既定値にリセットされるわけではありません。

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

`categoryOrder` には欠損コードを除いた全水準を重複なく記載してください。観測数0の水準も維持されます。未定義の観測値は追加されるため、完全な順序を明示する方が確実です。

順序尺度の補助平均・中央値は、この順序の1～kの等間隔得点から計算します。Top-2は末尾2水準、Bottom-2は先頭2水準です。`isReversed: true` はPCPの軸方向と順序得点を反転します。数値尺度の逆転は最小値＋最大値－値を使います。データCSVの生値は変更しません。

### 欠損と分母

`missingReasons` だけでは欠損指定になりません。必ず対応するコードを `missingCodes` にも含めます。

- 理由に `非該当` を含む欠損コードは非該当数に分類します。英語表記では `not_applicable` または `skip` を含む理由も同じ分類になります。
- その他の欠損コードとnullは無回答です。理由が省略されている欠損コードも無回答です。
- 全体数 − 非該当数 ＝ 設問対象数、設問対象数 − 無回答数 ＝ 有効回答数です。
- `valueLabels` に `非該当` と表示するだけでは、非該当分類になりません。

## コードブックCSV

データCSVとは別の、1行1変数の辞書CSVです。UTF-8、カンマ区切り、ヘッダー付きで保存します。

```csv
name,label,scaleType,role,valueLabels,categoryOrder,missingCodes,missingReasons,isReversed,multiResponseGroup
gender,性別,nominal,attribute,"{""1"":""男性"",""2"":""女性""}","[""1"",""2""]",[],{},false,
```

JSON辞書・配列のフィールドは、JSON文字列をCSVセルに格納します。CSVの規則に従い、セル内の `"` を `""` にします。`categoryOrder` と `missingCodes` はカンマ区切りのセル値も受け付けますが、JSON配列形式を推奨します。

CSVは `name`（代替名 `columnName`）で照合し、`columnId` では照合しません。空欄は多くの属性で「保持」になります。`multiResponseGroup` は列が存在して空欄なら解除します。`isReversed` は `true`、`1`、`yes` がtrue、それ以外の非空欄がfalseです。`true` / `false` に統一してください。

## 読込・出力とJSON Schema

画面の **コードブック → CSV辞書読込** はCSVとJSONの両方に対応します。コードブック内の **エクスポート → JSON形式** で完全な保存形式を取得できます。

| API | 用途 |
|---|---|
| `GET /api/v1/datasets/{datasetId}/codebook` | 現在のコードブック取得 |
| `POST /api/v1/datasets/{datasetId}/codebook/import` | multipartの `file` にCSV／JSONを指定して読込 |
| `GET /api/v1/datasets/{datasetId}/codebook/export?format=json` | JSON出力 |
| `GET /api/v1/datasets/{datasetId}/codebook/export?format=csv` | 辞書CSV出力 |

[codebook.schema.json](codebook.schema.json)はJSON Schema Draft 2020-12形式です。完全なエクスポートJSON、`columns` 形式の部分辞書、列配列形式を検証できます。

このスキーマは辞書作成時の入力検査用です。アプリの読込APIが自動適用するものではありません。未知のプロパティ、不正な列挙値、nullによる曖昧な更新を防ぐため、取込処理より厳しく検査します。`schemaRevision` は1以上を要求します。列名／列IDの実在、重複する列定義、コードと実データの一致、辞書間の整合性はJSON Schemaだけでは検証できません。

実装の参照先: `fullstack/backend/app/domain/codebook.py`、`domain/codebook_adapter.py`、`api/datasets.py`、`algorithms/summaries/core.py`。
