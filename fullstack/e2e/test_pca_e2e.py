"""E2E test for Feature 08: PCA Diagnostics Suite."""
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
        p.set_default_timeout(15000)
        p.goto(BASE_URL)
        p.wait_for_selector('[data-testid="pcp-canvas"]')
        yield p
        browser.close()


def test_pca_navigation_and_diagnostics(page):
    # Navigate to PCA tab
    page.locator('.ant-segmented-item:has-text("PCA")').click()
    page.wait_for_selector('[data-testid="pca-page"]')

    # Verify Scree Plot, Loading Table, and Biplot are visible
    expect(page.locator('[data-testid="pca-scree-plot"]')).to_be_visible()
    expect(page.locator('[data-testid="pca-scree-canvas"]')).to_be_visible()
    expect(page.locator('[data-testid="pca-loading-table"]')).to_be_visible()
    expect(page.locator('[data-testid="pca-biplot-view"]')).to_be_visible()
    expect(page.locator('[data-testid="pca-biplot-canvas"]')).to_be_visible()

    # Check Kaiser criterion tag
    expect(page.locator('[data-testid="pca-scree-plot"]')).to_contain_text("Kaiser基準推奨")


def test_pca_biplot_vectors_toggle(page):
    # Verify vector toggle checkbox exists and toggle it
    vectors_chk = page.locator('[data-testid="pca-biplot-vectors"]')
    expect(vectors_chk).to_be_visible()
    vectors_chk.click()  # Uncheck
    page.wait_for_timeout(300)
    vectors_chk.click()  # Check back
    page.wait_for_timeout(300)


def test_pca_biplot_brush_selection(page):
    # Drag a rectangle on the Biplot canvas
    canvas = page.locator('[data-testid="pca-biplot-canvas"]')
    canvas.scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    box = canvas.bounding_box()
    assert box is not None

    # Drag across central region
    start_x = box["x"] + box["width"] * 0.2
    start_y = box["y"] + box["height"] * 0.2
    end_x = box["x"] + box["width"] * 0.8
    end_y = box["y"] + box["height"] * 0.8

    page.mouse.move(start_x, start_y)
    page.mouse.down()
    page.mouse.move(end_x, end_y, steps=5)
    page.mouse.up()
    page.wait_for_timeout(500)

    # Check that selection sidebar reflects selected rows (> 0)
    expect(page.locator('strong:has-text("選択行")')).not_to_contain_text("選択行 0")


def test_pca_matrix_view_and_brush(page):
    # Switch to PC Matrix mode
    page.locator('[data-testid="pca-view-mode"] label:has-text("主成分散布図行列")').click()
    page.wait_for_selector('[data-testid="pca-matrix-view"]')
    expect(page.locator('[data-testid="pca-matrix-canvas"]')).to_be_visible()

    # Drag brush on the matrix canvas
    canvas = page.locator('[data-testid="pca-matrix-canvas"]')
    canvas.scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    box = canvas.bounding_box()
    assert box is not None

    start_x = box["x"] + box["width"] * 0.55
    start_y = box["y"] + box["height"] * 0.05
    end_x = box["x"] + box["width"] * 0.72
    end_y = box["y"] + box["height"] * 0.22

    page.mouse.move(start_x, start_y)
    page.mouse.down()
    page.mouse.move(end_x, end_y, steps=5)
    page.mouse.up()
    page.wait_for_timeout(500)

    expect(page.locator('strong:has-text("選択行")')).not_to_contain_text("選択行 0")



def test_pca_propagation_to_pcp(page):
    # Navigate to PCP
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')

    # Verify selection remains active on PCP
    expect(page.locator('strong:has-text("選択行")')).not_to_contain_text("選択行 0")

