"""E2E test for Feature 09: Grand Tour / Tracking Grand Tour (TGT)."""
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


def test_tgt_navigation_and_elements(page):
    # Navigate to Touring tab
    page.locator('.ant-segmented-item:has-text("Touring")').click()
    page.wait_for_selector('[data-testid="tgt-page"]')

    # Verify Canvas, HUD, and Control elements are visible
    expect(page.locator('[data-testid="tgt-canvas"]')).to_be_visible()
    expect(page.locator('[data-testid="tgt-projection-circle"]')).to_be_visible()
    expect(page.locator('[data-testid="tgt-play-pause"]')).to_be_visible()
    expect(page.locator('[data-testid="tgt-step"]')).to_be_visible()
    expect(page.locator('[data-testid="tgt-reset"]')).to_be_visible()


def test_tgt_play_pause_toggle(page):
    # Initially playing: button says "一時停止 (Space)"
    btn = page.locator('[data-testid="tgt-play-pause"]')
    expect(btn).to_contain_text("一時停止")

    # Click to pause
    btn.click()
    page.wait_for_timeout(300)
    expect(btn).to_contain_text("再生")

    # Click step button while paused
    step_btn = page.locator('[data-testid="tgt-step"]')
    expect(step_btn).to_be_enabled()
    step_btn.click()
    page.wait_for_timeout(200)


def test_tgt_tracking_toggle(page):
    chk = page.locator('[data-testid="tgt-tracking-toggle"]')
    expect(chk).to_be_visible()
    chk.click()  # Uncheck
    page.wait_for_timeout(200)
    chk.click()  # Check back
    page.wait_for_timeout(200)


def test_tgt_brush_selection_when_paused(page):
    # Ensure tour is paused
    btn = page.locator('[data-testid="tgt-play-pause"]')
    if "一時停止" in btn.inner_text():
        btn.click()
        page.wait_for_timeout(300)

    canvas = page.locator('[data-testid="tgt-canvas"]')
    canvas.scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    box = canvas.bounding_box()
    assert box is not None

    # Drag across central region
    start_x = box["x"] + box["width"] * 0.35
    start_y = box["y"] + box["height"] * 0.35
    end_x = box["x"] + box["width"] * 0.65
    end_y = box["y"] + box["height"] * 0.65

    page.mouse.move(start_x, start_y)
    page.mouse.down()
    page.mouse.move(end_x, end_y, steps=5)
    page.mouse.up()
    page.wait_for_timeout(500)

    # Check that selection sidebar reflects selected rows (> 0)
    expect(page.locator('strong:has-text("選択行")')).not_to_contain_text("選択行 0")


def test_tgt_propagation_to_pcp(page):
    # Navigate to PCP
    page.locator('.ant-segmented-item:has-text("PCP")').click()
    page.wait_for_selector('[data-testid="pcp-canvas"]')

    # Verify selection remains active on PCP
    expect(page.locator('strong:has-text("選択行")')).not_to_contain_text("選択行 0")
