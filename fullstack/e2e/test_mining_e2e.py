"""E2E test for Feature 01: Automatic Subgroup Mining."""
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


def test_mining_navigation_and_results(page):
    # Navigate to Mining tab
    page.locator('.ant-segmented-item:has-text("Mining")').click()
    page.wait_for_selector('[data-testid="subgroup-mining-page"]')

    # Verify run button is visible
    expect(page.locator('[data-testid="mining-run-button"]')).to_be_visible()

    # Click Run Auto Mining
    page.locator('[data-testid="mining-run-button"]').click()
    page.wait_for_timeout(1000)

    # Verify insight cards and evidence details appear
    expect(page.locator('[data-testid="insight-card"]').first).to_be_visible()
    expect(page.locator('[data-testid="group-comparison-plot"]')).to_be_visible()


def test_mining_select_subgroup_pcp(page):
    # Click Select Subgroup in PCP button
    select_btn = page.locator('[data-testid="select-subgroup-pcp"]')
    expect(select_btn).to_be_visible()
    select_btn.click()
    page.wait_for_timeout(500)

    # Check that selection sidebar has selected rows
    expect(page.locator('strong:has-text("選択行")')).not_to_contain_text("選択行 0")


def test_mining_focus_pcp_pair(page):
    # Go back to Mining if needed
    page.locator('.ant-segmented-item:has-text("Mining")').click()
    page.wait_for_selector('[data-testid="focus-pcp-pair"]')

    # Click Focus PCP on this Pair
    page.locator('[data-testid="focus-pcp-pair"]').click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')

    # Check that PCP is displayed and selection is retained
    expect(page.locator('strong:has-text("選択行")')).not_to_contain_text("選択行 0")
