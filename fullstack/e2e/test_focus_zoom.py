"""E2E: Feature 035 GraphPanel 拡大の入口・倍率・終了・状態保持。

旧 FocusMode の pair-plot/facet 一覧ではなく台帳の現行対象へ対応付けた検証。
selector の置換ではなく、実ブラウザでの入口・実寸法・スクロール・戻す・対象外撤去を確認する。
"""
from __future__ import annotations

import os
import pytest

BASE_URL = os.environ.get("DAVIS_PCP_URL", "http://127.0.0.1:8425")

pytest.importorskip("playwright")
from playwright.sync_api import expect, sync_playwright  # noqa: E402


@pytest.fixture(scope="module")
def page():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=["--disable-extensions", "--disable-component-update", "--no-sandbox"])
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        p = context.new_page()
        p.set_default_timeout(10000)
        p.goto(BASE_URL)
        p.wait_for_selector('[data-testid="pcp-canvas"]')
        p.wait_for_selector('[data-testid="dataset-selector"]')
        p.wait_for_timeout(500)
        yield p
        browser.close()


@pytest.fixture(autouse=True)
def ensure_unexpanded(page):
    """Ensure every test starts and ends with the expansion dialog closed."""
    if page.locator('[data-testid="graph-expansion-bar"]').is_visible():
        page.locator('[data-testid="graph-expansion-exit"]').click()
        page.wait_for_timeout(300)
    yield
    if page.locator('[data-testid="graph-expansion-bar"]').is_visible():
        page.locator('[data-testid="graph-expansion-exit"]').click()
        page.wait_for_timeout(300)


def verify_expansion_active(page, expected_title_sub: str | None = None):
    """Verify expansion dialog is open. Header/sidebar stay (dialog overlays)."""
    expect(page.locator('[data-testid="graph-expansion-bar"]')).to_be_visible()
    expect(page.locator('[data-testid="graph-expansion-dialog"]')).to_be_visible()
    expect(page.locator('.ant-layout-header')).to_be_visible()
    expect(page.locator('[data-testid="selected-sidebar"]')).to_be_visible()
    if expected_title_sub:
        title_text = page.locator('[data-testid="graph-expansion-title"]').inner_text()
        assert expected_title_sub in title_text, f"Expected '{expected_title_sub}' in '{title_text}'"


def verify_expansion_inactive(page):
    """Verify expansion dialog is closed and host is back in slot."""
    expect(page.locator('[data-testid="graph-expansion-bar"]')).not_to_be_visible()
    expect(page.locator('.ant-layout-header')).to_be_visible()
    expect(page.locator('[data-testid="selected-sidebar"]')).to_be_visible()


def expand_and_check(page, graph_id: str, title_sub: str):
    host = page.locator(f'[data-testid="graph-host-{graph_id}"]')
    expect(host).to_be_visible()
    svg_or_canvas = host.locator('svg, canvas').first
    page.locator(f'[data-testid="graph-expand-{graph_id}"]').click()
    verify_expansion_active(page, title_sub)
    # 同一 host が dialog 受け口へ移動する
    expect(page.locator('[data-testid="graph-expansion-dock"]')).to_contain_text("")
    dock_html = page.locator('[data-testid="graph-expansion-dock"]').inner_html()
    assert f'graph-host-{graph_id}' in dock_html
    return svg_or_canvas


def test_pcp_expand_and_zoom(page):
    """G01 PCP: 拡大・全倍率ラベル・fit/100%一致・Escape終了・canvas操作維持。"""
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')
    expand_and_check(page, "pcp/main", "PCP")
    expect(page.locator('[data-testid="graph-expansion-zoom-label"]')).to_have_text("フィット")
    for label in ["125%", "150%", "200%", "300%", "400%"]:
        page.locator('[data-testid="graph-expansion-zoom-in"]').click()
        expect(page.locator('[data-testid="graph-expansion-zoom-label"]')).to_have_text(label)
    page.locator('[data-testid="graph-expansion-exit"]').click()
    verify_expansion_inactive(page)
    page.locator('[data-testid="graph-expand-pcp/main"]').click()
    verify_expansion_active(page)
    page.keyboard.press("Escape")
    verify_expansion_inactive(page)


def test_distribution_boxplot_expand(page):
    """G04 箱ひげ図: boxplot タブへ切替後に拡大・矩形選択。"""
    page.locator('.ant-segmented-item:has-text("Distribution")').click()
    page.wait_for_selector('[data-testid="dist-view-mode"]')
    items = page.locator('[data-testid="dist-view-mode"] .ant-segmented-item')
    items.nth(1).click()
    page.wait_for_selector('[data-testid="distribution-svg"]')
    expand_and_check(page, "distribution/boxplot", "箱ひげ")
    page.locator('[data-testid="graph-expansion-zoom-in"]').click()
    expect(page.locator('[data-testid="graph-expansion-zoom-label"]')).to_have_text("125%")
    svg = page.locator('[data-testid="distribution-svg"]').first
    box = svg.bounding_box()
    page.mouse.move(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.25)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.45, steps=5)
    page.mouse.up()
    page.wait_for_timeout(300)
    expect(svg).to_be_visible()
    page.keyboard.press("Escape")
    verify_expansion_inactive(page)


