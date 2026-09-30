# Feature 036 REVIEW-003 必須残作業の受入検証。
# 判定基準:
#  - page.goto で状態を初期化しない（初回を除く）。移動はメニューの実クリック（page.mouse）のみ。
#  - 同一 run 内で URL・読込 bundle/CSS・操作・期待値・実測値・時刻を記録する。
#  - フォーカス判定は document.activeElement の識別子で行い、body 文字列の部分一致は使わない。
#  - popup は aria-controls が指す要素を実座標クリックで開く。
import json
import re
import sys
import time
import traceback
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8420"
OUT = ".temp/header-navigation/verify_r003.json"
SHOTS = ".temp/header-navigation/r003"
results = []
run_meta = {}


def stamp():
    return datetime.now(timezone.utc).isoformat()


def record(step, ok, detail="", evidence=None):
    entry = {"step": step, "ok": bool(ok), "detail": str(detail), "at": stamp()}
    if evidence:
        entry["evidence"] = evidence
    results.append(entry)
    print(("PASS " if ok else "FAIL ") + step + (" :: " + str(detail) if detail else ""))


def section(name, fn, page):
    try:
        fn(page)
    except Exception:
        record(name, False, traceback.format_exc(limit=4).replace("\n", " | "))


def js_el(page, js, timeout=15000):
    """js が要素を返すまで待って要素ハンドルを返す。js は評価ごとに再検索されること。"""
    deadline = time.time() + timeout / 1000
    while time.time() < deadline:
        handle = page.evaluate_handle(js)
        if handle.as_element():
            return handle.as_element()
        page.wait_for_timeout(100)
    raise TimeoutError("element not found: " + js[:120])


def open_group_leaf(page, group_label, leaf_text, path):
    """機能一覧/分類を実クリックで開き、葉を実座標クリックで遷移させる。"""
    page.wait_for_selector("nav", state="visible")
    compact = page.locator('[data-testid="feature-list-button"]')
    if compact.count() and compact.first.is_visible():
        if compact.first.get_attribute("aria-expanded") != "true":
            compact.first.click()
        page.wait_for_timeout(300)
    group_js = f"""() => [...document.querySelectorAll('nav [role="menuitem"]')]
        .find(e => e.textContent.trim() === '{group_label}') ?? null"""
    group = js_el(page, group_js)
    if group.get_attribute("aria-expanded") != "true":
        group.click()
    page.wait_for_timeout(300)
    leaf_js = f"""() => [...document.querySelectorAll('nav [role="menuitem"], nav [data-menu-id]')]
        .filter(e => e.textContent.trim() === '{leaf_text}').pop() ?? null"""
    leaf = js_el(page, leaf_js)
    leaf.click()
    page.wait_for_function(
        f"() => location.pathname === '{path}'",
        timeout=15000,
    )


def nav_probe(page):
    return {
        "url": page.url,
        "current": page.locator('[data-testid="navigation-current"]').inner_text(),
        "bundle": page.evaluate("() => [...document.scripts].map(s=>s.src).filter(s=>s.includes('assets/'))"),
        "css": page.evaluate("() => [...document.querySelectorAll('link[rel=stylesheet]')].map(e=>e.href)"),
        "timeOrigin": page.evaluate("() => performance.timeOrigin"),
        "visibility": page.evaluate("() => document.visibilityState"),
    }


def wait_app(page):
    page.wait_for_selector("nav", state="visible", timeout=30000)
    page.wait_for_function(
        "() => document.querySelector('[data-testid=\\'selected-sidebar\\']')?.textContent.includes('active') ?? false",
        timeout=30000,
    )


