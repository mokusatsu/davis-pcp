"""E2E test suite for verifying mouse coordinate precision during zoom / focus mode across all charts."""
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
        # Standard desktop viewport
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
def ensure_unfocused(page):
    """Ensure every test starts and ends in non-focused mode."""
    if page.locator('[data-testid="focus-bar"]').is_visible():
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
    yield
    if page.locator('[data-testid="focus-bar"]').is_visible():
        page.keyboard.press("Escape")
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


def ensure_clustering_run(page):
    page.locator('.ant-segmented-item:has-text("Clusters")').click()
    if not page.locator('[data-testid="pca-svg"]').is_visible():
        page.locator('[data-testid="run-clustering"]').click()
        page.wait_for_selector('[data-testid="pca-svg"]', timeout=15000)


def test_pca_scatter_mouse_precision_when_zoomed(page):
    """Test clicking a point in PCA scatter when zoomed 150% in Focus Mode."""
    switch_dataset_if_needed(page, "Iris")
    ensure_clustering_run(page)

    # Enter focus mode for PCA
    page.locator('[data-testid="focus-enter-pca"]').first.click()
    expect(page.locator('[data-testid="focus-bar"]')).to_be_visible()

    # Zoom in to 150%
    page.locator('[data-testid="focus-zoom-in"]').click()
    page.wait_for_selector('[data-testid="focus-scaled"]')
    page.wait_for_timeout(400)

    # Find circles in PCA SVG
    circles = page.locator('[data-testid="pca-svg"] circle[data-selectable="true"]')
    expect(circles.first).to_be_visible()
    count_circles = circles.count()
    assert count_circles > 50

    # Pick a circle near the center
    target_circle = circles.nth(count_circles // 2)
    box = target_circle.bounding_box()
    assert box is not None
    click_x = box["x"] + box["width"] / 2
    click_y = box["y"] + box["height"] / 2

    # Click directly on screen at the circle center
    page.mouse.click(click_x, click_y)
    page.wait_for_timeout(400)

    # Verify that the click selected a row (selection in store)
    # Exit focus mode to check sidebar count
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    sidebar = page.locator('[data-testid="selected-sidebar"]')
    expect(sidebar).to_be_visible()
    count = int(sidebar.inner_text().split("選択行 ")[1].split(" /")[0])
    assert count >= 1, f"Expected point click to select at least 1 row, got {count}"


def test_pca_scatter_rect_drag_when_zoomed(page):
    """Test dragging a selection rectangle in PCA scatter when zoomed in Focus Mode."""
    switch_dataset_if_needed(page, "Iris")
    ensure_clustering_run(page)

    # Clear previous selection
    page.keyboard.press("Escape")
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.locator('[data-testid="plot-overlay"]').dblclick()
    page.wait_for_timeout(200)

    page.locator('.ant-segmented-item:has-text("Clusters")').click()
    page.locator('[data-testid="focus-enter-pca"]').first.click()
    page.locator('[data-testid="focus-zoom-in"]').click()
    page.wait_for_timeout(400)

    # Drag across a central region of the PCA plot
    svg = page.locator('[data-testid="pca-svg"]')
    box = svg.bounding_box()
    assert box is not None

    start_x = box["x"] + box["width"] * 0.25
    start_y = box["y"] + box["height"] * 0.25
    end_x = box["x"] + box["width"] * 0.75
    end_y = box["y"] + box["height"] * 0.75

    page.mouse.move(start_x, start_y)
    page.mouse.down()
    page.mouse.move(end_x, end_y, steps=5)
    page.mouse.up()
    page.wait_for_timeout(400)

    # Exit and check selection
    page.keyboard.press("Escape")
    sidebar = page.locator('[data-testid="selected-sidebar"]')
    count = int(sidebar.inner_text().split("選択行 ")[1].split(" /")[0])
    assert count > 0, f"Expected PCA drag brush to select points, got {count}"


def test_pair_plot_mouse_precision_when_zoomed(page):
    """Test clicking and brushing in Pair Plot when zoomed 150% in Focus Mode."""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("Relationships")').click()
    page.wait_for_selector('[data-testid="pair-plot"]')

    # Enter focus mode for pair-plot
    page.locator('[data-testid="focus-enter-pair-plot"]').first.click()
    expect(page.locator('[data-testid="focus-bar"]')).to_be_visible()

    # Zoom in to 150%
    page.locator('[data-testid="focus-zoom-in"]').click()
    page.wait_for_selector('[data-testid="focus-scaled"]')
    page.wait_for_timeout(400)

    # Find a scatter circle
    circles = page.locator('[data-testid="pair-plot"] circle[data-selectable="true"]')
    expect(circles.first).to_be_visible()
    target_circle = circles.nth(10)
    box = target_circle.bounding_box()
    assert box is not None

    # Click circle at its center
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.wait_for_timeout(400)

    # Exit and verify selection
    page.keyboard.press("Escape")
    sidebar = page.locator('[data-testid="selected-sidebar"]')
    count = int(sidebar.inner_text().split("選択行 ")[1].split(" /")[0])
    assert count >= 1, f"Expected pair plot circle click to select row, got {count}"


def test_distribution_brush_when_zoomed(page):
    """Test range brushing in Distribution page when zoomed 150% in Focus Mode."""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("Distribution")').click()
    page.wait_for_selector('[data-testid="distribution-svg"]')

    page.locator('[data-testid="focus-enter-distribution"]').first.click()
    page.locator('[data-testid="focus-zoom-in"]').click()
    page.wait_for_selector('[data-testid="focus-scaled"]')
    page.wait_for_timeout(400)

    svg = page.locator('[data-testid="distribution-svg"]')
    box = svg.bounding_box()
    assert box is not None

    # Drag horizontally across a panel's data range
    start_x = box["x"] + box["width"] * 0.35
    start_y = box["y"] + box["height"] * 0.2
    end_x = box["x"] + box["width"] * 0.55
    end_y = box["y"] + box["height"] * 0.3

    page.mouse.move(start_x, start_y)
    page.mouse.down()
    page.mouse.move(end_x, end_y, steps=5)
    page.mouse.up()
    page.wait_for_timeout(400)

    page.keyboard.press("Escape")
    sidebar = page.locator('[data-testid="selected-sidebar"]')
    count = int(sidebar.inner_text().split("選択行 ")[1].split(" /")[0])
    assert count > 0, f"Expected distribution drag to select rows, got {count}"


def test_pcp_click_selection_when_zoomed(page):
    """Test clicking a polyline in PCP canvas when zoomed 150% in Focus Mode."""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')

    # Clear selection first
    page.locator('[data-testid="plot-overlay"]').dblclick()
    page.wait_for_timeout(200)

    # Enter focus mode and zoom
    page.locator('[data-testid="focus-enter-pcp"]').click()
    page.locator('[data-testid="focus-zoom-in"]').click()
    page.wait_for_selector('[data-testid="focus-scaled"]')
    page.wait_for_timeout(400)

    # Canvas bounds
    canvas = page.locator('[data-testid="pcp-canvas"]')
    box = canvas.bounding_box()
    assert box is not None

    # Drag a selection band across the middle axes
    x1 = box["x"] + box["width"] * 0.4
    x2 = box["x"] + box["width"] * 0.7
    y1 = box["y"] + box["height"] * 0.3
    y2 = box["y"] + box["height"] * 0.75
    page.mouse.move(x1, y1)
    page.mouse.down()
    page.mouse.move(x2, y2, steps=6)
    page.mouse.up()
    page.wait_for_timeout(500)

    page.keyboard.press("Escape")
    sidebar = page.locator('[data-testid="selected-sidebar"]')
    count = int(sidebar.inner_text().split("選択行 ")[1].split(" /")[0])
    assert count > 0, f"Expected zoomed PCP brush to select rows, got {count}"


def test_facet_plot_mouse_drag_when_zoomed(page):
    """Test dragging a range selection in Facet Plot when zoomed 150% in Focus Mode."""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("Relationships")').click()
    page.wait_for_selector('[data-testid="facet-plot"]')

    # Clear selection first
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.locator('[data-testid="plot-overlay"]').dblclick()
    page.wait_for_timeout(200)

    page.locator('.ant-segmented-item:has-text("Relationships")').click()
    page.locator('[data-testid="focus-enter-facet-plot"]').first.click()
    expect(page.locator('[data-testid="focus-bar"]')).to_be_visible()

    # Zoom in to 150%
    page.locator('[data-testid="focus-zoom-in"]').click()
    page.wait_for_selector('[data-testid="focus-scaled"]')
    page.wait_for_timeout(400)

    # Drag across a central region of facet plot
    svg = page.locator('[data-testid="facet-plot"]')
    box = svg.bounding_box()
    assert box is not None

    start_x = box["x"] + box["width"] * 0.35
    start_y = box["y"] + box["height"] * 0.35
    end_x = box["x"] + box["width"] * 0.65
    end_y = box["y"] + box["height"] * 0.65

    page.mouse.move(start_x, start_y)
    page.mouse.down()
    page.mouse.move(end_x, end_y, steps=5)
    page.mouse.up()
    page.wait_for_timeout(400)

    page.keyboard.press("Escape")
    sidebar = page.locator('[data-testid="selected-sidebar"]')
    count = int(sidebar.inner_text().split("選択行 ")[1].split(" /")[0])
    assert count > 0, f"Expected zoomed facet drag to select rows, got {count}"


def test_statistics_hist_drag_selection(page):
    """Test dragging a range selection in Statistics page histograms."""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("Statistics")').click()
    page.wait_for_selector('[data-testid="statistics-page"] table')

    # Clear selection first
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.locator('[data-testid="plot-overlay"]').dblclick()
    page.wait_for_timeout(200)

    page.locator('.ant-segmented-item:has-text("Statistics")').click()
    histograms = page.locator('[data-testid^="histogram-"]')
    expect(histograms.first).to_be_visible()

    first_hist = histograms.first
    box = first_hist.bounding_box()
    assert box is not None

    # Drag across middle of histogram starting from plot margin to avoid hitting selectable mark
    start_x = box["x"] + 10
    y = box["y"] + box["height"] * 0.5
    end_x = box["x"] + box["width"] * 0.7

    page.mouse.move(start_x, y)
    page.mouse.down()
    page.mouse.move(end_x, y, steps=5)
    page.mouse.up()
    page.wait_for_timeout(400)

    sidebar = page.locator('[data-testid="selected-sidebar"]')
    count = int(sidebar.inner_text().split("選択行 ")[1].split(" /")[0])
    assert count > 0, f"Expected histogram drag to select rows, got {count}"

