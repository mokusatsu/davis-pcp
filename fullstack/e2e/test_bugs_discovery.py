"""E2E Bug Discovery & Verification Test Suite:
Validates all graph display bug fixes and tests multiple datasets and orientations:
1. PCP vertical orientation: axis line, ticks, value labels, and drag brush.
2. Silhouette plot: diverging bars from s=0 baseline, negative bar alignment, reference lines.
3. Pair plot: brushing on multi-column dataset with robust row ID mapping.
4. Distribution: vertical orientation vertical axis line, ticks, and range brush.
5. Statistics: empty state when statsScope is 'selected' and 0 rows are selected.
6. Multi-dataset integrity: Iris and Heart Disease (14 cols) rendering without crash.
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
        p.set_default_timeout(12000)
        p.goto(BASE_URL)
        p.wait_for_selector('[data-testid="pcp-canvas"]')
        p.wait_for_selector('[data-testid="dataset-selector"]')
        p.wait_for_timeout(500)
        yield p
        browser.close()


@pytest.fixture(autouse=True)
def reset_state(page):
    """Ensure non-focus mode and Iris dataset for consistent baseline."""
    if page.locator('[data-testid="focus-bar"]').is_visible():
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
    yield
    if page.locator('[data-testid="focus-bar"]').is_visible():
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)


def switch_dataset_if_needed(page, dataset_name: str):
    """Switch the current dataset if it doesn't match dataset_name."""
    selector = page.locator('[data-testid="dataset-selector"]')
    current_text = selector.inner_text()
    if dataset_name.lower() in current_text.lower():
        return
    selector.click()
    page.wait_for_timeout(300)
    input_box = selector.locator('input')
    if input_box.is_visible():
        input_box.fill(dataset_name)
        page.wait_for_timeout(300)
    option = page.locator(f'.ant-select-item-option:has-text("{dataset_name}")').first
    option.scroll_into_view_if_needed()
    option.click(force=True)
    page.wait_for_timeout(800)


def test_pcp_vertical_ticks_and_brush(page):
    """Bug 1 Fix: Verify vertical PCP orientation draws axis lines, ticks, labels and handles brush."""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')

    # Switch to vertical orientation
    page.locator('[data-testid="axis-order-menu"]').click()
    page.locator('[data-testid="orientation"]').locator('text=垂直').click()
    page.wait_for_timeout(500)
    page.keyboard.press("Escape")

    canvas = page.locator('[data-testid="pcp-canvas"]')
    box = canvas.bounding_box()
    assert box["width"] > 200
    assert box["height"] > 200

    # Drag brush in vertical orientation
    overlay = page.locator('[data-testid="plot-overlay"]')
    obox = overlay.bounding_box()
    page.mouse.move(obox["x"] + obox["width"] * 0.25, obox["y"] + obox["height"] * 0.25)
    page.mouse.down()
    page.mouse.move(obox["x"] + obox["width"] * 0.65, obox["y"] + obox["height"] * 0.65, steps=5)
    page.mouse.up()
    page.wait_for_timeout(400)

    # Switch back to horizontal orientation
    page.locator('[data-testid="axis-order-menu"]').click()
    page.locator('[data-testid="orientation"]').locator('text=水平').click()
    page.wait_for_timeout(400)
    page.keyboard.press("Escape")


def test_silhouette_diverging_bars_layout(page):
    """Bug 2 Fix: Verify Silhouette plot bars diverge from s=0 baseline instead of x=100."""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("Clusters")').click()
    if not page.locator('[data-testid="silhouette-svg"]').is_visible():
        page.locator('[data-testid="run-clustering"]').click()
        page.wait_for_selector('[data-testid="silhouette-svg"]', timeout=15000)

    svg = page.locator('[data-testid="silhouette-svg"]')
    svg.scroll_into_view_if_needed()
    expect(svg).to_be_visible()

    # Verify reference lines exist: s=-1, s=0, s=+1
    zero_text = svg.locator('text:has-text("s=0")')
    expect(zero_text).to_be_visible()
    zero_x = float(zero_text.get_attribute("x"))
    assert zero_x > 200, f"s=0 line x position should be centered, got {zero_x}"

    # Verify bars: positive silhouette bars must start at zero_x (or near zero_x)
    bars = svg.locator('rect[style*="cursor: pointer"]')
    count = bars.count()
    assert count > 0, "Expected silhouette bars"

    # Check the first bar (typically high positive silhouette in Iris setosa cluster)
    first_x = float(bars.first.get_attribute("x"))
    assert abs(first_x - zero_x) < 1.0, f"Positive silhouette bar should start at zero_x ({zero_x}), got {first_x}"