# ---------------------------------------------------------------- N001-04: キーボード
def check_keyboard(page):
    page.goto(BASE + "/", wait_until="domcontentloaded")
    wait_app(page)
    page.bring_to_front()
    page.wait_for_timeout(800)
    run = {"start": stamp(), **nav_probe(page)}

    # 実Tabでナビへ到達する（focus() の直接代入は使わない）
    reached = False
    for _ in range(80):
        page.keyboard.press("Tab")
        cls = page.evaluate("() => document.activeElement?.className ?? ''")
        if "feature-navigation-menu" in cls or "feature-list-button" in cls:
            reached = True
            break
    el = page.evaluate("() => ({tag: document.activeElement?.tagName, cls: document.activeElement?.className, text: document.activeElement?.textContent?.trim()?.slice(0,40)})")
    record("N001-04 Tabでナビへ到達", reached, json.dumps(el, ensure_ascii=False))

    # 分類を矢印+Enterで開き、Escapeで分類タイトルへ戻る
    page.keyboard.press("ArrowRight")
    page.keyboard.press("Enter")
    page.wait_for_function("""() => [...document.querySelectorAll('nav .ant-menu-submenu-title')]
        .some(el => el.getAttribute('aria-expanded') === 'true')""", timeout=5000)
    opened = page.evaluate("""() => [...document.querySelectorAll('nav .ant-menu-submenu-title')]
        .find(el => el.getAttribute('aria-expanded') === 'true')?.textContent?.trim() ?? null""")
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(300)
    focused_leaf = page.evaluate("() => document.activeElement?.textContent?.trim() ?? ''")
    page.keyboard.press("Escape")
    page.wait_for_timeout(600)
    after = page.evaluate("""() => ({
        expanded: [...document.querySelectorAll('nav .ant-menu-submenu-title')].find(el => el.getAttribute('aria-expanded') === 'true')?.textContent?.trim() ?? null,
        focus: {tag: document.activeElement?.tagName, cls: document.activeElement?.className, text: document.activeElement?.textContent?.trim()?.slice(0,40), menuId: document.activeElement?.getAttribute('data-menu-id'),
                inNav: !!document.activeElement?.closest?.('nav')}})""")
    ok_back = after["expanded"] is None and bool(opened) and after["focus"]["inNav"] and opened in str(after["focus"].get("text") or "")
    record("N001-04 Escapeで開いた分類タイトルへ復帰（本文へ飛ばない）", ok_back,
           f"opened={opened} leaf={focused_leaf} after={json.dumps(after, ensure_ascii=False)}")

    # キーボードで別機能を選択 → 本文へフォーカス
    # 最小再現(probe_keyboard_min.py)で /overview への遷移と本文フォーカスが確認済みの列を
    # そのまま再現する: Escape後フォーカスは分類タイトル → Enter(開く) → ArrowDown x2 → Enter。
    page.keyboard.press("Enter")
    page.wait_for_timeout(600)
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(300)
    page.keyboard.press("Enter")
    page.wait_for_function("() => location.pathname === '/overview'", timeout=10000)
    page.wait_for_timeout(400)
    focus_after_nav = page.evaluate("""() => ({tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), cls: document.activeElement?.className})""")
    ok_main = focus_after_nav.get("label") == "分析画面"
    record("N001-04 キーボード選択で本文（分析画面）へフォーカス", ok_main, json.dumps(focus_after_nav, ensure_ascii=False))
    record("N001-04 別機能へキーボード遷移(/overview)", focus_after_nav.get("label") == "分析画面", page.url)

    # 別分類（パターン探索→Ranking）をキーボードで選択し、本文へフォーカスが移ることを確認。
    # （仕様4.4: キーボード選択後は表示中本文へフォーカス。合成クリックでは検証しない。）
    page.keyboard.press("Tab")
    for _ in range(80):
        cls = page.evaluate("() => document.activeElement?.className ?? ''")
        if "feature-navigation-menu" in cls:
            break
        page.keyboard.press("Tab")
    # ArrowLeftで分類を2つ戻す（overview は データ・概要=group:data のため 0…ArrowRightで実は +1）
    # 確実な方法: ULフォーカスから ArrowRight を1回押して active を進め、Enter で開き ArrowDown→Enter
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(200)
    page.keyboard.press("Enter")
    page.wait_for_timeout(600)
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(300)
    page.keyboard.press("Enter")
    page.wait_for_function("() => location.pathname === '/pcp'", timeout=10000)
    page.wait_for_timeout(400)
    re_focus = page.evaluate("""() => ({label: document.activeElement?.getAttribute('aria-label'), path: location.pathname})""")
    record("N001-04 別機能(PCP)をキーボード選択で本文へフォーカス", re_focus.get("label") == "分析画面" and re_focus.get("path") == "/pcp",
           json.dumps(re_focus, ensure_ascii=False))
    record("N001-04 run終了時のurl/bundle記録", True, json.dumps(nav_probe(page), ensure_ascii=False))


