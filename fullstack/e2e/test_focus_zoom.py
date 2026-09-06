"""E2E: Thorough tests for PCP-like zoom and focus mode across ALL graphs.

Tests focus enter, fit mode, zoom in, zoom out, zoom select, exit via button,
exit via Escape key, fullscreen styling (headers/sidebars hidden), and interactions
within focus mode for:
1. PCP (Parallel Coordinates)
2. Distribution (Boxplot & jittered scatter)
3. Relationships - Pair Plot (Scatter plot matrix)
4. Relationships - Correlation Heatmap
5. Relationships - Facet Plot
6. Clusters - PCA 2D Scatter
7. Clusters - Silhouette Width Plot
8. Clusters - Dendrogram
9. Models - Decision Tree Diagram
10. Statistics - Histograms Grid
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
def ensure_unfocused(page):
    """Ensure every test starts and ends in non-focused mode so navigation is visible."""
    if page.locator('[data-testid="focus-bar"]').is_visible():
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
    yield
    if page.locator('[data-testid="focus-bar"]').is_visible():
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)


def verify_focus_mode_active(page, expected_title_sub: str | None = None):
    """Verify that focus mode is active and headers/sidebars are hidden."""
    expect(page.locator('[data-testid="focus-bar"]')).to_be_visible()
    expect(page.locator('.ant-layout-header')).not_to_be_visible()
    expect(page.locator('[data-testid="selected-sidebar"]')).not_to_be_visible()
    if expected_title_sub:
        title_text = page.locator('[data-testid="focus-title"]').inner_text()
        assert expected_title_sub in title_text, f"Expected '{expected_title_sub}' in '{title_text}'"


def verify_focus_mode_inactive(page):
    """Verify that focus mode is exited and normal layout is restored."""
    expect(page.locator('[data-testid="focus-bar"]')).not_to_be_visible()
    expect(page.locator('.ant-layout-header')).to_be_visible()
    expect(page.locator('[data-testid="selected-sidebar"]')).to_be_visible()


def test_pcp_focus_and_zoom(page):
    """1. PCP focus mode, zoom in/out, fit, escape, and canvas interaction while focused."""
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')

    # Enter focus mode
    page.locator('[data-testid="focus-enter-pcp"]').click()
    verify_focus_mode_active(page, "PCP")

    # Fit mode by default: no scaled container yet
    expect(page.locator('.focus-target-fit')).to_be_visible()
    expect(page.locator('[data-testid="focus-scaled"]')).to_have_count(0)

    # Zoom In -> 150% (stepIndex < 0 defaults to 1.5x)
    page.locator('[data-testid="focus-zoom-in"]').click()
    page.wait_for_selector('[data-testid="focus-scaled"]')
    expect(page.locator('.focus-target-zoomed')).to_be_visible()

    # Zoom In again -> 200%
    page.locator('[data-testid="focus-zoom-in"]').click()
    page.wait_for_timeout(200)

    # Zoom Out
    page.locator('[data-testid="focus-zoom-out"]').click()
    page.wait_for_timeout(200)

    # Fit
    page.locator('[data-testid="focus-fit"]').click()
    expect(page.locator('.focus-target-fit')).to_be_visible()
    expect(page.locator('[data-testid="focus-scaled"]')).to_have_count(0)

    # Exit via button
    page.locator('[data-testid="focus-exit"]').click()
    verify_focus_mode_inactive(page)

    # Enter again and exit via Escape key
    page.locator('[data-testid="focus-enter-pcp"]').click()
    verify_focus_mode_active(page)
    page.keyboard.press("Escape")
    verify_focus_mode_inactive(page)


def test_distribution_focus_and_zoom(page):
    """2. Distribution focus mode, zoom, and range brush while focused."""
    page.locator('.ant-segmented-item:has-text("Distribution")').click()
    page.wait_for_selector('[data-testid="distribution-svg"]')

    # Enter focus mode
    page.locator('[data-testid="focus-enter-distribution"]').click()
    verify_focus_mode_active(page, "分布")

    # Test Zoom
    page.locator('[data-testid="focus-zoom-in"]').click()
    page.wait_for_selector('[data-testid="focus-scaled"]')
    expect(page.locator('.focus-target-zoomed')).to_be_visible()

    # Fit
    page.locator('[data-testid="focus-fit"]').click()
    expect(page.locator('.focus-target-fit')).to_be_visible()

    # Range brush interaction while focused
    svg = page.locator('[data-testid="distribution-svg"]').first
    box = svg.bounding_box()
    page.mouse.move(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.25)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.45, steps=5)
    page.mouse.up()
    page.wait_for_timeout(300)
    expect(svg).to_be_visible()

    # Exit via Escape
    page.keyboard.press("Escape")
    verify_focus_mode_inactive(page)


def test_relationships_pair_plot_focus(page):
    """3. Pair Plot focus mode in Relationships page."""
    page.locator('.ant-segmented-item:has-text("Relationships")').click()
    page.wait_for_selector('[data-testid="pair-plot"]')

    # Enter focus mode for pair-plot
    page.locator('[data-testid="focus-enter-pair-plot"]').first.click()
    verify_focus_mode_active(page, "ペアプロット")

    # Other charts should be hidden while pair-plot is focused
    expect(page.locator('[data-testid="correlation-heatmap"]')).not_to_be_visible()
    expect(page.locator('[data-testid="facet-plot"]')).not_to_be_visible()

    # Zoom In
    page.locator('[data-testid="focus-zoom-in"]').click()
    page.wait_for_selector('[data-testid="focus-scaled"]')

    # Fit
    page.locator('[data-testid="focus-fit"]').click()
    expect(page.locator('.focus-target-fit')).to_be_visible()

    # Exit via button
    page.locator('[data-testid="focus-exit"]').click()
    verify_focus_mode_inactive(page)

    # Heatmap and Facet are visible again
    expect(page.locator('[data-testid="correlation-heatmap"]')).to_be_visible()
    expect(page.locator('[data-testid="facet-plot"]')).to_be_visible()


def test_relationships_heatmap_focus(page):
    """4. Correlation Heatmap focus mode and cell click in Relationships page."""
    page.locator('.ant-segmented-item:has-text("Relationships")').click()
    page.wait_for_selector('[data-testid="correlation-heatmap"]')

    # Enter focus mode for heatmap
    page.locator('[data-testid="focus-enter-heatmap"]').click()
    verify_focus_mode_active(page, "相関ヒートマップ")

    # Pair plot and Facet should be hidden
    expect(page.locator('[data-testid="pair-plot"]')).not_to_be_visible()
    expect(page.locator('[data-testid="facet-plot"]')).not_to_be_visible()

    # Zoom In and Fit
    page.locator('[data-testid="focus-zoom-in"]').click()
    expect(page.locator('.focus-target-zoomed')).to_be_visible()
    page.locator('[data-testid="focus-fit"]').click()
    expect(page.locator('.focus-target-fit')).to_be_visible()

    # Heatmap cell click interaction while focused
    cells = page.locator('[data-testid="correlation-heatmap"] rect[role="button"]')
    cells.nth(3).click()
    page.wait_for_timeout(300)

    # Exit via Escape
    page.keyboard.press("Escape")
    verify_focus_mode_inactive(page)


def test_relationships_facet_plot_focus(page):
    """5. Facet Plot focus mode in Relationships page."""
    page.locator('.ant-segmented-item:has-text("Relationships")').click()
    page.wait_for_selector('[data-testid="facet-plot"]')

    # Enter focus mode for facet-plot
    page.locator('[data-testid="focus-enter-facet-plot"]').click()
    verify_focus_mode_active(page, "ファセットプロット")

    # Pair plot and Heatmap hidden
    expect(page.locator('[data-testid="pair-plot"]')).not_to_be_visible()
    expect(page.locator('[data-testid="correlation-heatmap"]')).not_to_be_visible()

    # Zoom In and Fit
    page.locator('[data-testid="focus-zoom-in"]').click()
    expect(page.locator('.focus-target-zoomed')).to_be_visible()
    page.locator('[data-testid="focus-fit"]').click()
    expect(page.locator('.focus-target-fit')).to_be_visible()

    # Exit via button
    page.locator('[data-testid="focus-exit"]').click()
    verify_focus_mode_inactive(page)


def test_clusters_all_three_graphs_focus(page):
    """6, 7, 8. Clusters page: PCA 2D scatter, Silhouette plot, Dendrogram focus and zoom."""
    page.locator('.ant-segmented-item:has-text("Clusters")').click()
    # Run clustering if not yet run
    if not page.locator('[data-testid="pca-svg"]').is_visible():
        page.locator('[data-testid="run-clustering"]').click()
        page.wait_for_selector('[data-testid="pca-svg"]', timeout=15000)

    # --- 6. PCA Scatter Focus ---
    page.locator('[data-testid="focus-enter-pca"]').first.click()
    verify_focus_mode_active(page, "PCA")
    # Silhouette and Dendrogram hidden
    expect(page.locator('[data-testid="silhouette-svg"]')).not_to_be_visible()
    expect(page.locator('[data-testid="dendrogram-svg"]')).not_to_be_visible()

    page.locator('[data-testid="focus-zoom-in"]').click()
    expect(page.locator('.focus-target-zoomed')).to_be_visible()
    page.locator('[data-testid="focus-fit"]').click()
    expect(page.locator('.focus-target-fit')).to_be_visible()

    # Exit via Escape
    page.keyboard.press("Escape")
    verify_focus_mode_inactive(page)

    # --- 7. Silhouette Plot Focus ---
    page.locator('[data-testid="focus-enter-silhouette"]').first.click()
    verify_focus_mode_active(page, "シルエット")
    expect(page.locator('[data-testid="pca-svg"]')).not_to_be_visible()
    expect(page.locator('[data-testid="dendrogram-svg"]')).not_to_be_visible()

    page.locator('[data-testid="focus-zoom-in"]').click()
    expect(page.locator('.focus-target-zoomed')).to_be_visible()
    page.locator('[data-testid="focus-fit"]').click()

    # Exit via button
    page.locator('[data-testid="focus-exit"]').click()
    verify_focus_mode_inactive(page)

    # --- 8. Dendrogram Focus (run agglomerative clustering which produces linkageMatrix) ---
    page.locator('.ant-segmented-item:has-text("階層的")').click()
    page.locator('[data-testid="run-clustering"]').click()
    page.wait_for_selector('[data-testid="dendrogram-svg"]', timeout=15000)

    page.locator('[data-testid="focus-enter-dendrogram"]').first.click()
    verify_focus_mode_active(page, "樹形図")
    expect(page.locator('[data-testid="pca-svg"]')).not_to_be_visible()
    expect(page.locator('[data-testid="silhouette-svg"]')).not_to_be_visible()

    page.locator('[data-testid="focus-zoom-in"]').click()
    expect(page.locator('.focus-target-zoomed')).to_be_visible()
    page.locator('[data-testid="focus-fit"]').click()

    # Exit via Escape
    page.keyboard.press("Escape")
    verify_focus_mode_inactive(page)


def test_models_decision_tree_focus(page):
    """9. Decision Tree diagram focus and interaction in Models page."""
    page.locator('.ant-segmented-item:has-text("Models")').click()
    if not page.locator('[data-testid="tree-diagram-0"]').is_visible():
        page.locator('[data-testid="run-model"]').click()
        page.wait_for_selector('[data-testid="tree-diagram-0"]', timeout=15000)

    # Enter focus mode for tree
    page.locator('[data-testid="focus-enter-tree"]').first.click()
    verify_focus_mode_active(page, "決定木")

    # Config form, metrics descriptions, feature importance hidden
    expect(page.locator('[data-testid="feature-importance-panel"]')).not_to_be_visible()

    # Zoom In and Fit
    page.locator('[data-testid="focus-zoom-in"]').click()
    expect(page.locator('.focus-target-zoomed')).to_be_visible()
    page.locator('[data-testid="focus-fit"]').click()
    expect(page.locator('.focus-target-fit')).to_be_visible()

    # Click a leaf while in focus mode
    leaves = page.locator('[data-testid^="tree-leaf-0-"]')
    expect(leaves.first).to_be_visible()
    leaves.first.click()
    page.wait_for_timeout(300)

    # Exit via Escape
    page.keyboard.press("Escape")
    verify_focus_mode_inactive(page)
    expect(page.locator('[data-testid="feature-importance-panel"]')).to_be_visible()


def test_statistics_histograms_focus(page):
    """10. Histograms grid focus and interaction in Statistics page."""
    page.locator('.ant-segmented-item:has-text("Statistics")').click()
    page.wait_for_selector('[data-testid="statistics-page"] table')

    # Enter focus mode for histograms
    page.locator('[data-testid="focus-enter-histograms"]').first.click()
    verify_focus_mode_active(page, "ヒストグラム")

    # Descriptive statistics table hidden while focused
    expect(page.locator('[data-testid="statistics-page"] table')).not_to_be_visible()

    # Histograms still visible
    expect(page.locator('[data-testid^="histogram-"]').first).to_be_visible()

    # Zoom In and Fit
    page.locator('[data-testid="focus-zoom-in"]').click()
    expect(page.locator('.focus-target-zoomed')).to_be_visible()
    page.locator('[data-testid="focus-fit"]').click()
    expect(page.locator('.focus-target-fit')).to_be_visible()

    # Click a bar in the histogram while in focus mode
    bars = page.locator('[data-testid^="histogram-"] rect[data-selectable="true"]')
    if bars.count() > 0:
        bars.first.click()
        page.wait_for_timeout(300)

    # Exit via button
    page.locator('[data-testid="focus-exit"]').click()
    verify_focus_mode_inactive(page)
    # Summary table restored
    expect(page.locator('[data-testid="statistics-page"] table')).to_be_visible()
