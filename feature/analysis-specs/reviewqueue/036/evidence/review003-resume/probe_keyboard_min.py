# N001-04 キーボード遷移の最小再現: 1キーごとにactiveElementと開閉状態を出す。
# 製品コード変更は行わない。観察専用。
import json
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8420"
OUT = ".temp/header-navigation/minimal-key-sequence.json"

logs = []


def snap(page, label):
    logs.append({
        "label": label,
        "url": page.url,
        "focus": page.evaluate("""() => { const a = document.activeElement;
            return {tag: a?.tagName, cls: a?.className?.slice?.(0,80), text: a?.textContent?.trim()?.slice(0,30),
                    menuId: a?.getAttribute?.('data-menu-id'), label: a?.getAttribute?.('aria-label')} }"""),
        "expanded": page.evaluate("""() => [...document.querySelectorAll('nav .ant-menu-submenu-title')]
            .filter(el => el.getAttribute('aria-expanded') === 'true').map(el => el.textContent.trim())"""),
        "popupVisible": page.evaluate("""() => [...document.querySelectorAll('body > div')].some(d =>
            typeof d.className === 'string' && d.className.includes('feature-navigation-popup') && d.offsetParent !== null)"""),
    })


with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    page.goto(BASE + "/", wait_until="domcontentloaded")
    page.wait_for_selector("nav", state="visible", timeout=30000)
    page.bring_to_front()
    page.wait_for_timeout(1000)

    # 実Tabでナビへ到達
    for i in range(80):
        page.keyboard.press("Tab")
        cls = page.evaluate("() => document.activeElement?.className ?? ''")
        if "feature-navigation-menu" in cls:
            break
    snap(page, "nav-focused")

    # ArrowRight x1 (PCP初期 → データ・概要 へ), Enterで開く
    page.keyboard.press("ArrowRight")
    snap(page, "arrow-right-1")
    page.keyboard.press("Enter")
    page.wait_for_timeout(400)
    snap(page, "enter-open")

    # ArrowDown で葉へ
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(200)
    snap(page, "arrow-down-1")

    # Escape → 分類へ復帰するか
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    snap(page, "escape-1")

    # 再度開いて ArrowDown x2 → Enter (2番目の葉=データ概要…ではなく1番目=Table?)
    page.keyboard.press("Enter")
    page.wait_for_timeout(400)
    snap(page, "reenter-open")
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(150)
    snap(page, "arrow-down-2")
    page.keyboard.press("Enter")
    page.wait_for_timeout(600)
    snap(page, "enter-select")

    # 遷移していなければ、もう一度 Enter を押して観察
    if "/table" not in page.url:
        page.keyboard.press("Enter")
        page.wait_for_timeout(600)
        snap(page, "enter-select-2")

    browser.close()

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(logs, f, ensure_ascii=False, indent=2)
print(json.dumps(logs, ensure_ascii=False, indent=1))
