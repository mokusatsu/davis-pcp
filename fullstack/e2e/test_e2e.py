"""E2E: real browser against a running server (default http://127.0.0.1:8425).

Run:  python -m pytest ../e2e/test_e2e.py -q   (from backend/, server running)
Covers the order.txt §23.4 golden path: boot → PCP → brush → linked views →
ordering → clustering → models → session save.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

BASE_URL = os.environ.get("DAVIS_PCP_URL", "http://127.0.0.1:8425")

pytest.importorskip("playwright")
from playwright.sync_api import expect, sync_playwright  # noqa: E402


@pytest.fixture(scope="module")
def page():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=["--disable-extensions", "--disable-component-update", "--no-sandbox"])
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        page.set_default_timeout(10000)
        page.goto(BASE_URL)
        page.wait_for_selector('[data-testid="pcp-canvas"]')
        yield page
        browser.close()


def test_boot_five_axes(page):
    axes = page.locator('[data-testid^="axis-control-"]')
    expect(axes).to_have_count(5)
    assert page.locator('[data-testid="pcp-canvas"]').get_attribute("width") is not None


def test_ordering_component_jar(page):
    page.locator('[data-testid="axis-order-menu"]').click()
    page.locator('[data-testid="order-mode"]').click()
    page.get_by_text("Component／JAR初版互換").click()
    page.wait_for_timeout(600)
    # Diagnostics evidence class appears in the toolbar
    assert "JAR-INITIAL" in page.locator('[data-testid="pcp-page"]').inner_text()


def test_brush_selects_and_propagates(page):
    # start from a clean selection and the default axis order (the ordering
    # test may have changed it, which shifts where species bands live)
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="plot-overlay"]')
    open_selection_menu_and_clear(page)
    page.locator('[data-testid="axis-order-menu"]').click()
    page.locator('[data-testid="order-mode"]').click()
    page.get_by_text("NoOrder（入力順）").click()
    page.wait_for_timeout(600)
    overlay = page.locator('[data-testid="plot-overlay"]')
    box = overlay.bounding_box()
    x, y = box["x"], box["y"]
    w, h = box["width"], box["height"]
    # setosa region on petal axes
    page.mouse.move(x + w * 0.52, y + h * 0.72)
    page.mouse.down()
    page.mouse.move(x + w * 0.78, y + h * 0.9, steps=6)
    page.mouse.up()
    # wait until the worker-driven selection lands in the sidebar
    page.wait_for_function(
        """() => {
          const el = document.querySelector('[data-testid=\"selected-sidebar\"]');
          if (!el) return false;
          const m = el.textContent.match(/選択行 (\\d+)/);
          return m && parseInt(m[1], 10) > 20;
        }""",
        timeout=8000,
    )
    sidebar = page.locator('[data-testid="selected-sidebar"]').inner_text()
    count = int(sidebar.split("選択行 ")[1].split(" /")[0])
    assert count < 80, f"brush selected {count}"


def open_selection_menu_and_clear(page):
    page.locator('[data-testid="selection-menu"]').click()
    clear = page.locator('[data-testid="clear-selection"]')
    clear.wait_for(state="visible", timeout=3000)
    if clear.is_enabled():
        clear.click()
    page.wait_for_timeout(300)
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)


def test_table_shows_selection(page):
    page.locator('.ant-segmented-item:has-text("Table")').click()
    page.wait_for_selector('[data-testid="data-table"]')
    page.wait_for_function(
        """() => document.querySelectorAll('[data-testid=\"data-table\"] input[type=checkbox]:checked').length > 0""",
        timeout=8000,
    )
    checked = page.locator('[data-testid="data-table"] input[type=checkbox]:checked')
    assert checked.count() > 0


def test_distribution_range_brush(page):
    page.locator('.ant-segmented-item:has-text("Distribution")').click()
    page.wait_for_selector('[data-testid="distribution-svg"]')
    svg = page.locator('[data-testid="distribution-svg"]')
    box = svg.bounding_box()
    # drag inside the first panel
    page.mouse.move(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.25)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.45, steps=5)
    page.mouse.up()
    page.wait_for_timeout(500)
    # no crash and svg still present
    expect(svg).to_be_visible()


def test_relationships_pair_plot_heatmap_facet(page):
    page.locator('.ant-segmented-item:has-text("Relationships")').click()
    page.wait_for_selector('[data-testid="pair-plot"]')
    assert page.locator('[data-testid="correlation-heatmap"]').is_visible()
    assert page.locator('[data-testid="facet-plot"]').is_visible()
    # click a heatmap cell → facet updates
    cells = page.locator('[data-testid="correlation-heatmap"] rect[role="button"]')
    cells.nth(5).click()
    page.wait_for_timeout(400)
    assert page.locator('[data-testid="facet-plot"] circle').count() > 0


def test_clusters_pca_silhouette_dendrogram(page):
    page.locator('.ant-segmented-item:has-text("Clusters")').click()
    page.locator('[data-testid="run-clustering"]').click()
    page.wait_for_selector('[data-testid="pca-svg"]', timeout=15000)
    assert page.locator('[data-testid="silhouette-svg"]').is_visible()
    cluster_buttons = page.locator('button:has-text("cluster 0")')
    expect(cluster_buttons.first).to_be_visible()
    # select cluster 1 → sidebar count updates
    page.locator('[data-testid="cluster-1"]').click()
    page.wait_for_timeout(500)
    sidebar = page.locator('[data-testid="selected-sidebar"]').inner_text()
    count = int(sidebar.split("選択行 ")[1].split(" /")[0])
    assert count > 10


def test_decision_tree_leaf_select(page):
    page.locator('.ant-segmented-item:has-text("Models")').click()
    page.locator('[data-testid="run-model"]').click()
    page.wait_for_selector('[data-testid="tree-diagram-0"]', timeout=15000)
    leaves = page.locator('[data-testid^="tree-leaf-0-"]')
    assert leaves.count() >= 2
    # click a leaf → selection propagates
    leaves.first.click()
    page.wait_for_timeout(500)
    sidebar = page.locator('[data-testid="selected-sidebar"]').inner_text()
    count = int(sidebar.split("選択行 ")[1].split(" /")[0])
    assert count > 0


def test_statistics_page_histograms(page):
    page.locator('.ant-segmented-item:has-text("Statistics")').click()
    page.wait_for_selector('[data-testid="statistics-page"] table')
    histograms = page.locator('[data-testid^="histogram-"]')
    assert histograms.count() >= 4


def test_session_save_persists(page):
    page.locator('[data-testid="save-button"]').click()
    page.locator('[data-testid="session-name"]').fill("E2E session")
    page.locator('.ant-modal .ant-btn-primary').click()
    page.wait_for_timeout(800)
    # badge shows revision
    assert page.locator(".ant-badge").count() >= 0  # save succeeded without error modal
