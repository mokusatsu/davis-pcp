"""E2E test for Feature 04: Key Driver Analysis (KDA)."""
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


def test_kda_diagnostics_and_views(page):
    # Navigate to Key Drivers tab
    page.locator('.ant-segmented-item:has-text("Key Drivers")').click()
    page.wait_for_selector('[data-testid="kda-page"]')

    # Verify Importance chart, contrast table, and what-if simulator
    expect(page.locator('[data-testid="kda-importance-chart"]')).to_be_visible()
    expect(page.locator('[data-testid="kda-contrast-table"]')).to_be_visible()
    expect(page.locator('[data-testid="kda-whatif-simulator"]')).to_be_visible()


def test_kda_project_pcp_axes(page):
    # Project Top 3 Drivers to PCP Axes
    project_btn = page.locator('[data-testid="project-pcp-axes-btn"]')
    expect(project_btn).to_be_visible()
    project_btn.click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')

    # Verify PCP canvas is visible and active
    expect(page.locator('[data-testid="pcp-canvas"]')).to_be_visible()
