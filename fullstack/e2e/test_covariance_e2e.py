"""Playwright E2E tests for Covariance Matrix and Precision Matrix Suite."""
from __future__ import annotations

import os
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


def test_covariance_navigation_and_elements(page) -> None:
    # Navigate to Covariance tab
    page.locator('.ant-segmented-item:has-text("Covariance")').click()
    page.wait_for_selector('[data-testid="covariance-page"]')
    page.wait_for_selector('[data-testid="covariance-matrix"]', timeout=10000)

    expect(page.locator('label:has([data-testid="covariance-mode-cov"])')).to_be_visible()
    expect(page.locator('label:has([data-testid="covariance-mode-corr"])')).to_be_visible()
    expect(page.locator('label:has([data-testid="covariance-mode-prec"])')).to_be_visible()
    expect(page.locator('[data-testid="covariance-cell-0-0"]')).to_be_visible()


def test_covariance_mode_toggle_and_cell_click(page) -> None:
    page.locator('.ant-segmented-item:has-text("Covariance")').click()
    page.wait_for_selector('[data-testid="covariance-matrix"]')

    # Toggle to correlation mode
    page.locator('label:has([data-testid="covariance-mode-corr"])').click()
    page.wait_for_timeout(300)
    # In correlation mode diagonal is 1.00
    diag_cell = page.locator('[data-testid="covariance-cell-0-0"]')
    expect(diag_cell).to_contain_text("1.00")

    # Toggle to precision mode
    page.locator('label:has([data-testid="covariance-mode-prec"])').click()
    page.wait_for_timeout(300)
    expect(diag_cell).to_contain_text("1.00")

    # Click an off-diagonal cell
    cell01 = page.locator('[data-testid="covariance-cell-0-1"]')
    expect(cell01).to_be_visible()
    cell01.click()
    page.wait_for_timeout(300)

    # Verify action buttons appear
    project_btn = page.locator('button:has-text("PCPでこの2軸を先頭配置")')
    expect(project_btn).to_be_visible()
    project_btn.click()
    page.wait_for_timeout(400)

    # Check navigated to PCP
    page.wait_for_selector('[data-testid="plot-frame"]')
