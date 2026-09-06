"""E2E test for Feature 03: Sensitivity & Robustness Analysis."""
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


def test_robustness_diagnostics_and_views(page):
    # Navigate to Robustness tab
    page.locator('.ant-segmented-item:has-text("Robustness")').click()
    page.wait_for_selector('[data-testid="robustness-page"]')

    # Verify Scorecard, Tornado Plot, Quality Sweep Curve, and Influential table
    expect(page.locator('[data-testid="robustness-scorecard"]')).to_be_visible()
    expect(page.locator('[data-testid="perturbation-tornado-plot"]')).to_be_visible()
    expect(page.locator('[data-testid="quality-sweep-curve"]')).to_be_visible()
    expect(page.locator('[data-testid="top-influence-table"]')).to_be_visible()


def test_robustness_highlight_influential_pcp(page):
    # Highlight Influential Rows in PCP
    highlight_btn = page.locator('[data-testid="highlight-influential-pcp"]')
    expect(highlight_btn).to_be_visible()
    highlight_btn.click()
    page.wait_for_timeout(500)

    # Check that selection sidebar has selected rows
    expect(page.locator('strong:has-text("選択行")')).not_to_contain_text("選択行 0")