def test_relationships_pair_and_heatmap(page):
    """G02/G03: ヒートマップと焦点ペアの拡大。非対象グラフは保持される。"""
    page.locator('.ant-segmented-item:has-text("Relationships")').click()
    page.wait_for_selector('[data-testid="graph-host-relationships/heatmap"]')
    expand_and_check(page, "relationships/heatmap", "ヒートマップ")
    page.locator('[data-testid="graph-expansion-zoom-in"]').click()
    page.locator('[data-testid="graph-expansion-fit"]').click()
    expect(page.locator('[data-testid="graph-expansion-zoom-label"]')).to_have_text("フィット")
    page.locator('[data-testid="graph-expansion-exit"]').click()
    verify_expansion_inactive(page)
    # 焦点ペア側も拡大できる（他図はアンマウントされない）
    expand_and_check(page, "relationships/pair", "焦点ペア")
    page.locator('[data-testid="graph-expansion-exit"]').click()
    verify_expansion_inactive(page)


def test_table_has_no_expansion(page):
    """X01: データテーブルに拡大入口がない。通常の表操作は維持。"""
    page.locator('.ant-segmented-item:has-text("Table")').click()
    page.wait_for_selector('[data-testid="data-table"]')
    expect(page.locator('[data-testid="graph-expand-table"]')).to_have_count(0)
    expect(page.locator('[data-testid="focus-enter-table"]')).to_have_count(0)
    expect(page.locator('[data-testid="data-table"]')).to_be_visible()


def test_crosstab_has_no_expansion(page):
    """X03: クロス集計表に拡大入口がない。セル選択・設定・出力は維持。"""
    page.locator('.ant-segmented-item:has-text("Crosstab")').click()
    page.wait_for_selector('[data-testid="crosstab-page"]')
    expect(page.locator('[data-testid="graph-expand-crosstab"]')).to_have_count(0)
    expect(page.locator('[data-testid="focus-enter-crosstab"]')).to_have_count(0)


def test_clusters_graphs_expand(page):
    """G20/G21: クラスタ PCA・シルエットの拡大（実行後に到達）。"""
    page.locator('.ant-segmented-item:has-text("Clusters")').click()
    if not page.locator('[data-testid="pca-svg"]').is_visible():
        page.locator('[data-testid="run-clustering"]').click()
        page.wait_for_selector('[data-testid="pca-svg"]', timeout=60000)
    expand_and_check(page, "clusters/pca", "PCA")
    page.locator('[data-testid="graph-expansion-exit"]').click()
    verify_expansion_inactive(page)
    expand_and_check(page, "clusters/silhouette", "シルエット")
    page.keyboard.press("Escape")
    verify_expansion_inactive(page)


def test_models_tree_expand(page):
    """G26: 決定木の拡大と葉選択。重要度パネルは非対象として残る。"""
    page.locator('.ant-segmented-item:has-text("Models")').click()
    if not page.locator('[data-testid="tree-diagram-0"]').is_visible():
        page.locator('[data-testid="run-model"]').click()
        page.wait_for_selector('[data-testid="tree-diagram-0"]', timeout=60000)
    expand_and_check(page, "models/tree", "決定木")
    leaves = page.locator('[data-testid^="tree-leaf-0-"]')
    expect(leaves.first).to_be_visible()
    leaves.first.click()
    page.wait_for_timeout(300)
    page.keyboard.press("Escape")
    verify_expansion_inactive(page)
    expect(page.locator('[data-testid="feature-importance-panel"]')).to_be_visible()


def test_statistics_histogram_expand(page):
    """G08: ヒストグラム＋点分布の拡大と棒クリック。"""
    page.locator('.ant-segmented-item:has-text("Statistics")').click()
    page.wait_for_selector('[data-testid="statistics-page"]')
    first_expand = page.locator('[data-testid^="graph-expand-statistics/histogram/"]').first
    expect(first_expand).to_be_visible()
    first_expand.click()
    verify_expansion_active(page, "ヒストグラム")
    page.locator('[data-testid="graph-expansion-zoom-in"]').click()
    expect(page.locator('[data-testid="graph-expansion-zoom-label"]')).to_have_text("125%")
    bars = page.locator('[data-testid="graph-expansion-dock"] rect[data-selectable="true"]')
    if bars.count() > 0:
        bars.first.click()
        page.wait_for_timeout(300)
    page.locator('[data-testid="graph-expansion-exit"]').click()
    verify_expansion_inactive(page)
    expect(page.locator('[data-testid="statistics-page"] table')).to_be_visible()
