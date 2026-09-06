"""E2E test for Feature 02: Surprise-First Association Scoring."""
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


def test_surprise_quadrant_and_heatmap(page):
    # Navigate to Surprise tab
    page.locator('.ant-segmented-item:has-text("Surprise")').click()
    page.wait_for_selector('[data-testid="surprise-association-view"]')

    # Verify Quadrant plot is visible
    expect(page.locator('[data-testid="surprise-quadrant-plot"]')).to_be_visible()
    expect(page.locator('[data-testid="top-lift-inspector"]')).to_be_visible()

    # Switch to Heatmap mode
    page.locator('[data-testid="surprise-view-mode"] label:has-text("Heatmap")').click()
    page.wait_for_selector('[data-testid="surprise-heatmap"]')
    expect(page.locator('[data-testid="surprise-heatmap"]')).to_be_visible()


def test_surprise_select_lift_pcp(page):
    # Select Lift Cell Rows in PCP
    select_btn = page.locator('[data-testid="select-lift-pcp"]')
    if select_btn.is_enabled():
        select_btn.click()
        page.wait_for_timeout(500)
        expect(page.locator('strong:has-text("選択行")')).not_to_contain_text("選択行 0")
