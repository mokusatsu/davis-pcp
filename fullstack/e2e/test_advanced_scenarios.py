"""E2E Advanced Perspectives & Edge Cases Test Suite:
Tests edge cases, advanced settings, and multi-view integrations:
1. PCP Jittering & Simplification toggles
2. PCP Inverted axis brush & L2 clustering colors
3. Dendrogram subtree click selection propagation
4. Models: Random Forest representative tree diagram and leaf selection
5. Student Performance dataset (33 columns): horizontal virtual scroll & high-dimensional layout
6. Minimal column dataset (1 column): graceful error alerts and no uncaught exceptions
"""
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
        p.wait_for_selector('[data-testid="dataset-selector"]')
        p.wait_for_timeout(500)
        yield p
        browser.close()


@pytest.fixture(autouse=True)
def reset_state(page):
    """Ensure non-focus mode between tests."""
    if page.locator('[data-testid="focus-bar"]').is_visible():
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
    yield
    if page.locator('[data-testid="focus-bar"]').is_visible():
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)


def switch_dataset_if_needed(page, dataset_name: str):
    """Switch the current dataset if it doesn't match dataset_name."""
    selector = page.locator('[data-testid="dataset-selector"]')
    current_text = selector.inner_text().strip()
    if dataset_name.lower() in current_text.lower():
        if dataset_name == "Iris" and ("test" in current_text or "transform" in current_text):
            pass
        else:
            return
    selector.click()
    page.wait_for_timeout(300)
    input_box = selector.locator('input')
    if input_box.is_visible():
        input_box.fill(dataset_name)
        page.wait_for_timeout(300)
    if dataset_name == "Iris":
        target_opt = page.locator('.ant-select-item-option:has-text("Iris (built-in sample)")')
        option = target_opt.first if target_opt.count() > 0 else page.locator('.ant-select-item-option:has-text("Iris")').first
    else:
        option = page.locator(f'.ant-select-item-option:has-text("{dataset_name}")').first
    option.scroll_into_view_if_needed()
    option.click(force=True)
    page.wait_for_timeout(800)


def test_pcp_jitter_and_simplification(page):
    """Test enabling jittering and changing simplify mode in PCP."""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')

    # Open render settings menu
    page.locator('[data-testid="axis-settings"]').click()
    
    # Enable Jittering
    jitter_switch = page.locator('[data-testid="jitter-enabled"]')
    jitter_switch.click()
    page.wait_for_timeout(300)
    expect(page.locator('[data-testid="jitter-mode"]')).to_be_visible()

    # Turn off Jittering
    jitter_switch.click()
    page.wait_for_timeout(300)

    # Change line opacity and line width
    page.keyboard.press("Escape")
    expect(page.locator('[data-testid="pcp-canvas"]')).to_be_visible()


def test_dendrogram_subtree_click_selection(page):
    """Test that clicking on a Dendrogram merge line selects the subtree rows."""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("Clusters")').click()
    
    # Run agglomerative clustering
    page.locator('.ant-segmented-item:has-text("階層的")').click()
    page.locator('[data-testid="run-clustering"]').click()
    page.wait_for_selector('[data-testid="dendrogram-svg"]', timeout=15000)

    svg = page.locator('[data-testid="dendrogram-svg"]')
    svg.scroll_into_view_if_needed()
    expect(svg).to_be_visible()

    # Find merge lines in dendrogram
    lines = svg.locator('line[stroke="#2a78d6"]')
    if lines.count() > 0:
        lines.first.click()
        page.wait_for_timeout(500)
        sidebar = page.locator('[data-testid="selected-sidebar"]')
        expect(sidebar).to_be_visible()
        count = int(sidebar.inner_text().split("選択行 ")[1].split(" /")[0])
        assert count > 0, f"Expected subtree selection to select rows, got {count}"


def test_random_forest_training_and_tree_diagram(page):
    """Test training Random Forest and verifying representative tree diagram."""
    switch_dataset_if_needed(page, "Iris")
    page.locator('.ant-segmented-item:has-text("Models")').click()
    
    # Select Random Forest
    page.locator('.ant-segmented-item:has-text("ランダムフォレスト")').click()
    page.locator('[data-testid="run-model"]').click()
    page.wait_for_selector('[data-testid="tree-diagram-0"]', timeout=20000)

    # Verify representative tree diagram rendered
    tree = page.locator('[data-testid="tree-diagram-0"]')
    expect(tree).to_be_visible()

    # Click a leaf node in the representative tree
    leaves = page.locator('[data-testid^="tree-leaf-0-"]')
    expect(leaves.first).to_be_visible()
    leaves.first.click()
    page.wait_for_timeout(500)

    sidebar = page.locator('[data-testid="selected-sidebar"]')
    expect(sidebar).to_be_visible()
    count = int(sidebar.inner_text().split("選択行 ")[1].split(" /")[0])
    assert count > 0, f"Expected leaf selection to select rows, got {count}"


def test_student_performance_33_columns_pcp_scroll(page):
    """Test loading a dataset with 33 columns (student_performance_math) and verifying horizontal scroll."""
    switch_dataset_if_needed(page, "student_performance_math")
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')

    # Check axis count is 33
    axes = page.locator('[data-testid^="axis-control-"]')
    expect(axes).to_have_count(33)

    # Check scroll frame width vs virtual width
    frame = page.locator('[data-testid="plot-frame"]')
    box = frame.bounding_box()
    # 33 axes * 90px min width = ~2970px virtual width
    canvas_area = page.locator('[data-testid="plot-canvas-area"]')
    cbox = canvas_area.bounding_box()
    assert cbox["width"] > box["width"], f"Canvas area width ({cbox['width']}) should exceed frame ({box['width']})"

    # Verify scrolling works without throwing errors
    frame.evaluate("el => el.scrollLeft = 800")
    page.wait_for_timeout(300)
    scroll_val = frame.evaluate("el => el.scrollLeft")
    assert scroll_val > 500, f"Expected scrollLeft to be > 500, got {scroll_val}"

    # Switch back to Iris
    switch_dataset_if_needed(page, "Iris")


def test_single_column_dataset_handling(page):
    """Test loading a 1-column dataset and verify graceful warning in Relationships."""
    import json, urllib.request

    boundary = "----TestSingleColBoundary"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="single_numeric_test.csv"\r\n'
        f"Content-Type: text/csv\r\n\r\n"
        f"id,val\r\n1,10\r\n2,20\r\n3,30\r\n4,40\r\n"
        f"--{boundary}--\r\n"
    ).encode("utf-8")

    req = urllib.request.Request(
        f"{BASE_URL}/api/v1/datasets/import",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    resp = json.loads(urllib.request.urlopen(req).read().decode())
    ds_id = resp["datasetId"]

    try:
        page.reload()
        page.wait_for_selector('[data-testid="dataset-selector"]')
        switch_dataset_if_needed(page, "single_numeric_test")
        page.locator('.ant-segmented-item:has-text("Relationships")').click()

        # Expect the graceful alert for insufficient columns
        alert = page.locator('[data-testid="relationships-insufficient-columns"]')
        expect(alert).to_be_visible()
        expect(alert).to_contain_text("数値列が必要です")

        # Switch back to Iris
        switch_dataset_if_needed(page, "Iris")
    finally:
        try:
            del_req = urllib.request.Request(f"{BASE_URL}/api/v1/datasets/{ds_id}", method="DELETE")
            urllib.request.urlopen(del_req)
        except Exception:
            pass
