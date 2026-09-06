"""E2E test for Cobweb Concept Formation and DISC (AAAI 2026) clustering."""
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


def test_cobweb_clustering_and_concept_tree(page):
    # Navigate to Clusters tab
    page.locator('.ant-segmented-item:has-text("Clusters")').click()
    page.wait_for_selector('[data-testid="cluster-method"]')

    # Select Cobweb
    page.locator('.ant-segmented-item:has-text("Cobweb")').click()
    expect(page.locator('[data-testid="cobweb-acuity"]')).to_be_visible()
    expect(page.locator('[data-testid="cobweb-cutoff"]')).to_be_visible()

    # Run Cobweb clustering
    page.locator('[data-testid="run-clustering"]').click()
    page.wait_for_selector('[data-testid="cobweb-tree-panel"]', timeout=15000)

    # Check that concept hierarchy nodes exist
    node_buttons = page.locator('[data-testid^="select-cobweb-node-"]')
    expect(node_buttons.first).to_be_visible()
    assert node_buttons.count() > 0

    # Click first concept selection button and verify row selection propagation
    node_buttons.first.click()
    page.wait_for_timeout(500)
    sidebar = page.locator('[data-testid="selected-sidebar"]').inner_text()
    assert "選択行 " in sidebar
    count = int(sidebar.split("選択行 ")[1].split(" /")[0])
    assert count > 0


def test_disc_clustering_and_category_matrix(page):
    # Switch to DISC (AAAI 2026)
    page.locator('.ant-segmented-item:has-text("DISC (AAAI 2026)")').click()
    expect(page.locator('[data-testid="disc-alpha"]')).to_be_visible()
    expect(page.locator('[data-testid="disc-num-weight"]')).to_be_visible()

    # Run DISC clustering
    page.locator('[data-testid="run-clustering"]').click()
    page.wait_for_selector('[data-testid="disc-matrix-panel"]', timeout=20000)

    # Check that the heatmap table is rendered
    expect(page.locator('[data-testid="disc-heatmap-table"]')).to_be_visible()

    # Check cluster selector and attribute selector
    cluster_select = page.locator('[data-testid="disc-cluster-select"]')
    expect(cluster_select).to_be_visible()
    attr_select = page.locator('[data-testid="disc-attr-select"]')
    expect(attr_select).to_be_visible()

    # Check cluster selection button works
    page.locator('[data-testid="cluster-0"]').click()
    page.wait_for_timeout(500)
    sidebar = page.locator('[data-testid="selected-sidebar"]').inner_text()
    count = int(sidebar.split("選択行 ")[1].split(" /")[0])
    assert count > 0
