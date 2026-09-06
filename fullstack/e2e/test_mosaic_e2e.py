"""E2E test for Feature 10: Line Mosaic Plot."""
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


def test_mosaic_navigation_and_elements(page):
    # Navigate to Mosaic tab
    page.locator('.ant-segmented-item:has-text("Mosaic")').click()
    page.wait_for_selector('[data-testid="mosaic-page"]')

    # Verify Mosaic components
    expect(page.locator('[data-testid="mosaic-controls"]')).to_be_visible()
    expect(page.locator('[data-testid="mosaic-canvas"]')).to_be_visible()
    expect(page.locator('[data-testid="mosaic-cell-details"]')).to_be_visible()


def test_mosaic_cell_click_and_selection(page):
    canvas = page.locator('[data-testid="mosaic-canvas"]')
    canvas.scroll_into_view_if_needed()
    page.wait_for_timeout(300)

    # Click first interactive cell inside canvas
    # Each cell has cursor: pointer and is inside the canvas container
    first_cell = canvas.locator('div[style*="cursor: pointer"]').first
    expect(first_cell).to_be_visible()
    first_cell.click()
    page.wait_for_timeout(500)

    # Verify details card displays cell details
    details = page.locator('[data-testid="mosaic-cell-details"]')
    expect(details).to_contain_text("セル度数:")

    # Verify selection sidebar reflects selected rows (> 0)
    expect(page.locator('strong:has-text("選択行")')).not_to_contain_text("選択行 0")


def test_mosaic_target_selection(page):
    # Select target variable from dropdown if available
    target_sel = page.locator('[data-testid="mosaic-target-select"]')
    expect(target_sel).to_be_visible()
    target_sel.click()
    page.wait_for_timeout(300)

    # Click an option if dropdown opened
    opt = page.locator('.ant-select-dropdown :not(.ant-select-item-option-selected).ant-select-item-option').first
    if opt.is_visible():
        opt.click()
        page.wait_for_timeout(500)

    expect(page.locator('[data-testid="mosaic-canvas"]')).to_be_visible()


def test_mosaic_propagation_to_pcp(page):
    # Navigate to PCP
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')

    # Verify selection remains active on PCP
    expect(page.locator('strong:has-text("選択行")')).not_to_contain_text("選択行 0")
