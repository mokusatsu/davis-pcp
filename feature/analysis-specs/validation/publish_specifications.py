"""Publish the fixed specification collection using Node.js and marked.

Uses the installed Codex runtime by default; --node and --marked allow another
installation. Source Markdown is authoritative. No application build is run.
"""
from __future__ import annotations

import argparse
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
DOCUMENTS = [
    "README.md",
    "feature/00_common_analysis_contract.md",
    "tasks/DAVIS-FEAT-029-034-COMMON-DESIGN.md",
]
for number, slug in [
    ("29", "correspondence_analysis"),
    ("30", "multiple_correspondence_analysis"),
    ("31", "famd"),
    ("32", "multiple_linear_regression"),
    ("33", "maximum_likelihood_factor_analysis"),
    ("33b", "exploratory_factor_analysis"),
    ("33c", "confirmatory_factor_analysis"),
    ("34", "conjoint_analysis"),
]:
    DOCUMENTS.extend([
        f"feature/{number}_{slug}.md",
        f"tasks/DAVIS-FEAT-{number.upper().zfill(3) if number.isdigit() else '0' + number.upper()}-DESIGN.md",
    ])
DOCUMENTS.extend([
    "contracts/RESULT_CONTRACT.md",
    "contracts/FACTOR_EXTENSIONS_CONTRACT.md",
    "tasks/ACCEPTANCE_AND_HANDOFF.md",
    "tasks/FACTOR_EXTENSIONS_ACCEPTANCE.md",
    "references/source_audit.md",
    "references/FACTOR_EXTENSIONS_SOURCE_AUDIT.md",
    "references/PRIMARY_SOURCES.md",
    "references/FACTOR_EXTENSIONS_SOURCES.md",
    "fixtures/README.md",
    "fixtures/FACTOR_EXTENSIONS_FIXTURES.md",
    "validation/VALIDATION_REPORT.md",
    "validation/FACTOR_EXTENSIONS_VALIDATION.md",
])


def rebase_links(body: str, source: Path) -> str:
    def replace(match: re.Match) -> str:
        target = match.group(2)
        if urlsplit(target).scheme:
            return match.group(0)
        path, marker, fragment = target.partition("#")
        absolute = source.parent / unquote(path) if path else source
        relative = Path(os.path.relpath(absolute, ROOT)).as_posix()
        return f"{match.group(1)}({relative}{marker}{fragment})"
    return re.sub(r"(\[[^\]\n]*\])\(([^)\n]+)\)", replace, body)


class LinkCheck(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: list[str] = []
        self.hrefs: list[str] = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        if tag == "a" and "href" in attrs:
            self.hrefs.append(attrs["href"])


def main() -> None:
    runtime = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", type=Path, default=runtime / "bin/node.exe")
    parser.add_argument("--marked", type=Path, default=runtime / "node_modules/marked/lib/marked.esm.js")
    args = parser.parse_args()
    contents, titles = [], []
    for name in DOCUMENTS:
        source = ROOT / name
        body = source.read_text(encoding="utf-8")
        titles.append(re.search(r"^# (.+)$", body, re.MULTILINE).group(1))
        contents.append(rebase_links(body, source))
    js = """
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const {marked} = await import(pathToFileURL(process.argv[1]).href);
const docs = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(docs.map(body => marked.parse(body, {gfm:true}))));
"""
    rendered = json.loads(subprocess.run(
        [str(args.node), "--input-type=module", "-e", js, str(args.marked)],
        input=json.dumps(contents, ensure_ascii=False), capture_output=True,
        text=True, encoding="utf-8", check=True,
    ).stdout)
    old_html = (ROOT / "index.html").read_text(encoding="utf-8")
    style = re.search(r"<style>(.*?)</style>", old_html, re.DOTALL).group(1)
    toc, sections, joined = [], [], []
    for i, (name, title, body, markup) in enumerate(zip(DOCUMENTS, titles, contents, rendered), 1):
        toc.append(f'<a href="#doc-{i}">{html.escape(title)}</a>')
        sections.append(f'<section id="doc-{i}"><div class="filepath"><a href="{name}">{name}</a></div>{markup}</section>')
        joined.append(f'---\n\n<a id="doc-{i}"></a>\n\n出典ファイル：[{name}]({name})\n\n{body}')
    output = (
        '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f'<title>DAVIS-PCP 追加分析設計｜EFA・CFA拡張</title><style>{style}</style></head><body>'
        '<header><h1>DAVIS-PCP｜追加分析機能設計</h1>'
        '<p>CA・MCA・FAMD・重回帰・ML因子分析・EFA・CFA・コンジョイント分析<br>'
        '033b・033c追加版 · 2026-09-13／機能仕様・詳細設計・契約・受入条件・検証記録</p></header>'
        '<div class="layout"><nav aria-label="文書目次">' + ''.join(toc) + '</nav><main>'
        + ''.join(sections) + '</main></div></body></html>'
    )
    check = LinkCheck()
    check.feed(output)
    if len(check.ids) != len(set(check.ids)):
        raise ValueError("Duplicate HTML IDs")
    local_links = 0
    for href in check.hrefs:
        parts = urlsplit(href)
        if parts.scheme:
            continue
        if not parts.path:
            if parts.fragment not in check.ids:
                raise ValueError(f"Missing HTML anchor: {href}")
        elif not (ROOT / unquote(parts.path)).exists():
            raise ValueError(f"Missing local target: {href}")
        local_links += 1
    (ROOT / "index.html").write_text(output + "\n", encoding="utf-8")
    (ROOT / "ALL_SPECIFICATIONS.md").write_text(
        '# DAVIS-PCP追加分析仕様・実装設計：一括閲覧版\n\n'
        '更新日：2026-09-13。正本は各分割ファイル。033b EFA・033c CFAを含む。\n\n'
        + '\n\n'.join(joined), encoding="utf-8",
    )
    print(json.dumps({"documents": len(DOCUMENTS), "html_ids": len(check.ids),
                      "local_links_checked": local_links, "missing_targets": 0}))


if __name__ == "__main__":
    main()
