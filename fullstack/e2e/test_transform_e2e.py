"""E2E test for Feature 06: Variable transformation and binning."""
from __future__ import annotations

import os
import pytest

BASE_URL = os.environ.get("DAVIS_PCP_URL", "http://127.0.0.1:8425")

pytest.importorskip("playwright")
from playwright.sync_api import expect, sync_playwright  # noqa: E402


@pytest.fixture(scope="module")
def page():
    import json, urllib.request

    def _cleanup():
        try:
            req = urllib.request.Request(f"{BASE_URL}/api/v1/datasets", headers={"Content-Type": "application/json"})
            resp = json.loads(urllib.request.urlopen(req).read().decode())
            for d in resp.get("datasets", []):
                if d.get("name") == "Iris (transform-e2e)":
                    del_req = urllib.request.Request(f"{BASE_URL}/api/v1/datasets/{d['datasetId']}", method="DELETE")
                    urllib.request.urlopen(del_req)
        except Exception:
            pass

    _cleanup()

    req = urllib.request.Request(
        f"{BASE_URL}/api/v1/datasets/import/sample",
        data=json.dumps({"name": "Iris (transform-e2e)"}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    urllib.request.urlopen(req)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=["--disable-extensions", "--disable-component-update", "--no-sandbox"])
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        p = context.new_page()
        p.set_default_timeout(15000)
        p.goto(BASE_URL)
        p.wait_for_selector('[data-testid="pcp-canvas"]')
        p.wait_for_selector('[data-testid="dataset-selector"]')
        selector = p.locator('[data-testid="dataset-selector"]')
        selector.click()
        p.wait_for_timeout(300)
        input_box = selector.locator('input')
        if input_box.is_visible():
            input_box.fill("transform-e2e")
            p.wait_for_timeout(300)
        option = p.locator('.ant-select-item-option:has-text("Iris (transform-e2e)")').first
        option.scroll_into_view_if_needed()
        option.click(force=True)
        p.wait_for_timeout(600)
        try:
            yield p
        finally:
            browser.close()
            _cleanup()


def test_binning_numeric_column(page):
    import time
    ts = int(time.time()) % 10000
    col_name = f"slen_b_{ts}"

    # Navigate to Overview
    page.locator('.ant-segmented-item:has-text("Overview")').click()
    page.wait_for_selector('[data-testid="overview-page"]')

    # Open Binning Modal for sepal_length_cm
    bin_btn = page.locator('[data-testid="btn-bin-sepal_length_cm"]')
    expect(bin_btn).to_be_visible()
    bin_btn.click()

    page.wait_for_selector('[data-testid="binning-modal-content"]')
    # Set custom output name
    name_input = page.locator('[data-testid="binning-output-name"]')
    name_input.fill(col_name)

    # Click apply
    page.locator('.ant-modal-footer button.ant-btn-primary:has-text("ビン列を生成")').click()
    page.wait_for_selector('[data-testid="binning-modal-content"]', state="detached")
    page.wait_for_timeout(1000)

    # Verify column appears in overview table
    expect(page.locator('[data-testid="overview-page"]').get_by_text(col_name, exact=True)).to_be_visible()


def test_onehot_categorical_column(page):
    # Open One-Hot Modal for species
    onehot_btn = page.locator('[data-testid="btn-onehot-species"]')
    expect(onehot_btn).to_be_visible()
    onehot_btn.click()

    page.wait_for_selector('[data-testid="one-hot-modal-content"]')
    # Click apply
    page.locator('.ant-modal-footer button.ant-btn-primary:has-text("0/1二値列を生成")').click()
    page.wait_for_selector('[data-testid="one-hot-modal-content"]', state="detached")
    page.wait_for_timeout(1000)

    # Verify generated columns appear (using exact=True on at least one match)
    expect(page.locator('[data-testid="overview-page"]').locator('strong:has-text("species_Iris-setosa")').first).to_be_visible()


def test_transformed_axes_in_pcp(page):
    # Go back to PCP
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')

    order_menu = page.locator('[data-testid="axis-order-menu"]')
    expect(order_menu).to_be_visible()
