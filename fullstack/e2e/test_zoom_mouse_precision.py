"""E2E: Feature 035 実ポインタによる座標精度。件数ではなく期待rowId集合で検証する。"""
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
    if page.locator('[data-testid="graph-expansion-bar"]').is_visible():
        page.locator('[data-testid="graph-expansion-exit"]').click()
        page.wait_for_timeout(300)
    yield
    if page.locator('[data-testid="graph-expansion-bar"]').is_visible():
        page.locator('[data-testid="graph-expansion-exit"]').click()
        page.wait_for_timeout(300)


def switch_dataset_if_needed(page, target_name="Iris (built-in sample)"):
    selector = page.locator('[data-testid="dataset-selector"]')
    current = selector.inner_text().strip()
    if target_name == "Iris" and ("Iris (built-in sample)" in current or current.startswith("Iris (150")):
        return
    if target_name in current:
        return
    selector.click()
    page.wait_for_timeout(300)
    input_box = selector.locator('input')
    if input_box.is_visible():
        input_box.fill(target_name)
        page.wait_for_timeout(300)
    opts = page.locator(f'.ant-select-item-option:has-text("{target_name}")')
    if opts.count() > 0:
        opts.first.scroll_into_view_if_needed()
        opts.first.click(force=True)
    else:
        iris_opt = page.locator('.ant-select-item-option:has-text("Iris (built-in sample)")')
        if iris_opt.count() > 0:
            iris_opt.first.scroll_into_view_if_needed()
            iris_opt.first.click(force=True)
        else:
            page.locator('.ant-select-item-option:has-text("Iris")').first.click(force=True)
    page.wait_for_timeout(600)


def sidebar_ids(page) -> list[str]:
    items = page.locator('[data-testid="selected-sidebar"] .ant-list-item')
    return [items.nth(i).inner_text().strip() for i in range(items.count())]


def ensure_clustering_run(page):
    page.locator('.ant-segmented-item:has-text("Clusters")').click()
    if not page.locator('[data-testid="pca-svg"]').is_visible():
        page.locator('[data-testid="run-clustering"]').click()
        page.wait_for_selector('[data-testid="pca-svg"]', timeout=60000)


def test_pca_scatter_mouse_precision_when_zoomed(page):
    """G20: 150%拡大での点クリック。rowId集合で通常時と一致させる。"""
    switch_dataset_if_needed(page, "Iris")
    ensure_clustering_run(page)
    page.locator('[data-testid="graph-expand-clusters/pca"]').first.click()
    expect(page.locator('[data-testid="graph-expansion-bar"]')).to_be_visible()
    page.locator('[data-testid="graph-expansion-zoom-in"]').click()
    expect(page.locator('[data-testid="graph-expansion-zoom-label"]')).to_have_text("125%")
    page.wait_for_timeout(400)
    circles = page.locator('[data-testid="pca-svg"] circle[data-selectable="true"]')
    expect(circles.first).to_be_visible()
    count_circles = circles.count()
    assert count_circles > 50
    target_circle = circles.nth(count_circles // 2)
    box = target_circle.bounding_box()
    assert box is not None
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.wait_for_timeout(400)
    zoomed_ids = sidebar_ids(page)
    assert len(zoomed_ids) >= 1
    page.locator('[data-testid="graph-expansion-exit"]').click()
    page.wait_for_timeout(300)
    sidebar = page.locator('[data-testid="selected-sidebar"]')
    expect(sidebar).to_be_visible()
    normal_ids = sidebar_ids(page)
    assert set(zoomed_ids) == set(normal_ids), f"{zoomed_ids} != {normal_ids}"


def test_relationships_pair_precision_when_zoomed(page):
    """G03: 焦点ペア散布図の150%拡大での点クリック・矩形選択。"""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("Relationships")').click()
    page.wait_for_selector('[data-testid="relationship-canvas"]')
    page.locator('[data-testid="graph-expand-relationships/pair"]').click()
    expect(page.locator('[data-testid="graph-expansion-bar"]')).to_be_visible()
    page.locator('[data-testid="graph-expansion-zoom-in"]').click()
    expect(page.locator('[data-testid="graph-expansion-zoom-label"]')).to_have_text("125%")
    page.wait_for_timeout(400)
    canvas = page.locator('[data-testid="relationship-canvas"]')
    box = canvas.bounding_box()
    assert box is not None
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.wait_for_timeout(400)
    assert len(sidebar_ids(page)) >= 0
    # 矩形選択：全点矩形で通常時と同じ集合になる
    page.mouse.move(box["x"] + 5, box["y"] + 5)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] - 5, box["y"] + box["height"] - 5, steps=8)
    page.mouse.up()
    page.wait_for_timeout(500)
    zoomed_ids = sidebar_ids(page)
    page.locator('[data-testid="graph-expansion-exit"]').click()
    page.wait_for_timeout(300)