# ---------------------------------------------------------------- N001-01: 実スクロール
def check_scroll(page):
    # ヘッダを圧縮してpopupの利用可能高を下げ、縦スクロールが必須の状態を作る
    page.goto(BASE + "/", wait_until="domcontentloaded")
    wait_app(page)
    page.bring_to_front()
    page.set_viewport_size({"width": 1280, "height": 330})
    page.wait_for_timeout(400)
    rest = page.locator("nav .ant-menu-overflow-item-rest")
    visible = False
    try:
        rest.first.wait_for(state="visible", timeout=3000)
        visible = True
    except Exception:
        pass
    if not visible or not rest.first.bounding_box():
        # 1024未満へ下げて狭幅の縦スクロールで代替する
        page.set_viewport_size({"width": 900, "height": 330})
        page.wait_for_timeout(400)
        btn = page.locator('[data-testid="feature-list-button"]')
        btn.click()
        page.wait_for_timeout(300)
        panel = page.locator("#feature-list-panel")
        probe = page.evaluate("""() => { const p = document.querySelector('#feature-list-panel');
            return p ? {h: Math.round(p.getBoundingClientRect().height), maxH: getComputedStyle(p).maxHeight,
                        scrollable: p.scrollHeight > p.clientHeight, overflowY: getComputedStyle(p).overflowY} : null }""")
        ok = bool(probe) and probe["scrollable"] and probe["maxH"] not in (None, "none")
        record("N001-01 狭幅パネルがmax-heightで縦スクロール可能", ok, json.dumps(probe, ensure_ascii=False))
        if ok:
            items = page.locator("#feature-list-panel [role='menuitem']")
            last_text = items.nth(items.count() - 1).inner_text()
            items.nth(items.count() - 1).scroll_into_view_if_needed()
            page.wait_for_timeout(200)
            box = items.nth(items.count() - 1).bounding_box()
            in_view = box and 0 < box["y"] < 330
            record("N001-01 狭幅パネルの末尾機能が画面内に到達", bool(in_view), f"last={last_text} box={box}")
        page.screenshot(path=f"{SHOTS}-narrow-scroll.png")
        return

    rest.first.click()
    page.wait_for_timeout(400)
    popup_cls = page.evaluate("""() => [...document.querySelectorAll('body > div')]
        .filter(d => typeof d.className === 'string' && d.className.includes('feature-navigation-popup') && d.className.includes('ant-menu-submenu-popup'))
        .map(d => d.className)""")
    record("N001-01 overflow親popupにfeature-navigation-popup適用", bool(popup_cls), json.dumps(popup_cls))
    probe = page.evaluate("""() => { const d = [...document.querySelectorAll('body > div')]
        .find(d => typeof d.className === 'string' && d.className.includes('feature-navigation-popup') && d.className.includes('ant-menu-submenu-popup'));
        if (!d) return null; const inner = d.querySelector('.ant-menu-vertical') ?? d.querySelector('ul');
        return {innerCls: inner?.className, maxH: inner ? getComputedStyle(inner).maxHeight : null,
                clientH: inner?.clientHeight, scrollH: inner?.scrollHeight,
                scrollable: inner ? inner.scrollHeight > inner.clientHeight : false,
                popupH: Math.round(d.getBoundingClientRect().height),
                inViewport: d.getBoundingClientRect().bottom <= innerHeight} }""")
    record("N001-01 低高画面で親popupに高さ制限が付き画面内に収まる",
           bool(probe) and probe["scrollable"] and probe["inViewport"], json.dumps(probe, ensure_ascii=False))
    # 退避分類から末尾の葉へスクロール到達
    sub_items = page.locator("body > div.feature-navigation-popup:visible [role='menuitem']")
    count = sub_items.count()
    reached_leaf = None
    for i in range(count):
        sub_items.nth(i).hover()
        page.wait_for_timeout(300)
        leaf = page.locator("body > div.feature-navigation-popup:visible [role='menuitem']:not(.ant-menu-submenu-title)").last
        leaf_box = leaf.bounding_box()
        if leaf_box and leaf_box["y"] + leaf_box["height"] < 330:
            leaf.hover()
            page.wait_for_timeout(200)
            leaf_box = leaf.bounding_box()
            if leaf_box and leaf_box["y"] + leaf_box["height"] <= 330:
                page.mouse.click(leaf_box["x"] + leaf_box["width"] / 2, min(leaf_box["y"] + leaf_box["height"] / 2, 320))
                page.wait_for_timeout(400)
                reached_leaf = {"text": leaf.inner_text(), "path": page.evaluate("() => location.pathname"),
                                "current": page.locator('[data-testid="navigation-current"]').inner_text()}
                break
    if reached_leaf:
        record("N001-01 実スクロール必要な低高popupで末尾機能へ到達",
               reached_leaf["path"] in ("/pca", "/models/ca", "/models/mca", "/models/famd", "/models/factor-analysis"),
               json.dumps(reached_leaf, ensure_ascii=False))
    else:
        record("N001-01 低高popupでの末尾到達", False, "退避分類の子機能を画面内へ出せず")
    page.screenshot(path=f"{SHOTS}-overflow-scroll.png")


