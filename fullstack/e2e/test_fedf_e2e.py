"""Playwright E2E tests for FEDF (Flipped Empirical Distribution Function / Parallel FEDF)."""
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


def test_fedf_navigation_and_elements(page) -> None:
    # Navigate to FEDF tab
    page.locator('.ant-segmented-item:has-text("FEDF")').click()
    page.wait_for_selector('[data-testid="fedf-page"]')
    page.wait_for_selector('[data-testid="fedf-svg"]', timeout=10000)

    # Check axes rendered
    expect(page.locator('[data-testid="fedf-axis-0"]')).to_be_visible()
    expect(page.locator('[data-testid="fedf-selection-menu"]')).to_be_visible()
    expect(page.locator('[data-testid="focus-enter-fedf-container"]')).to_be_visible()


def test_fedf_mode_toggle(page) -> None:
    page.locator('.ant-segmented-item:has-text("FEDF")').click()
    page.wait_for_selector('[data-testid="fedf-svg"]')

    # Toggle to Mountain folded mode
    page.locator('label:has([data-testid="fedf-mode-folded"])').click()
    page.wait_for_timeout(300)
    expect(page.locator('label:has([data-testid="fedf-mode-folded"])')).to_have_class(re.compile(r"ant-radio-button-wrapper-checked"))

    # Toggle back to standard
    page.locator('label:has([data-testid="fedf-mode-standard"])').click()
    page.wait_for_timeout(300)
    expect(page.locator('label:has([data-testid="fedf-mode-standard"])')).to_have_class(re.compile(r"ant-radio-button-wrapper-checked"))


def test_fedf_preset_and_propagation(page) -> None:
    page.locator('.ant-segmented-item:has-text("FEDF")').click()
    page.wait_for_selector('[data-testid="fedf-svg"]')

    # Clear any previous selection if active
    clear_btn = page.locator('button:has-text("解除")')
    if clear_btn.is_enabled():
        clear_btn.click()
        page.wait_for_timeout(200)

    # Click IQR 25-75% preset button on first axis
    iqr_btn = page.locator('[data-testid="fedf-select-iqr"]').first
    expect(iqr_btn).to_be_visible()
    iqr_btn.click()
    page.wait_for_timeout(400)

    # Verify rows selected in sidebar badge
    sidebar_badge = page.locator('[data-testid="selected-sidebar"]')
    expect(sidebar_badge).to_contain_text(re.compile(r"選択行 [1-9][0-9]*"))

    # Navigate to PCP and ensure selection is reflected
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="plot-frame"]')
    expect(sidebar_badge).to_contain_text(re.compile(r"選択行 [1-9][0-9]*"))
