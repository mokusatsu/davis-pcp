"""E2E test for Missing Values Imputation (TabDiff) and Dynamic Variable Addition (AST)."""
from __future__ import annotations

import os
import pytest

BASE_URL = os.environ.get("DAVIS_PCP_URL", "http://127.0.0.1:8425")

pytest.importorskip("playwright")
from playwright.sync_api import expect, sync_playwright  # noqa: E402


@pytest.fixture(scope="module")
def page():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--disable-extensions", "--disable-component-update", "--no-sandbox"],
        )
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        page.set_default_timeout(15000)
        page.goto(BASE_URL)
        page.wait_for_selector('[data-testid="pcp-canvas"]')
        yield page
        browser.close()


def test_overview_buttons_visible(page):
    page.locator('.ant-segmented-item:has-text("Overview")').click()
    page.wait_for_selector('[data-testid="overview-page"]')
    expect(page.locator('[data-testid="btn-open-imputation"]')).to_be_visible()
    expect(page.locator('[data-testid="btn-open-add-variable"]')).to_be_visible()


def test_add_calculated_variable(page):
    # Click button to open Add Variable modal
    page.locator('[data-testid="btn-open-add-variable"]').click()
    page.wait_for_selector('[data-testid="input-new-variable-name"]')

    # Fill in column name
    name_input = page.locator('[data-testid="input-new-variable-name"]')
    name_input.fill("petal_ratio")

    # Fill in formula expression using valid Iris columns
    expr_input = page.locator('[data-testid="input-variable-expression"]')
    expr_input.fill("petal_length_cm / (petal_width_cm + 1e-6)")

    # Click preview validation button
    page.locator('button:has-text("プレビュー検証")').click()
    page.wait_for_selector('.ant-alert-success')

    # Submit new variable
    page.locator('[data-testid="btn-add-variable-submit"]').click()
    page.wait_for_selector('[data-testid="input-new-variable-name"]', state="detached")
    page.wait_for_timeout(1000)

    # Verify petal_ratio is listed in the variables table
    expect(page.locator('td:has-text("petal_ratio")')).to_be_visible()

    # Navigate to PCP tab and verify the new axis is present
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')
    expect(page.locator('[data-testid="axis-control-petal_ratio"]')).to_be_visible()


def test_imputation_modal_flow(page):
    # Go back to Overview
    page.locator('.ant-segmented-item:has-text("Overview")').click()
    page.wait_for_selector('[data-testid="btn-open-imputation"]')

    # Open Imputation Modal
    page.locator('[data-testid="btn-open-imputation"]').click()
    page.wait_for_selector('[data-testid="impute-strategy"]')

    # Verify TabDiff strategy is selected
    expect(page.locator('.ant-segmented-item-selected:has-text("TabDiff")')).to_be_visible()

    # Cancel/Close modal
    page.locator('.ant-modal-footer button:has-text("キャンセル")').click()
    page.wait_for_selector('[data-testid="impute-strategy"]', state="detached")