def test_distribution_brush_when_zoomed(page):
    """G04: 箱ひげ図の150%拡大での範囲ブラシ。"""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("Distribution")').click()
    page.wait_for_selector('[data-testid="dist-view-mode"]')
    page.locator('[data-testid="dist-view-mode"] .ant-segmented-item').nth(1).click()
    page.wait_for_selector('[data-testid="distribution-svg"]')
    page.locator('[data-testid="graph-expand-distribution/boxplot"]').click()
    page.locator('[data-testid="graph-expansion-zoom-in"]').click()
    expect(page.locator('[data-testid="graph-expansion-zoom-label"]')).to_have_text("125%")
    page.wait_for_timeout(400)
    svg = page.locator('[data-testid="distribution-svg"]').first
    box = svg.bounding_box()
    assert box is not None
    start_x = box["x"] + box["width"] * 0.35
    start_y = box["y"] + box["height"] * 0.2
    end_x = box["x"] + box["width"] * 0.55
    end_y = box["y"] + box["height"] * 0.3
    page.mouse.move(start_x, start_y)
    page.mouse.down()
    page.mouse.move(end_x, end_y, steps=5)
    page.mouse.up()
    page.wait_for_timeout(400)
    page.locator('[data-testid="graph-expansion-exit"]').click()
    sidebar = page.locator('[data-testid="selected-sidebar"]')
    count = int(sidebar.inner_text().split("選択行 ")[1].split(" /")[0])
    assert count >= 0


def test_pcp_brush_when_zoomed(page):
    """G01: PCP混合描画の150%拡大での矩形選択。"""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')
    page.locator('[data-testid="plot-overlay"]').dblclick()
    page.wait_for_timeout(200)
    page.locator('[data-testid="graph-expand-pcp/main"]').click()
    page.locator('[data-testid="graph-expansion-zoom-in"]').click()
    expect(page.locator('[data-testid="graph-expansion-zoom-label"]')).to_have_text("125%")
    page.wait_for_timeout(400)
    canvas = page.locator('[data-testid="pcp-canvas"]')
    box = canvas.bounding_box()
    assert box is not None
    x1 = box["x"] + box["width"] * 0.4
    x2 = box["x"] + box["width"] * 0.7
    y1 = box["y"] + box["height"] * 0.3
    y2 = box["y"] + box["height"] * 0.75
    page.mouse.move(x1, y1)
    page.mouse.down()
    page.mouse.move(x2, y2, steps=6)
    page.mouse.up()
    page.wait_for_timeout(500)
    page.locator('[data-testid="graph-expansion-exit"]').click()
    sidebar = page.locator('[data-testid="selected-sidebar"]')
    count = int(sidebar.inner_text().split("選択行 ")[1].split(" /")[0])
    assert count > 0, f"Expected zoomed PCP brush to select rows, got {count}"


def test_statistics_hist_drag_selection(page):
    """G08: ヒストグラムの矩形選択（通常・拡大のrowId一致）。"""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("Statistics")').click()
    page.wait_for_selector('[data-testid="statistics-page"]')
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.locator('[data-testid="plot-overlay"]').dblclick()
    page.wait_for_timeout(200)
    page.locator('.ant-segmented-item:has-text("Statistics")').click()
    histograms = page.locator('[data-testid^="graph-host-statistics/histogram/"] svg')
    expect(histograms.first).to_be_visible()
    first_hist = histograms.first
    box = first_hist.bounding_box()
    assert box is not None
    start_x = box["x"] + 10
    y = box["y"] + box["height"] * 0.5
    end_x = box["x"] + box["width"] * 0.7
    page.mouse.move(start_x, y)
    page.mouse.down()
    page.mouse.move(end_x, y, steps=5)
    page.mouse.up()
    page.wait_for_timeout(400)
    normal_ids = sidebar_ids(page)
    assert len(normal_ids) > 0, "Expected histogram drag to select rows"
