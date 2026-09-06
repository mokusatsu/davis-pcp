"""E2E test for Feature 07: QQ-Plot and linked brushing."""
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


def test_qqplot_view_and_diagnostics(page):
    # Navigate to Distribution
    page.locator('.ant-segmented-item:has-text("Distribution")').click()
    page.wait_for_selector('[data-testid="dist-view-mode"]')

    # Switch to QQ-Plot tab
    page.locator('[data-testid="dist-view-mode"] label:has-text("QQ-Plot")').click()
    page.wait_for_selector('[data-testid="qqplot-view"]')

    # Verify canvas and diagnostics card
    expect(page.locator('[data-testid="qqplot-canvas"]')).to_be_visible()
    expect(page.locator('[data-testid="qqplot-diagnostics"]')).to_be_visible()
    expect(page.locator('[data-testid="qqplot-diagnostics"]')).to_contain_text("Shapiro-Wilk")


def test_qqplot_brush_selection(page):
    # Drag a rectangle on the QQ-Plot canvas
    canvas = page.locator('[data-testid="qqplot-canvas"]')
    box = canvas.bounding_box()
    assert box is not None

    # Drag across a region containing points (e.g. upper right)
    start_x = box["x"] + box["width"] * 0.6
    start_y = box["y"] + box["height"] * 0.1
    end_x = box["x"] + box["width"] * 0.95
    end_y = box["y"] + box["height"] * 0.5

    page.mouse.move(start_x, start_y)
    page.mouse.down()
    page.mouse.move(end_x, end_y, steps=5)
    page.mouse.up()
    page.wait_for_timeout(500)

    # Check that selection sidebar reflects selected rows (> 0)
    sidebar_text = page.locator('strong:has-text("選択行")').inner_text()
    assert "選択行 0" not in sidebar_text, f"Expected some rows selected, got {sidebar_text}"


def test_qqplot_propagation_to_pcp(page):
    # Go to PCP
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')

    # Verify selection remains active
    sidebar_text = page.locator('strong:has-text("選択行")').inner_text()
    assert "選択行 0" not in sidebar_text
