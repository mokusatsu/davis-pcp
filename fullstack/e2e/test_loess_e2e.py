"""Playwright E2E tests for Loess Curve Fitting and Outlier Selection."""
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


def test_loess_navigation_and_elements(page) -> None:
    # Navigate to Loess
    page.locator('.ant-segmented-item:has-text("Loess")').click()
    page.wait_for_selector('[data-testid="loess-page"]')
    page.wait_for_selector('[data-testid="loess-svg"]', timeout=10000)

    expect(page.locator('[data-testid="loess-x-select"]')).to_be_visible()
    expect(page.locator('[data-testid="loess-y-select"]')).to_be_visible()
    expect(page.locator('[data-testid="loess-selection-menu"]')).to_be_visible()
    expect(page.locator('[data-testid="focus-enter-loess-container"]')).to_be_visible()
    expect(page.locator('[data-testid="loess-select-outliers"]')).to_be_visible()


def test_loess_outlier_selection_and_propagation(page) -> None:
    page.locator('.ant-segmented-item:has-text("Loess")').click()
    page.wait_for_selector('[data-testid="loess-svg"]')

    # Clear previous selection if active
    clear_btn = page.locator('button:has-text("解除")')
    if clear_btn.is_enabled():
        clear_btn.click()
        page.wait_for_timeout(200)

    # Click outlier selection button
    outlier_btn = page.locator('[data-testid="loess-select-outliers"]')
    expect(outlier_btn).to_be_visible()
    outlier_btn.click()
    page.wait_for_timeout(400)

    # Check sidebar
    sidebar = page.locator('[data-testid="selected-sidebar"]')
    expect(sidebar).to_contain_text(re.compile(r"選択行 [0-9]+"))

    # Navigate to PCP and verify
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="plot-frame"]')
    expect(sidebar).to_contain_text(re.compile(r"選択行 [0-9]+"))
