"""Curated, offline builtin survey data. Catalog reads never load data frames."""
from __future__ import annotations

import copy
import io
import json
import re
import zipfile
from pathlib import Path

import polars as pl

from ..domain.codebook import Codebook
from ..domain.errors import BizError

SAMPLE_ROOT = Path(__file__).resolve().parents[1] / "data" / "builtin_samples"
IRIS_LABELS = {
    "sepal_length_cm": "がく片の長さ（cm）",
    "sepal_width_cm": "がく片の幅（cm）",
    "petal_length_cm": "花弁の長さ（cm）",
    "petal_width_cm": "花弁の幅（cm）",
}
IRIS_LICENSE = 'Fisher, R. (1936). Iris [Dataset]. UCI Machine Learning Repository. https://doi.org/10.24432/C56C76\n出典: https://archive.ics.uci.edu/dataset/53/iris\n\nCreative Commons Attribution 4.0 International (CC BY 4.0)\nhttps://creativecommons.org/licenses/by/4.0/\n原提供者・出典・ライセンスの表示を保持し、変更した旨を表示してください。許諾された利用を制限する追加の法的条件・技術的制限は課していません。\n\nDAVIS-PCPでの変更: 既存の150行を保持。測定値・品種はUCIの訂正版 bezdekIris.data と全行一致（iris.data の35・38行とは異なります）。4測定列はすべてcm。列名をsepal_length_cm等に整理し、日本語説明（がく片の長さ、がく片の幅、花弁の長さ、花弁の幅）を付与。サンプルの表示用ID、並び番号、分類符号はアプリ側の補助情報です。日本語説明の追加によるデータ値の変更なし。\n\nこのサンプルは公開資料から作成した分析操作の学習用データです。母集団の代表標本、公式推計、尺度の妥当性を保証するものではありません。原提供者による本アプリの推奨・承認を意味しません。データとコードブックの許諾はアプリのソフトウェアライセンスと独立します。提供データは無保証です。第三者の権利・プライバシー等は各許諾の範囲外となることがあります。'


def catalog() -> list[dict]:
    manifest = SAMPLE_ROOT / "manifest.json"
    extra = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else []
    if isinstance(extra, dict):
        extra = extra["samples"]
    return [{"id": "iris", "name": "Iris (built-in sample)", "rowCount": 150, "columnCount": 6,
             "sourceUrl": "https://doi.org/10.24432/C56C76", "licenseText": IRIS_LICENSE}, *extra]


def sample_spec(sample_id: str) -> dict:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", sample_id):
        raise BizError("BUILTIN_SAMPLE_NOT_FOUND", "組込みサンプルが見つかりません。", status_code=404)
    for item in catalog():
        if item["id"] == sample_id:
            return item
    raise BizError("BUILTIN_SAMPLE_NOT_FOUND", "組込みサンプルが見つかりません。", status_code=404)


def asset_path(relative: str) -> Path:
    path = (SAMPLE_ROOT / relative).resolve()
    if SAMPLE_ROOT.resolve() not in path.parents or not path.is_file():
        raise BizError("BUILTIN_SAMPLE_ASSET_MISSING", "組込みサンプルのファイルが不完全です。", status_code=500)
    return path


def load_sample(sample_id: str) -> tuple[pl.DataFrame, dict]:
    spec = sample_spec(sample_id)
    if sample_id == "iris":
        from .import_service import build_builtin_iris
        return build_builtin_iris(), {"licenseText": IRIS_LICENSE, "columns": [
            {"name": name, "label": label, "scaleType": "ratio", "role": "attribute"}
            for name, label in IRIS_LABELS.items()
        ]}
    overrides = {name: {"string": pl.String, "float": pl.Float64, "integer": pl.Int64}[kind]
                 for name, kind in spec.get("csvTypes", {}).items()}
    frame = pl.read_csv(asset_path(spec["dataFile"]), infer_schema_length=None,
                        schema_overrides=overrides, null_values=[""])
    template = json.loads(asset_path(spec["codebookFile"]).read_text(encoding="utf-8"))
    template["licenseText"] = spec["licenseText"]
    if frame.height != spec["rowCount"] or frame.width != spec["columnCount"]:
        raise BizError("BUILTIN_SAMPLE_SHAPE", "組込みサンプルの行数・列数が一致しません。", status_code=500)
    return frame, template


def install_codebook(initial: dict, template: dict) -> dict:
    """Map portable name-based references onto the canonical column identities."""
    result = copy.deepcopy(initial)
    current_by_name = {column["name"]: column for column in result["columns"]}
    refs = {name: column["columnId"] for name, column in current_by_name.items()}
    for column in template.get("columns", []):
        if column["name"] not in current_by_name:
            raise ValueError(f"Unknown builtin codebook column: {column['name']}")
        refs[column.get("columnId", column["name"])] = current_by_name[column["name"]]["columnId"]
    for column in template.get("columns", []):
        target = current_by_name[column["name"]]
        target.update({key: value for key, value in column.items() if key not in ("columnId", "name")})
    result["multiResponseGroups"] = copy.deepcopy(template.get("multiResponseGroups", []))
    for group in result["multiResponseGroups"]:
        group["optionOrder"] = [refs[ref] for ref in group.get("optionOrder", [])]
    for key in ("weightConfig", "surveyDesign"):
        config = copy.deepcopy(template.get(key))
        if config:
            for field, value in list(config.items()):
                if field.endswith("ColumnIds"):
                    config[field] = [refs[ref] for ref in value]
                elif field.endswith("ColumnId") and value is not None:
                    config[field] = refs[value]
        result[key] = config
    result["licenseText"] = template.get("licenseText", "")
    result["licenseRevision"] = 1
    return Codebook(**result).model_dump(mode="json")


def sample_package(sample_id: str) -> bytes:
    """Distribute derivative data separately with its codebook and full notices."""
    spec = sample_spec(sample_id)
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("LICENSE-AND-SOURCE.txt", spec["licenseText"])
        archive.writestr("manifest.json", json.dumps(spec, ensure_ascii=False, indent=2))
        if sample_id == "iris":
            frame, template = load_sample(sample_id)
            archive.writestr("iris.csv", frame.write_csv())
            archive.writestr("iris-codebook.json", json.dumps(template, ensure_ascii=False, indent=2))
        else:
            for relative in [spec["dataFile"], spec["codebookFile"], *spec.get("noticeFiles", []), *[spec[key] for key in ("noticeFile", "provenanceFile") if key in spec]]:
                archive.write(asset_path(relative), relative)
    return stream.getvalue()