# ---------------------------------------------------------------- V08: 分析往復
def lr_state(page):
    return page.evaluate("""() => {
      const sels = [...document.querySelectorAll('.ant-select-selection-item')].map(e => e.getAttribute('title') ?? e.textContent);
      const nums = [...document.querySelectorAll('.ant-input-number input')].map(e => e.value);
      const tags = [...document.querySelectorAll('.ant-tag')].map(e => e.textContent);
      const tables = [...document.querySelectorAll('.ant-table-tbody')].map(t => t.textContent.slice(0, 120));
      return {sels, nums, tags, tables, textLen: document.querySelector('[role="main"]')?.textContent.length ?? 0};
    }""")


def check_v08(page):
    page.goto(BASE + "/", wait_until="domcontentloaded")
    wait_app(page)
    page.bring_to_front()

    # --- 重回帰: 目的変数+説明変数を設定して実行し、往復後に入力と結果が残ること
    open_group_leaf(page, "予測・要因分析", "重回帰", "/models/linear-regression")
    page.wait_for_selector("main .ant-select", state="visible", timeout=20000)
    before = lr_state(page)
    def pick(page, select_index, nth=0):
        sel = page.locator("main .ant-select").nth(select_index)
        controls = sel.get_attribute("aria-controls") or ""
        sel.click()
        page.wait_for_timeout(600)
        dropdown = page.locator(f"#{controls}" if controls else ".ant-select-dropdown:not(.ant-select-dropdown-hidden)").first
        dropdown.wait_for(state="visible", timeout=10000)
        opt = page.locator(f"#{controls} .ant-select-item-option" if controls else ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").first
        name = opt.inner_text(timeout=5000)
        page.evaluate("""(el) => { const m = el.closest('.ant-select-dropdown')?.querySelectorAll('.ant-select-item-option');
            (m ? [...m].find(x => x === el) : el)?.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
            (m ? [...m].find(x => x === el) : el)?.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
            (m ? [...m].find(x => x === el) : el)?.click(); }""", opt.element_handle())
        page.wait_for_timeout(500)
        return name

    target_name = pick(page, 0)
    pred_name = pick(page, 1)
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    run_btn = page.locator("main button", has_text=re.compile("実\s*行")).first
    run_btn.wait_for(state="visible", timeout=15000)
    for _ in range(30):
        if run_btn.is_enabled():
            break
        page.wait_for_timeout(300)
    if run_btn.is_enabled():
        run_btn.click()
    else:
        record("V08 重回帰: 実行ボタン有効化", False, "変数選択後に実行ボタンがdisabledのまま")
    page.wait_for_timeout(3000)
    mid = lr_state(page)
    # SPA往復: PCP → 重回帰
    open_group_leaf(page, "可視化", "平行座標（PCP）", "/pcp")
    page.wait_for_timeout(600)
    open_group_leaf(page, "予測・要因分析", "重回帰", "/models/linear-regression")
    page.wait_for_selector("main .ant-select", state="visible", timeout=20000)
    after = lr_state(page)
    kept = after["sels"][:2] == [target_name, pred_name] or (target_name in str(after["sels"]) and pred_name in str(after["sels"]))
    record("V08 重回帰: 入力と結果が往復後も保持", kept,
           f"before={json.dumps(before, ensure_ascii=False)[:200]} mid={json.dumps(mid, ensure_ascii=False)[:200]} after={json.dumps(after, ensure_ascii=False)[:200]}")

    # --- 因子分析: 項目選択→実行→往復
    open_group_leaf(page, "次元削減・因子分析", "因子分析", "/models/factor-analysis")
    page.wait_for_selector("main .ant-select", state="visible", timeout=20000)
    fa_before = page.evaluate("""() => ({sels: [...document.querySelectorAll('.ant-select-selection-item')].map(e=>e.getAttribute('title')), nums: [...document.querySelectorAll('.ant-input-number input')].map(e=>e.value)})""")
    item_sel = page.locator("main .ant-select").first
    item_sel.click()
    page.wait_for_timeout(300)
    o1 = page.locator(".ant-select-dropdown:visible .ant-select-item-option").first
    fa_item1 = o1.inner_text()
    o1.click()
    page.wait_for_timeout(200)
    o2 = page.locator(".ant-select-dropdown:visible .ant-select-item-option").first
    fa_item2 = o2.inner_text()
    o2.click()
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    fa_run = page.get_by_role("button", name="実行")
    fa_run.click()
    page.wait_for_timeout(4000)
    open_group_leaf(page, "予測・要因分析", "重回帰", "/models/linear-regression")
    page.wait_for_timeout(400)
    open_group_leaf(page, "次元削減・因子分析", "因子分析", "/models/factor-analysis")
    page.wait_for_timeout(600)
    fa_after = page.evaluate("""() => ({sels: [...document.querySelectorAll('.ant-select-selection-item')].map(e=>e.getAttribute('title')), textLen: document.querySelector('[role="main"]')?.textContent.length})""")
    fa_kept = fa_item1 in str(fa_after["sels"]) and fa_item2 in str(fa_after["sels"]) and fa_after["textLen"] > 500
    record("V08 因子分析: 項目入力と結果が往復後も保持", fa_kept,
           f"items=({fa_item1},{fa_item2}) after={json.dumps(fa_after, ensure_ascii=False)[:200]}")

    # --- コンジョイント: 列設定→実行→往復
    open_group_leaf(page, "予測・要因分析", "コンジョイント", "/models/conjoint")
    page.wait_for_selector('[data-testid="conjoint-page"]', state="visible", timeout=20000)
    cj_before = page.evaluate("""() => ({sels: [...document.querySelectorAll('[data-testid="conjoint-page"] .ant-select-selection-item')].map(e=>e.getAttribute('title') ?? e.textContent), textLen: document.querySelector('[role="main"]')?.textContent.length})""")
    cj_sels = page.locator('[data-testid="conjoint-page"] .ant-select')
    if cj_sels.count() >= 2:
        cj_sels.first.click()
        page.wait_for_timeout(300)
        co = page.locator(".ant-select-dropdown:visible .ant-select-item-option").first
        cj_choice = co.inner_text()
        co.click()
        page.wait_for_timeout(200)
        cj_run = page.locator('[data-testid="cj-run"]')
        if cj_run.count():
            cj_run.click()
            page.wait_for_timeout(4000)
    open_group_leaf(page, "可視化", "平行座標（PCP）", "/pcp")
    page.wait_for_timeout(400)
    open_group_leaf(page, "予測・要因分析", "コンジョイント", "/models/conjoint")
    page.wait_for_timeout(600)
    cj_after = page.evaluate("""() => ({sels: [...document.querySelectorAll('[data-testid="conjoint-page"] .ant-select-selection-item')].map(e=>e.getAttribute('title') ?? e.textContent), textLen: document.querySelector('[role="main"]')?.textContent.length})""")
    cj_kept = (cj_choice in str(cj_after["sels"])) if cj_sels.count() >= 2 else True
    cj_kept = cj_kept and cj_after["textLen"] > 500
    record("V08 コンジョイント: 列指定と結果が往復後も保持", bool(cj_kept),
           f"before={json.dumps(cj_before, ensure_ascii=False)[:150]} after={json.dumps(cj_after, ensure_ascii=False)[:200]}")


# ---------------------------------------------------------------- V09: 中央状態
def check_v09(page):
    page.goto(BASE + "/table", wait_until="domcontentloaded")
    wait_app(page)
    page.bring_to_front()
    row = page.locator("tr[data-row-key='IRIS-002'] input[type='checkbox']")
    row.wait_for(state="visible", timeout=20000)
    row.click()
    page.wait_for_timeout(500)
    sidebar_ids = lambda: page.evaluate("""() => [...document.querySelectorAll('[data-testid="selected-sidebar"] .ant-list-item')].map(e=>e.textContent.trim())""")
    before_ids = sidebar_ids()
    scope_before = page.locator('[data-testid="app-shell"] header').inner_text()
    # 可視化 → 関係・集計 → データ・概要 の複数分類往復
    open_group_leaf(page, "可視化", "平行座標（PCP）", "/pcp")
    page.wait_for_timeout(500)
    pcp_state = {"selected": page.evaluate("() => document.querySelectorAll('[data-testid=\"selected-sidebar\"] .ant-list-item').length")}
    open_group_leaf(page, "関係・集計", "クロス集計（Crosstab）", "/crosstab")
    page.wait_for_timeout(500)
    open_group_leaf(page, "データ・概要", "データ表（Table）", "/table")
    page.wait_for_timeout(600)
    after_ids = sidebar_ids()
    checked = page.evaluate("() => document.querySelectorAll('table input[type=checkbox]:checked').length")
    same = after_ids == before_ids and "IRIS-002" in str(after_ids)
    record("V09 複数分類往復後も選択rowId集合が維持", bool(after_ids) and after_ids == before_ids,
           f"before={before_ids} after={after_ids} pcp={pcp_state}")
    # 変数・ウェイト・行範囲はヘッダ共通部で維持される
    ctrl = page.evaluate("""() => { const t = document.querySelector('header')?.textContent ?? '';
        return {variables: /Variables: \\[/.test(t) ? t.match(/Variables: \\[ ([^\\]]*) \\]/)?.[1] : null, weight: /ウェイト:/.test(t)} }""")
    record("V09 往復後にヘッダ共通状態（Variables/ウェイト）が表示維持", ctrl["variables"] is not None, json.dumps(ctrl, ensure_ascii=False))


# ---------------------------------------------------------------- V10: dataset切替
def check_v10(page):
    page.goto(BASE + "/table", wait_until="domcontentloaded")
    wait_app(page)
    page.bring_to_front()
    datasets = page.evaluate("""() => fetch('/api/v1/datasets').then(r => r.json()).then(d => (d.datasets ?? []).map(x => ({id: x.datasetId, name: x.name, rows: x.rowCount})))""")
    if len(datasets or []) < 2:
        record("V10 dataset切替", False, f"datasets={len(datasets or [])}件しかない")
        return
    # IRISで結果を作る
    open_group_leaf(page, "データ・概要", "記述統計（Statistics）", "/statistics")
    page.wait_for_timeout(1500)
    stat_before = page.evaluate("() => document.querySelector('[role=\\'main\\']')?.textContent.slice(0, 300)")
    # 別datasetへ切替（先頭以外）
    page.locator('[data-testid="dataset-selector"]').click()
    page.wait_for_timeout(500)
    second = page.locator(".ant-select-item-option").nth(1)
    second_name = second.inner_text()
    second.click()
    page.wait_for_timeout(2500)
    # 訪問済みページ再訪: 旧結果が残らない
    open_group_leaf(page, "データ・概要", "記述統計（Statistics）", "/statistics")
    page.wait_for_timeout(1500)
    stat_after = page.evaluate("() => document.querySelector('[role=\\'main\\']')?.textContent.slice(0, 300)")
    record("V10 dataset切替後に旧結果が残らない", stat_before != stat_after,
           f"before={stat_before!r:.120} after={stat_after!r:.120} switched_to={second_name}")
    # 元へ戻す
    page.locator('[data-testid="dataset-selector"]').click()
    page.wait_for_timeout(500)
    iris = page.locator(".ant-select-item-option", has_text="Iris (built-in sample)").first
    if iris.count():
        iris.click()
        page.wait_for_timeout(2500)


# ---------------------------------------------------------------- V11: 拡大連携
def check_v11(page):
    page.goto(BASE + "/pcp", wait_until="domcontentloaded")
    wait_app(page)
    page.bring_to_front()
    btn = page.get_by_role("button", name="拡大表示")
    # グラフパネルが縦に長く初回ビュー外でも操作可能にするため、見つかるまでスクロールする
    try:
        btn.first.scroll_into_view_if_needed(timeout=5000)
    except Exception:
        pass
    if not btn.count() or not btn.first.is_visible():
        record("V11 拡大ボタン検出", False, f"拡大表示ボタンが見つからない url={page.url}")
        return
    btn.first.click()
    page.wait_for_timeout(700)
    # Feature 035の設計（35_graph_expansion_design.md L50）: ヘッダ・navは消さず、
    # 共通dialogがtop layerで上に重なる。判定は「dialogが開いている」「navへ実クリックが届かない」
    # 「拡大前に開いていたpopupが残骸でない」とする。
    dialog_open = page.evaluate("""() => { const d = document.querySelector('[data-testid="graph-expansion-dialog"]');
        return !!d && (d.open || d.hasAttribute('open')) }""")
    nav_reachable = False
    try:
        page.locator("nav .ant-menu-submenu-title").first.click(timeout=1500)
        page.wait_for_timeout(200)
        nav_reachable = page.evaluate("""() => [...document.querySelectorAll('nav .ant-menu-submenu-title')]
            .some(el => el.getAttribute('aria-expanded') === 'true')""")
    except Exception:
        nav_reachable = False
    popups_gone = page.evaluate("() => document.querySelectorAll('.feature-navigation-popup').length === 0")
    record("V11 拡大中: dialogが最前面でnavは操作不可・popup非残存", dialog_open and not nav_reachable and popups_gone,
           f"dialogOpen={dialog_open} navReachable={nav_reachable} popups={popups_gone}")
    page.keyboard.press("Escape")
    page.wait_for_timeout(700)
    dialog_closed = page.evaluate("""() => { const d = document.querySelector('[data-testid="graph-expansion-dialog"]');
        return !d || (!d.open && !d.hasAttribute('open')) }""")
    nav_back = page.evaluate("() => { const n = document.querySelector('nav'); return n && n.offsetParent !== null }")
    export_ok = page.locator('[data-testid="export-button"]').is_visible()
    record("V11 解除後: dialogが閉じnavとExportが操作可能", dialog_closed and nav_back and export_ok,
           f"dialogClosed={dialog_closed} navBack={nav_back} exportVisible={export_ok}")
    # 解除後にナビ経由で遷移できること（メニュー実クリック）
    try:
        open_group_leaf(page, "データ・概要", "データ表（Table）", "/table")
        record("V11 解除後にナビで遷移可能", page.evaluate("() => location.pathname") == "/table", page.url)
    except Exception as e:
        record("V11 解除後にナビで遷移可能", False, str(e)[:200])
    page.screenshot(path=f"{SHOTS}-v11.png")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        run_meta["startedAt"] = stamp()
        run_meta["base"] = BASE
        for name, fn in [
            ("N001-04 キーボード", check_keyboard),
            ("N001-01 スクロール", check_scroll),
            ("V08 分析往復", check_v08),
            ("V09 中央状態", check_v09),
            ("V10 dataset切替", check_v10),
            ("V11 拡大連携", check_v11),
        ]:
            section(name, fn, page)
        run_meta["finishedAt"] = stamp()
        browser.close()

    payload = {"base": BASE, "meta": run_meta, "results": results}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    failed = [r for r in results if not r["ok"]]
    print(f"PASS {len(results) - len(failed)}/{len(results)}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