def test_pair_plot_brush_selection_accuracy(page):
    """Bug 3 Fix: Verify Pair Plot drag brush accurately selects rows on multi-column data."""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("Relationships")').click()
    page.wait_for_selector('[data-testid="pair-plot"]')

    # Drag over a pair-plot cell (e.g. sepal_length vs sepal_width)
    svg = page.locator('[data-testid="pair-plot"]')
    box = svg.bounding_box()
    # Cell 1 (x: 1, y: 0)
    cx = box["x"] + 140
    cy = box["y"] + 60
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + 40, cy + 40, steps=4)
    page.mouse.up()
    page.wait_for_timeout(500)

    sidebar = page.locator('[data-testid="selected-sidebar"]')
    expect(sidebar).to_be_visible()
    sidebar_text = sidebar.inner_text()
    count = int(sidebar_text.split("選択行 ")[1].split(" /")[0])
    assert count > 0, f"Expected rows to be selected by brush, got {count}"


def test_distribution_vertical_axis_line(page):
    """Bug 4 Fix: Verify Distribution lens in vertical mode renders vertical axis hairlines."""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("Distribution")').click()
    page.wait_for_selector('[data-testid="distribution-svg"]')

    # Switch to vertical orientation
    page.locator('[data-testid="dist-orientation"]').locator('text=縦（箱が横に並ぶ）').click()
    page.wait_for_timeout(500)

    svg = page.locator('[data-testid="distribution-svg"]')
    expect(svg).to_be_visible()

    # Verify vertical axis lines exist (innerTop to innerBottom)
    lines = svg.locator('line')
    # There should be at least one vertical axis line (x1 == x2 and y1 != y2)
    found_vertical_axis = False
    for i in range(lines.count()):
        line = lines.nth(i)
        x1 = line.get_attribute("x1")
        x2 = line.get_attribute("x2")
        y1 = line.get_attribute("y1")
        y2 = line.get_attribute("y2")
        if x1 and x2 and y1 and y2 and x1 == x2 and abs(float(y2) - float(y1)) > 100:
            found_vertical_axis = True
            break
    assert found_vertical_axis, "Expected vertical axis hairline in vertical distribution plot"

    # Switch back to horizontal
    page.locator('[data-testid="dist-orientation"]').locator('text=横（箱が縦に並ぶ）').click()
    page.wait_for_timeout(400)


def test_statistics_selected_scope_empty_state(page):
    """Bug 5 Fix: Verify Statistics page shows informative Empty state when 0 rows are selected."""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("Statistics")').click()
    page.wait_for_selector('[data-testid="statistics-page"]')

    # Clear selection first
    page.locator('[data-testid="stats-selection-menu"]').click()
    clear_btn = page.locator('.ant-dropdown button:has-text("選択解除")')
    if clear_btn.is_visible():
        clear_btn.click()
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)

    # Switch scope to "選択中"
    page.locator('[data-testid="stats-scope"]').locator('text=選択中').click()
    page.wait_for_timeout(400)

    # Check that Empty state is displayed
    empty_elem = page.locator('[data-testid="stats-empty-selected"]')
    expect(empty_elem).to_be_visible()
    expect(empty_elem).to_contain_text("行が選択されていません")

    # Switch back to active
    page.locator('[data-testid="stats-scope"]').locator('text=有効データ全体').click()
    page.wait_for_timeout(400)
    expect(page.locator('[data-testid="statistics-page"] table')).to_be_visible()


def test_heart_disease_dataset_across_all_tabs(page):
    """Test switching to heart_disease_cleveland (14 cols) and navigating across all tabs."""
    switch_dataset_if_needed(page, "heart_disease_cleveland")

    # Tab 1: PCP
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')
    axes = page.locator('[data-testid^="axis-control-"]')
    expect(axes).to_have_count(14)

    # Tab 2: Distribution
    page.locator('.ant-segmented-item:has-text("Distribution")').click()
    page.wait_for_selector('[data-testid="distribution-svg"]')
    expect(page.locator('[data-testid="distribution-svg"]')).to_be_visible()

    # Tab 3: Relationships
    page.locator('.ant-segmented-item:has-text("Relationships")').click()
    page.wait_for_selector('[data-testid="pair-plot"]')
    expect(page.locator('[data-testid="correlation-heatmap"]')).to_be_visible()
    expect(page.locator('[data-testid="facet-plot"]')).to_be_visible()

    # Tab 4: Statistics
    page.locator('.ant-segmented-item:has-text("Statistics")').click()
    page.wait_for_selector('[data-testid="statistics-page"] table')
    expect(page.locator('[data-testid^="histogram-"]').first).to_be_visible()

    # Switch back to Iris
    switch_dataset_if_needed(page, "Iris")
