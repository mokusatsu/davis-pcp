"""Playwright E2E tests for interactive Bar Chart."""
from __future__ import annotations

import os
import re
import pytest

BASE_URL = os.environ.get("DAVIS_PCP_URL", "http://127.0.0.1:8425")

pytest.importorskip("playwright")
from playwright.sync_api import expect, sync_playwright


@pytest.fixture(scope="module")
def page():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=["--disable-extensions", "--disable-component-update", "--no-sandbox"])
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        p = context.new_page()
        p.set_default_timeout(15000)
        p.goto(BASE_URL)
        p.wait_for_selector('[data-testid="plot-frame"]')
        yield p
        browser.close()


def test_barchart_navigation_and_elements(page) -> None:
    # Navigate to Bar Chart
    page.locator('.ant-segmented-item:has-text("Bar Chart")').click()
    page.wait_for_selector('[data-testid="barchart-page"]')
    page.wait_for_selector('[data-testid="barchart-svg"]', timeout=10000)

    expect(page.locator('[data-testid="barchart-col-select"]')).to_be_visible()
    expect(page.locator('[data-testid="barchart-selection-menu"]')).to_be_visible()
    expect(page.locator('[data-testid="focus-enter-barchart-container"]')).to_be_visible()
    expect(page.locator('[data-testid="barchart-bar-0"]')).to_be_visible()


def test_barchart_bar_click_and_propagation(page) -> None:
    page.locator('.ant-segmented-item:has-text("Bar Chart")').click()
    page.wait_for_selector('[data-testid="barchart-svg"]')

    # Clear previous selection if active
    clear_btn = page.locator('button:has-text("解除")')
    if clear_btn.is_enabled():
        clear_btn.click()
        page.wait_for_timeout(200)

    # Click first bar (e.g. Iris-setosa or similar category)
    bar0 = page.locator('[data-testid="barchart-bar-0"]')
    expect(bar0).to_be_visible()
    bar0.click()
    page.wait_for_timeout(400)

    # Check sidebar selection badge: exactly 50 rows in Iris for one species
    sidebar = page.locator('[data-testid="selected-sidebar"]')
    expect(sidebar).to_contain_text("選択行 50")

    # Navigate to PCP and verify selection propagates
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="plot-frame"]')
    expect(sidebar).to_contain_text("選択行 50")
