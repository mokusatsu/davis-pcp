"""E2E test for Feature 05: Penalty-Reward Analysis (PRA)."""
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


def test_pra_diagnostics_and_views(page):
    # Navigate to Penalty-Reward tab
    page.locator('.ant-segmented-item:has-text("Penalty-Reward")').click()
    page.wait_for_selector('[data-testid="penalty-reward-page"]')

    # Verify Kano 4-Quadrant Board, Diverging Bars, and Asymmetry Table
    expect(page.locator('[data-testid="kano-quadrant-board"]')).to_be_visible()
    expect(page.locator('[data-testid="diverging-impact-bars"]')).to_be_visible()
    expect(page.locator('[data-testid="asymmetry-test-table"]')).to_be_visible()


def test_pra_select_dissatisfied_pcp(page):
    # Select dissatisfied customers button
    dissatisfied_btn = page.locator('[data-testid="select-dissatisfied-all"]')
    expect(dissatisfied_btn).to_be_visible()
    dissatisfied_btn.click()
    page.wait_for_timeout(500)

    # Check selection sidebar
    expect(page.locator('strong:has-text("選択行")')).not_to_contain_text("選択行 0")


def test_pra_project_kano_axes(page):
    # Navigate to Penalty-Reward tab
    page.locator('.ant-segmented-item:has-text("Penalty-Reward")').click()
    page.wait_for_selector('[data-testid="penalty-reward-page"]')

    # Click Project Kano Axes to PCP
    project_btn = page.locator('[data-testid="project-kano-axes-btn"]')
    expect(project_btn).to_be_visible()
    project_btn.click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')
    expect(page.locator('[data-testid="pcp-canvas"]')).to_be_visible()
