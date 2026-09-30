"""Feature 036 REPORT-004用 実ブラウザ受入検証 run_all.py
N001-01〜04の残条件をPlaywright実操作で検証する。各runは独立ID・独立出力。
前提: 本番8420配信 (index-CKY31PSW.js)。可視タブ・非ゼロ幅を前提条件として記録。
"""
import json, sys, time, datetime
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8420"
OUT = Path(__file__).parent / "run_all_out"
OUT.mkdir(parents=True, exist_ok=True)
RUN_ID = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
results = {"run_id": RUN_ID, "base": BASE, "bundle": None, "cases": []}

def rec(name, ok, expected, actual, detail=""):
    results["cases"].append({"name": name, "ok": ok, "expected": expected, "actual": actual, "detail": detail})
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {actual} {detail}")

NAV_EXPECTED = {
    "/table": "データ・概要 › データ表（Table）",
    "/overview": "データ・概要 › データ概要（Overview）",
    "/statistics": "データ・概要 › 記述統計（Statistics）",
    "/covariance": "データ・概要 › 共分散（Covariance）",
    "/pcp": "可視化 › 平行座標（PCP）",
    "/distribution": "可視化 › 分布（Distribution）",
    "/likert": "可視化 › Likert",
    "/touring": "可視化 › Touring",
    "/fedf": "可視化 › FEDF",
    "/barchart": "可視化 › 棒グラフ（Bar Chart）",
    "/loess": "可視化 › Loess",
    "/relationships": "関係・集計 › 変数間の関係（Relationships）",
    "/associations": "関係・集計 › Surprise",
    "/mosaic": "関係・集計 › Mosaic",
    "/crosstab": "関係・集計 › クロス集計（Crosstab）",
    "/ranking": "パターン探索 › 変数ランキング（Ranking）",
    "/subgroups": "パターン探索 › Mining",
    "/clusters": "パターン探索 › クラスタリング（Clusters）",
    "/robustness": "パターン探索 › 頑健性（Robustness）",
    "/models": "予測・要因分析 › 決定木・ランダムフォレスト（Models）",
    "/logistic": "予測・要因分析 › ロジスティック回帰（Logistic）",
    "/discriminant": "予測・要因分析 › 判別分析（Discriminant）",
    "/models/linear-regression": "予測・要因分析 › 重回帰",
    "/key-drivers": "予測・要因分析 › Key Drivers",
    "/penalty-reward": "予測・要因分析 › Penalty-Reward",
    "/models/conjoint": "予測・要因分析 › コンジョイント",
    "/pca": "次元削減・因子分析 › 主成分分析（PCA）",
    "/models/ca": "次元削減・因子分析 › 対応分析（CA）",
    "/models/mca": "次元削減・因子分析 › 多重対応分析（MCA）",
    "/models/famd": "次元削減・因子分析 › 混合データ因子分析（FAMD）",
    "/models/factor-analysis": "次元削減・因子分析 › 因子分析",
}

with sync_playwright() as p:
    browser = p.chromium.launch()
    # ---- Run A: 1440 通常幅 基本表示・6分類・現在地 ----
    pg = browser.new_page(viewport={"width": 1440, "height": 900})
    pg.goto(BASE + "/pcp", wait_until="domcontentloaded")
    pg.wait_for_timeout(4000)
    pre = pg.evaluate("() => ({w: innerWidth, vis: document.visibilityState, js: [...document.scripts].map(s=>s.src).join('|')})")
    results["bundle"] = pre["js"]
    rec("A0-前提条件(可視・非ゼロ幅・bundle)",
        pre["vis"] == "visible" and pre["w"] == 1440 and "index-CKY31PSW.js" in pre["js"],
        "visible/1440/CKY31PSW", f"{pre['vis']}/{pre['w']}/{pre['js'][-80:]}")
    nav = pg.locator('[data-testid=main-nav]')
    rec("A1-通常幅でhorizontal Menu表示", nav.is_visible() and pg.locator('.feature-navigation-menu').is_visible(),
        "menu visible", f"nav={nav.is_visible()}")
    cats = pg.evaluate("() => document.querySelectorAll('.feature-navigation-menu > li.ant-menu-submenu:not(.ant-menu-overflow-item-rest)').length")
    rec("A2-6分類表示", cats == 6, "6", str(cats))
    cur = pg.locator('[data-testid="navigation-current"]').inner_text()
    rec("A3-現在地 PCP", cur == "可視化 › 平行座標（PCP）", "可視化 › 平行座標（PCP）", cur)
    # メニューから予測・要因分析→コンジョイントへ実クリック遷移
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="予測・要因分析").click()
    pg.wait_for_timeout(1200)
    pg.screenshot(path=str(OUT / f"{RUN_ID}-a-popup.png"))
    leaf = pg.locator('.feature-navigation-popup .ant-menu-item', has_text="コンジョイント")
    leafcount = leaf.count()
    if leafcount > 0:
        leaf.first.click()
        pg.wait_for_timeout(3000)
    path = pg.evaluate("() => location.pathname")
    cur2 = pg.locator('[data-testid="navigation-current"]').inner_text()
    rec("A4-メニュークリックでコンジョイント遷移", path == "/models/conjoint" and cur2 == "予測・要因分析 › コンジョイント",
        "/models/conjoint + 現在地", f"{path} + {cur2}")
    pg.screenshot(path=str(OUT / f"{RUN_ID}-a-conjoint.png"))

    # ---- Run B: 全31機能 直接URL遷移＋現在地照合 ----
    fails = []
    for url, expect in NAV_EXPECTED.items():
        try:
            pg.goto(BASE + url, wait_until="domcontentloaded", timeout=15000)
        except Exception:
            try:
                pg.goto(BASE + url, timeout=15000)
            except Exception:
                pass
        pg.wait_for_timeout(1500)
        try:
            got_cur = pg.locator('[data-testid="navigation-current"]').inner_text(timeout=5000)
            got_path = pg.evaluate("() => location.pathname")
        except Exception as e:
            got_cur, got_path = f"ERR {e}", "ERR"
        if got_cur != expect or got_path != url:
            fails.append(f"{url}: path={got_path} cur={got_cur}")
    rec("B1-全31機能のpathname+現在地一致", len(fails) == 0, "31/31一致",
        f"{31-len(fails)}/31一致", "; ".join(fails[:5]))
    # URL正規化: / と末尾スラッシュ
    pg.goto(BASE + "/", wait_until="domcontentloaded"); pg.wait_for_timeout(1500)
    c_root = pg.locator('[data-testid="navigation-current"]').inner_text()
    rec("B2-/はPCP扱い", c_root == "可視化 › 平行座標（PCP）", "可視化 › 平行座標（PCP）", c_root)
    pg.goto(BASE + "/pcp/", wait_until="domcontentloaded"); pg.wait_for_timeout(1500)
    c_slash = pg.locator('[data-testid="navigation-current"]').inner_text()
    p_slash = pg.evaluate("() => location.pathname")
    rec("B3-末尾スラッシュ正規化", c_slash == "可視化 › 平行座標（PCP）", "PCP現在地", f"{p_slash} {c_slash}")
    # /models 前方一致の誤選択がないこと
    pg.goto(BASE + "/models", wait_until="domcontentloaded"); pg.wait_for_timeout(1500)
    c_models = pg.locator('[data-testid="navigation-current"]').inner_text()
    rec("B4-/modelsはModels選択", c_models == "予測・要因分析 › 決定木・ランダムフォレスト（Models）",
        "Models現在地", c_models)
    # 履歴: 同じ機能再選択で履歴が増えない（メニュークリック経路）
    pg.goto(BASE + "/pcp", wait_until="domcontentloaded"); pg.wait_for_timeout(2000)
    # 6分類をそれぞれ実クリックで開き、開くだけでは遷移しないことを記録
    opened_ok, opened_detail = True, []
    for gname in ["データ・概要", "可視化", "関係・集計", "パターン探索", "予測・要因分析", "次元削減・因子分析"]:
        before = pg.evaluate("() => location.pathname")
        pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text=gname).click()
        pg.wait_for_timeout(700)
        after = pg.evaluate("() => location.pathname")
        vis = pg.evaluate("() => document.querySelectorAll('.feature-navigation-popup').length")
        ok = (before == after == "/pcp")
        opened_ok = opened_ok and ok
        opened_detail.append(f"{gname}:{'stay' if ok else 'MOVED'}")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    # N006-06対応: 分類ごとにSubMenuが開いたこと(aria-expanded+可視popup)を記録
    opened_vis_ok, opened_vis_detail = True, []
    for gname in ["データ・概要", "可視化", "関係・集計", "パターン探索", "予測・要因分析", "次元削減・因子分析"]:
        pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text=gname).click()
        pg.wait_for_timeout(700)
        st = pg.evaluate("""(g) => {
          const items=[...document.querySelectorAll('.feature-navigation-menu > li.ant-menu-submenu .ant-menu-submenu-title')];
          const t=items.find(e=>e.textContent.trim()===g);
          const open=t ? t.getAttribute('aria-expanded')==='true' : false;
          const pops=[...document.querySelectorAll('.feature-navigation-popup')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;}).length;
          const leaves=[...document.querySelectorAll('.feature-navigation-popup .ant-menu-item')].map(e=>e.innerText.trim()).slice(0,8);
          return {open, pops, leaves};
        }""", gname)
        ok = st["open"] and st["pops"] >= 1
        opened_vis_ok = opened_vis_ok and ok
        opened_vis_detail.append(f"{gname}:open={st['open']}/pop={st['pops']}")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    rec("B0b-6分類のSubMenuが開く(aria-expanded+可視popup)", opened_vis_ok, "6分類とも開", "; ".join(opened_vis_detail))
    rec("B0-6分類を開くだけでは遷移しない", opened_ok, "6分類とも/pcp維持", "; ".join(opened_detail))
    n0 = pg.evaluate("() => history.length")
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="可視化").click()
    pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="平行座標").first.click()
    pg.wait_for_timeout(1500)
    n1 = pg.evaluate("() => history.length")
    p1 = pg.evaluate("() => location.pathname")
    rec("B5-同一機能再選択で履歴不増", n1 == n0 and p1 == "/pcp", f"len={n0}維持", f"len={n0}->{n1} path={p1}")
    # 戻る・進む
    pg.goto(BASE + "/table", wait_until="domcontentloaded"); pg.wait_for_timeout(1500)
    pg.goto(BASE + "/pca", wait_until="domcontentloaded"); pg.wait_for_timeout(1500)
    pg.go_back(); pg.wait_for_timeout(1500)
    pb = pg.evaluate("() => location.pathname")
    cb = pg.locator('[data-testid="navigation-current"]').inner_text()
    rec("B6-戻るで追従", pb == "/table" and cb == "データ・概要 › データ表（Table）",
        "/table追従", f"{pb} {cb}")

    # ---- Run C: overflow (1024幅で縮小→その他の分類) ----
    # N006-01対応: 低高(360px)で標準overflow親に実スクロール(scrollH>clientH)を発生させる
    pg2 = browser.new_page(viewport={"width": 1024, "height": 360})
    pg2.goto(BASE + "/pcp", wait_until="domcontentloaded")
    pg2.wait_for_timeout(4000)
    over = pg2.locator('.feature-navigation-menu .ant-menu-overflow-item-rest').count()
    over_visible = pg2.locator('.feature-navigation-menu .ant-menu-overflow-item-rest').is_visible() if over else False
    menu_scroll = pg2.evaluate("() => { const m=document.querySelector('.feature-navigation-menu'); if(!m) return 'no-menu'; const s=getComputedStyle(m); return `overflow-x:${s.overflowX};scrollW:${m.scrollWidth};clientW:${m.clientWidth}` }")
    dims = pg2.evaluate("() => { const m=document.querySelector('.feature-navigation-menu'); if(!m) return null; const r=m.getBoundingClientRect(); return {sw:m.scrollWidth, cw:m.clientWidth, x:r.x, y:r.y, w:r.width, h:r.height, vw: innerWidth, inView: r.x>=0 && r.x+r.width<=innerWidth+1} }")
    rest_box = pg2.evaluate("() => { const e=document.querySelector('.feature-navigation-menu .ant-menu-overflow-item-rest'); if(!e) return null; const r=e.getBoundingClientRect(); return {w:r.width, h:r.height, x:r.x, y:r.y} }")
    no_hscroll = dims is not None and dims["sw"] <= dims["cw"] + 1
    rest_nonzero = rest_box is not None and rest_box["w"] > 0 and rest_box["h"] > 0
    rest_inview = rest_box is not None and rest_box["x"] >= 0 and rest_box["x"] + rest_box["w"] <= dims["vw"] + 1 if dims else False
    rec("C1-1024幅で横スクロールなし・入口が可視で画面内", no_hscroll and over_visible and rest_nonzero and rest_inview,
        "sw<=cw+可視+非ゼロ+画面内", f"overflow_rest={over}/visible={over_visible} {menu_scroll} box={rest_box} inview={rest_inview}")
    pg2.screenshot(path=str(OUT / f"{RUN_ID}-c-1024.png"))
    if over_visible:
        pg2.locator('.feature-navigation-menu .ant-menu-overflow-item-rest').click()
        pg2.wait_for_timeout(1200)
        pg2.screenshot(path=str(OUT / f"{RUN_ID}-c-overflow.png"))
        # overflow popup内の分類→葉到達（次元削減→因子分析）
        # 低高でpopupが不安定な場合は可視化のため少し待ってから操作
        pg2.wait_for_timeout(800)
        dim = pg2.locator('.feature-navigation-popup .ant-menu-submenu-title', has_text="次元削減").first
        if dim.count() == 0:
            dim = pg2.locator('.feature-navigation-popup .ant-menu-submenu', has_text="次元削減").first
        if dim.count() > 0:
            try:
                dim.click(timeout=8000); pg2.wait_for_timeout(1000)
            except Exception as e:
                print("dim click fail:", str(e)[:120])
            pg2.screenshot(path=str(OUT / f"{RUN_ID}-c-overflow-dim.png"))
        fleaf = pg2.locator('.feature-navigation-popup .ant-menu-item').filter(has_text="因子分析").all()
        exact = [e for e in fleaf if e.inner_text().strip() == "因子分析"]
        _fleaf_all = pg2.locator('.feature-navigation-popup .ant-menu-item').all_inner_texts()
        if exact:
            scrollinfo = pg2.evaluate("() => { const subs=[...document.querySelectorAll('.feature-navigation-popup .ant-menu')]; return subs.map(s=>({sh:s.scrollHeight, ch:s.clientHeight, st:s.scrollTop})).map(o=>JSON.stringify(o)).join(' | ') }")
            # N007-01対応: 実ホイール入力でスクロール。scroll容器上にポインタを置きmouse.wheelを送る
            wheel_box = pg2.evaluate("""() => {
              const subs=[...document.querySelectorAll('.feature-navigation-popup .ant-menu')].filter(s=>s.scrollHeight > s.clientHeight + 1);
              if (!subs.length) return null;
              const r=subs[0].getBoundingClientRect();
              return {x:r.x+r.width/2, y:r.y+r.height/2};
            }""")
            st_before_wheel = pg2.evaluate("() => { const subs=[...document.querySelectorAll('.feature-navigation-popup .ant-menu')]; return subs.map(s=>`sh:${s.scrollHeight},ch:${s.clientHeight},st:${s.scrollTop}`).join(' | ') }")
            scrolled = False
            if wheel_box:
                pg2.mouse.move(wheel_box["x"], wheel_box["y"]); pg2.wait_for_timeout(300)
                for _ in range(6):
                    pg2.mouse.wheel(0, 400); pg2.wait_for_timeout(300)
                scrolled = pg2.evaluate("() => { const subs=[...document.querySelectorAll('.feature-navigation-popup .ant-menu')]; return subs.some(s=>s.scrollTop > 0); }")
            pg2.wait_for_timeout(400)
            st_after = pg2.evaluate("() => { const subs=[...document.querySelectorAll('.feature-navigation-popup .ant-menu')]; return subs.map(s=>`sh:${s.scrollHeight},ch:${s.clientHeight},st:${s.scrollTop}`).join(' | ') }")
            vis = exact[0].is_visible()
            box = exact[0].bounding_box()
            exact[0].click(); pg2.wait_for_timeout(2500)
            pc = pg2.evaluate("() => location.pathname")
            cc = pg2.locator('[data-testid="navigation-current"]').inner_text()
            # N006-01厳密条件: scrollH>clientHの実スクロール発生を要求。クリック前のafter値(st_after)で判定する
            import re as _re
            _m = _re.findall(r"sh:(\d+),ch:(\d+),st:(\d+)", st_after)
            has_overflow = any(int(a[0]) > int(a[1]) + 1 for a in _m)
            real_scroll = any(int(a[2]) > 0 for a in _m)
            st_vals = st_after
            rec("C2-overflow親で末尾「因子分析」へ到達", pc == "/models/factor-analysis" and vis and real_scroll,
                "/models/factor-analysis+可視+実スクロール(st>0)", f"{pc} {cc} [before:{scrollinfo}] [after:{st_after}] scrolled={scrolled} real_scroll={real_scroll} vals={st_vals} vis={vis} box={box} leaves={_fleaf_all}")
        else:
            rec("C2-overflow親で末尾「因子分析」へ到達", False, "因子分析の葉(完全一致)", f"葉なし all={_fleaf_all}")
    else:
        rec("C2-overflow経由で因子分析到達", True, "overflowなし→全分類表示で到達可能", "overflow未発生(1024で全分類収容)")
    # 幅往復: 1024→768(狭幅)→1440
    pg2.set_viewport_size({"width": 768, "height": 700}); pg2.wait_for_timeout(1500)
    narrow_btn = pg2.locator('[data-testid="feature-list-button"]').is_visible()
    rec("C3-768幅で機能一覧ボタン", narrow_btn, "ボタン表示", str(narrow_btn))
    pg2.screenshot(path=str(OUT / f"{RUN_ID}-c-768.png"))
    if narrow_btn:
        pg2.locator('[data-testid="feature-list-button"]').click(); pg2.wait_for_timeout(1000)
        panel = pg2.locator('#feature-list-panel').is_visible()
        # 現在地分類が初期展開されているか
        open_titles = pg2.evaluate("() => [...document.querySelectorAll('#feature-list-panel .ant-menu-submenu-open .ant-menu-submenu-title')].map(e=>e.textContent)")
        rec("C4-狭幅で現在地分類を初期展開", panel and len(open_titles) == 1, "1分類展開", f"panel={panel} open={open_titles}")
        pg2.screenshot(path=str(OUT / f"{RUN_ID}-c-narrow-panel.png"))
        # 末尾機能（因子分析）へスクロール到達
        # 次元削減分類を開く
        # C5: 開いている分類(次元削減)とは別の分類(可視化)を開き、同時1展開を検証
        subs = pg2.locator('#feature-list-panel .ant-menu-submenu-title')
        for i in range(subs.count()):
            t = subs.nth(i).inner_text()
            if "可視化" in t and "次元削減" not in t:
                try:
                    subs.nth(i).click(timeout=5000); pg2.wait_for_timeout(1000)
                except Exception:
                    pg2.evaluate("() => { const els=[...document.querySelectorAll('#feature-list-panel .ant-menu-submenu-title')]; const el=els.find(x=>x.textContent==='可視化'); if(el) el.click(); }")
                    pg2.wait_for_timeout(1000)
                break
        pg2.screenshot(path=str(OUT / f"{RUN_ID}-c-narrow-dim.png"))
        open2 = pg2.evaluate("() => [...document.querySelectorAll('#feature-list-panel .ant-menu-submenu-open .ant-menu-submenu-title')].map(e=>e.textContent)")
        only_one = len(open2) == 1 and "可視化" in open2[0]
        rec("C5-狭幅は同時1分類のみ展開", only_one, "可視化のみ", str(open2))
        fleaf2 = pg2.locator('#feature-list-panel .ant-menu-item', has_text="因子分析")
        if fleaf2.count() > 0:
            try:
                fleaf2.first.scroll_into_view_if_needed(timeout=5000)
            except Exception:
                pg2.evaluate("() => { const els=[...document.querySelectorAll('#feature-list-panel .ant-menu-item')]; const el=els.find(x=>x.textContent.includes('因子分析')); if(el) el.scrollIntoView({block:'nearest'}); }")
            pg2.wait_for_timeout(500)
            try:
                fleaf2.first.click(timeout=5000)
            except Exception:
                pg2.evaluate("() => { const els=[...document.querySelectorAll('#feature-list-panel .ant-menu-item')]; const el=els.find(x=>x.textContent==='因子分析'); if(el) el.click(); }")
            pg2.wait_for_timeout(2500)
            pnarrow = pg2.evaluate("() => location.pathname")
            panel_closed = not pg2.locator('#feature-list-panel').is_visible() if pg2.locator('#feature-list-panel').count() else True
            rec("C6-狭幅末尾機能へ到達しパネル閉鎖", pnarrow == "/models/factor-analysis" and panel_closed,
                "/models/factor-analysis+閉鎖", f"{pnarrow} closed={panel_closed}")
        else:
            rec("C6-狭幅末尾機能へ到達しパネル閉鎖", False, "因子分析の葉", "葉なし")
    # N007-01対応: 必須表示幅は新規ページで直接開く(幅往復の残存状態を排除)
    for _w, _label in [(1280, "W1280"), (1023, "W1023"), (390, "W390")]:
        pg2.close()
        pg2 = browser.new_page(viewport={"width": _w, "height": 700})
        pg2.goto(BASE + "/pcp", wait_until="domcontentloaded")
        pg2.wait_for_timeout(3500)
        if _w >= 1024:
            m_vis = pg2.locator('.feature-navigation-menu').is_visible()
            dims_w = pg2.evaluate("() => { const m=document.querySelector('.feature-navigation-menu'); return m ? {sw:m.scrollWidth, cw:m.clientWidth} : null }")
            nohs = dims_w is not None and dims_w["sw"] <= dims_w["cw"] + 1
            pg2.screenshot(path=str(OUT / f"{RUN_ID}-w-{_w}.png"))
            rec(f"{_label}-通常幅で横スクロールなし", m_vis and nohs, "menu可視+sw<=cw", str(dims_w))
        else:
            btn_w = pg2.locator('[data-testid="feature-list-button"]').is_visible()
            menu_w = pg2.locator('.feature-navigation-menu').count()
            # N007-01対応: パネルを実際に開き、分類を開き、末尾葉を選択して画面到達を確認
            w_reached, w_cur, w_path, w_hs = False, "", "", ""
            if btn_w:
                try:
                    # 幅変更でパネルが開いたままの可能性があるため閉じてから開き直す
                    try:
                        if pg2.locator('#feature-list-panel').count() and pg2.locator('#feature-list-panel').is_visible():
                            pg2.locator('[data-testid="feature-list-button"]').click(timeout=3000); pg2.wait_for_timeout(600)
                    except Exception:
                        pass
                    pg2.locator('[data-testid="feature-list-button"]').click(timeout=5000); pg2.wait_for_timeout(1000)
                    _subs = pg2.locator('#feature-list-panel .ant-menu-submenu-title')
                    for _i in range(_subs.count()):
                        if "次元削減" in _subs.nth(_i).inner_text():
                            _subs.nth(_i).click(timeout=5000); pg2.wait_for_timeout(800)
                            break
                    _leaf = pg2.locator('#feature-list-panel .ant-menu-item').all()
                    _exact = [e for e in _leaf if e.inner_text().strip() == "因子分析"]
                    if _exact:
                        try:
                            _exact[0].scroll_into_view_if_needed(timeout=5000)
                        except Exception:
                            pass
                        pg2.wait_for_timeout(300)
                        _exact[0].click(timeout=5000); pg2.wait_for_timeout(2000)
                        w_path = pg2.evaluate("() => location.pathname")
                        w_cur = pg2.locator('[data-testid="navigation-current"]').inner_text()
                        w_hs = pg2.evaluate("() => { const p=document.querySelector('#feature-list-panel'); return p ? `panelH:${p.scrollHeight},clientH:${p.clientHeight}` : 'no-panel'; }")
                        w_reached = (w_path == "/models/factor-analysis")
                except Exception as e:
                    w_cur = f"ERR {str(e)[:80]}"
            pg2.screenshot(path=str(OUT / f"{RUN_ID}-w-{_w}.png"))
            rec(f"{_label}-狭幅で末尾葉へ到達", btn_w and menu_w == 0 and w_reached,
                "/models/factor-analysis到達", f"btn={btn_w} menu_count={menu_w} path={w_path} cur={w_cur} {w_hs}")
    # N007-01対応: 1280pxの200%相当(deviceScaleFactor=2)で到達・重なり・横スクロールを確認
    pgz = browser.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=2)
    pgz.goto(BASE + "/pcp", wait_until="domcontentloaded")
    pgz.wait_for_timeout(4000)
    z_menu = pgz.locator('.feature-navigation-menu').is_visible()
    z_dims = pgz.evaluate("() => { const m=document.querySelector('.feature-navigation-menu'); return m ? {sw:m.scrollWidth, cw:m.clientWidth} : null }")
    z_nohs = z_dims is not None and z_dims["sw"] <= z_dims["cw"] + 1
    z_overlap = pgz.evaluate("() => { const items=[...document.querySelectorAll('.feature-navigation-menu > li')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>0&&r.height>0;}); const rs=items.map(e=>e.getBoundingClientRect()); for(let i=1;i<rs.length;i++){ if(rs[i].x < rs[i-1].x+rs[i-1].width-1) return true; } return false; }")
    z_vis_items = pgz.evaluate("() => [...document.querySelectorAll('.feature-navigation-menu > li')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>0&&r.height>0;}).map(e=>e.textContent.trim().slice(0,12)).join('|')")
    pgz.screenshot(path=str(OUT / f"{RUN_ID}-w-1280-200pct.png"))
    rec("W1280Z-200%相当で到達・重なりなし・横スクロールなし", z_menu and z_nohs and not z_overlap,
        "menu可視+sw<=cw+重なりなし(可視のみ)", f"{z_dims} overlap={z_overlap} vis=[{z_vis_items}] dsf=2")
    pgz.close()
    # W1023/W390でpg2は閉じたため、C7用に1024幅の新規ページを開き直す
    pg2 = browser.new_page(viewport={"width": 1024, "height": 360})
    pg2.goto(BASE + "/pcp", wait_until="domcontentloaded")
    pg2.wait_for_timeout(3500)
    # N006-01対応: popupを開いたまま幅往復し、各段階の可視popup数と操作可能性を判定に含める
    # まず1024幅でoverflow入口を開いた状態を作る
    try:
        pg2.locator('.feature-navigation-menu .ant-menu-overflow-item-rest').click(timeout=5000); pg2.wait_for_timeout(800)
    except Exception:
        pass
    open_before = pg2.evaluate("() => [...document.querySelectorAll('.feature-navigation-popup')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;}).length")
    pg2.set_viewport_size({"width": 768, "height": 700}); pg2.wait_for_timeout(1500)
    mid_popups = pg2.evaluate("() => [...document.querySelectorAll('.feature-navigation-popup')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;}).length")
    mid_btn = pg2.locator('[data-testid="feature-list-button"]').is_visible()
    pg2.set_viewport_size({"width": 1440, "height": 900}); pg2.wait_for_timeout(1500)
    back_menu = pg2.locator('.feature-navigation-menu').is_visible()
    leftover = pg2.evaluate("() => document.querySelectorAll('.feature-navigation-popup').length")
    leftover_vis = pg2.evaluate("() => [...document.querySelectorAll('.feature-navigation-popup')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;}).length")
    try:
        pg2.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="可視化").click(timeout=5000); pg2.wait_for_timeout(800)
        operable = pg2.evaluate("() => document.querySelectorAll('.feature-navigation-popup').length") > 0
        pg2.keyboard.press("Escape"); pg2.wait_for_timeout(400)
    except Exception:
        operable = False
    rec("C7-幅往復後に通常Menu復帰・popup残存なし", back_menu and leftover == 0 and leftover_vis == 0 and operable,
        "menu復帰+popup0+操作可", f"open_before={open_before} mid_popups={mid_popups} mid_btn={mid_btn} menu={back_menu} popup_nodes={leftover} vis={leftover_vis} operable={operable}")
    pg2.close()

    # ---- Run D: キーボード Tab/Escape/フォーカス ----
    pg3 = browser.new_page(viewport={"width": 1440, "height": 900})
    pg3.goto(BASE + "/pcp", wait_until="domcontentloaded")
    pg3.wait_for_timeout(4000)
    # nav内の最初の分類へTab到達できるか: bodyからTabを送りフォーカスを追跡
    pg3.evaluate("() => document.body.focus()")
    focused = []
    for i in range(40):
        pg3.keyboard.press("Tab"); pg3.wait_for_timeout(120)
        f = pg3.evaluate("() => { const e=document.activeElement; return e ? (e.getAttribute('aria-label')||e.textContent||e.tagName).slice(0,60) : 'none' }")
        focused.append(f)
        region = pg3.evaluate("() => { const e=document.activeElement; const n=document.querySelector('[data-testid=main-nav]'); return n && e ? (n.contains(e) ? 'IN-NAV' : 'OUT') : '?' }")
        if region == "IN-NAV":
            break
    in_nav = any(True for _ in [1] if pg3.evaluate("() => { const e=document.activeElement; const n=document.querySelector('[data-testid=main-nav]'); return !!(n&&e&&n.contains(e)) }"))
    rec("D1-Tabでナビへ到達", in_nav, "IN-NAV", f"keys={len(focused)} last={focused[-1][:40] if focused else ''}")
    # Enterで分類を開く→Escapeで閉じて分類へ戻る(要素単位で記録)
    # 注意: D1直後のフォーカスはメニューコンテナ自体にあるため、まず分類タイトルへ移動してから開く
    pg3.keyboard.press("ArrowRight"); pg3.wait_for_timeout(400)
    pg3.keyboard.press("Enter"); pg3.wait_for_timeout(1200)
    open_info = pg3.evaluate("""() => {
      const items=[...document.querySelectorAll('.feature-navigation-menu > li.ant-menu-submenu .ant-menu-submenu-title')];
      const open=items.filter(e=>e.getAttribute('aria-expanded')==='true').map(e=>e.textContent.trim());
      const popups=[...document.querySelectorAll('body > div')].filter(d=>typeof d.className==='string'&&(d.className.includes('ant-menu-submenu-popup')||d.className.includes('feature-navigation-popup'))).map(d=>{
        const r=d.getBoundingClientRect(); return {vis: r.width>0&&r.height>0, w:Math.round(r.width), h:Math.round(r.height), cls:d.className.slice(0,80)};
      });
      const visPop=[...document.querySelectorAll('.feature-navigation-popup')].map(d=>{ const r=d.getBoundingClientRect(); return Math.round(r.width)+'x'+Math.round(r.height); });
      return {open, popups, visPop};
    }""")
    pre_open_ok = len(open_info["open"]) >= 1 and any(pp["vis"] for pp in open_info["popups"])
    pg3.screenshot(path=str(OUT / f"{RUN_ID}-d-open.png"))
    pg3.keyboard.press("Escape"); pg3.wait_for_timeout(800)
    post_info = pg3.evaluate("""() => {
      const e=document.activeElement;
      const r=e?e.getBoundingClientRect():{width:0,height:0,x:0,y:0};
      const items=[...document.querySelectorAll('.feature-navigation-menu > li.ant-menu-submenu .ant-menu-submenu-title')];
      const open=items.filter(x=>x.getAttribute('aria-expanded')==='true').map(x=>x.textContent.trim());
      return {role:e?e.getAttribute('role'):'none', text:(e?(e.getAttribute('aria-label')||e.textContent||e.tagName):'none').slice(0,60),
        x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height),
        inNav: !!(e&&document.querySelector('[data-testid=main-nav]').contains(e)), open,
        bodyVisible: e ? (e.offsetParent!==null) : false};
    }""")
    closed_ok = len(post_info["open"]) == 0
    back_ok = post_info["inNav"] and post_info["w"] > 0 and post_info["h"] > 0 and post_info["bodyVisible"]
    pg3.screenshot(path=str(OUT / f"{RUN_ID}-d-after-escape.png"))
    rec("D2-Escapeでpopup閉鎖・開いた分類へ復帰", pre_open_ok and closed_ok and back_ok,
        "開→閉+分類要素へ復帰(可視)", f"pre={open_info} post={post_info}")
    # キーボードで機能選択→本文へフォーカス
    pg3.keyboard.press("Enter"); pg3.wait_for_timeout(1000)
    # popup内の葉へ矢印キーで移動してEnter
    for _ in range(6):
        pg3.keyboard.press("ArrowDown"); pg3.wait_for_timeout(200)
    f_leaf = pg3.evaluate("() => { const e=document.activeElement; return ((e&&(e.getAttribute('role')||''))+'|'+((e&&(e.textContent||''))||'')).slice(0,80) }")
    pg3.keyboard.press("Enter"); pg3.wait_for_timeout(2500)
    p_after = pg3.evaluate("() => location.pathname")
    f_main = pg3.evaluate("() => { const e=document.activeElement; const m=document.querySelector('[role=main]'); return (m&&e&&m.contains(e)?'IN-MAIN:':'OUT:')+((e&&(e.tagName||''))||'none') }")
    rec("D3-キー選択で遷移・本文フォーカス", p_after != "/pcp" and f_main.startswith("IN-MAIN"), "遷移+IN-MAIN",
        f"path={p_after} focus={f_main} leafwas={f_leaf}")
    pg3.screenshot(path=str(OUT / f"{RUN_ID}-d-after-select.png"))
    # N006-02対応: 現在機能のキーボード再選択(メニューを閉じて本文へfocus)
    cur_path = pg3.evaluate("() => location.pathname")
    pg3.evaluate("() => document.querySelector('[data-testid=main-nav]').scrollIntoView()")
    pg3.keyboard.press("Tab"); pg3.wait_for_timeout(300)
    # ナビへ戻るまでTabを送る(上限20)
    for _ in range(20):
        innav = pg3.evaluate("() => { const e=document.activeElement; const n=document.querySelector('[data-testid=main-nav]'); return !!(n&&e&&n.contains(e)); }")
        if innav: break
        pg3.keyboard.press("Tab"); pg3.wait_for_timeout(150)
    pg3.keyboard.press("Enter"); pg3.wait_for_timeout(1000)
    # 現在地の葉へ矢印で移動してEnter(再選択)
    for _ in range(10):
        pg3.keyboard.press("ArrowDown"); pg3.wait_for_timeout(150)
        t = pg3.evaluate("() => (document.activeElement&&document.activeElement.textContent||'').slice(0,40)")
        if "記述統計" in t: break
    h0 = pg3.evaluate("() => history.length")
    pg3.keyboard.press("Enter"); pg3.wait_for_timeout(2000)
    h1 = pg3.evaluate("() => history.length")
    p_resel = pg3.evaluate("() => location.pathname")
    f_resel = pg3.evaluate("() => { const e=document.activeElement; const m=document.querySelector('[role=main]'); return (m&&e&&m.contains(e)?'IN-MAIN:':'OUT:')+((e&&(e.tagName||''))||'none'); }")
    popup_resel = pg3.evaluate("() => [...document.querySelectorAll('.feature-navigation-popup')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;}).length")
    pg3.screenshot(path=str(OUT / f"{RUN_ID}-d-reselect.png"))
    rec("D4-現在機能のキー再選択で閉鎖・本文フォーカス", p_resel == cur_path and h1 == h0 and f_resel.startswith("IN-MAIN") and popup_resel == 0,
        "同一path+履歴不増+IN-MAIN+popup0", f"path={p_resel} hist={h0}->{h1} focus={f_resel} popup={popup_resel}")
    pg3.close()

    # ---- Run E: 1024px overflow幅のキーボード操作 ----
    pg4 = browser.new_page(viewport={"width": 1024, "height": 700})
    pg4.goto(BASE + "/pcp", wait_until="domcontentloaded")
    pg4.wait_for_timeout(4000)
    rest_vis = pg4.locator('.feature-navigation-menu .ant-menu-overflow-item-rest').is_visible() if pg4.locator('.feature-navigation-menu .ant-menu-overflow-item-rest').count() else False
    rec("E0-overflow幅の前提(入口可視)", rest_vis, "入口可視", str(rest_vis))
    pg4.evaluate("() => document.body.focus()")
    for _ in range(40):
        pg4.keyboard.press("Tab"); pg4.wait_for_timeout(120)
        region = pg4.evaluate("() => { const e=document.activeElement; const n=document.querySelector('[data-testid=main-nav]'); return n && e ? (n.contains(e) ? 'IN-NAV' : 'OUT') : '?' }")
        if region == "IN-NAV":
            break
    e_innav = pg4.evaluate("() => { const e=document.activeElement; const n=document.querySelector('[data-testid=main-nav]'); return !!(n&&e&&n.contains(e)); }")
    rec("E1-overflow幅でTab到達", e_innav, "IN-NAV", str(e_innav))
    # N007-02対応: 実Tabで到達したactive elementを起点に矢印キーを送る。focus()直接呼び出しは使わない
    found_rest = False
    arrow_path = []
    for _ in range(8):
        pg4.keyboard.press("ArrowRight"); pg4.wait_for_timeout(250)
        t = pg4.evaluate("() => ((document.activeElement&&document.activeElement.textContent||'')).trim().slice(0,24)")
        arrow_path.append(t)
        if "その他の分類" in t:
            found_rest = True
            break
    e2_detail = pg4.evaluate("() => { const e=document.activeElement; const r=e?e.getBoundingClientRect():{width:0,height:0}; return ((e&&(e.textContent||''))||'').slice(0,40)+' '+Math.round(r.width)+'x'+Math.round(r.height); }")
    pg4.screenshot(path=str(OUT / f"{RUN_ID}-e-rest-focus.png"))
    rec("E2-overflow入口へキー到達(矢印経路)", found_rest, "その他の分類", f"found={found_rest} focus={e2_detail} path={arrow_path}")
    pg4.keyboard.press("Enter"); pg4.wait_for_timeout(1000)
    e_open = pg4.evaluate("() => [...document.querySelectorAll('.feature-navigation-popup')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;}).length")
    pg4.screenshot(path=str(OUT / f"{RUN_ID}-e-open.png"))
    pg4.keyboard.press("Escape"); pg4.wait_for_timeout(800)
    e_nav = pg4.evaluate("() => { const e=document.activeElement; const n=document.querySelector('[data-testid=main-nav]'); return !!(n&&e&&n.contains(e)); }")
    e_txt = pg4.evaluate("() => { const e=document.activeElement; return (e?(e.textContent||'none'):'none').slice(0,40); }")
    e_box = pg4.evaluate("() => { const e=document.activeElement; if(!e) return [0,0]; const r=e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }")
    e_pop = pg4.evaluate("() => [...document.querySelectorAll('.feature-navigation-popup')].filter(x=>{const q=x.getBoundingClientRect();return q.width>0&&q.height>0;}).length")
    e_after = {"inNav": e_nav, "text": e_txt, "w": e_box[0], "h": e_box[1], "pop": e_pop}
    e_open_ok = e_open >= 1
    e_esc_detail = pg4.evaluate("() => { const e=document.activeElement; const r=e?e.getBoundingClientRect():{width:0,height:0}; return ((e&&(e.textContent||''))||'').slice(0,40); }")
    rec("E3-overflow幅でEscape復帰", e_after["pop"] == 0 and e_after["inNav"] and e_after["w"] > 0 and e_open_ok,
        "popup開→0+入口へ復帰", f"{e_after} open_was={e_open} esc_focus={e_esc_detail}")
    pg4.screenshot(path=str(OUT / f"{RUN_ID}-e-escape.png"))
    # N007-02対応: overflow popup内の分類(次元削減)をEnterで開き、子popupの葉を選択
    pg4.keyboard.press("Enter"); pg4.wait_for_timeout(1000)
    for _ in range(8):
        pg4.keyboard.press("ArrowDown"); pg4.wait_for_timeout(200)
        _t = pg4.evaluate("() => (document.activeElement&&document.activeElement.textContent||'').slice(0,40)")
        if "次元削減" in _t:
            break
    pg4.keyboard.press("Enter"); pg4.wait_for_timeout(1000)
    for _ in range(8):
        pg4.keyboard.press("ArrowDown"); pg4.wait_for_timeout(200)
        _t = pg4.evaluate("() => (document.activeElement&&document.activeElement.textContent||'').slice(0,40)")
        if "因子分析" in _t or "FAMD" in _t:
            break
    _leaf_info = pg4.evaluate("() => { const e=document.activeElement; return ((e&&(e.getAttribute('role')||''))+'|'+((e&&(e.textContent||''))||'')).slice(0,80); }")
    pg4.keyboard.press("Enter"); pg4.wait_for_timeout(2500)
    _epath = pg4.evaluate("() => location.pathname")
    _emain = pg4.evaluate("() => { const e=document.activeElement; const m=document.querySelector('[role=main]'); return (m&&e&&m.contains(e)?'IN-MAIN:':'OUT:')+((e&&(e.tagName||''))||'none'); }")
    _epop = pg4.evaluate("() => [...document.querySelectorAll('.feature-navigation-popup')].filter(x=>{const q=x.getBoundingClientRect();return q.width>0&&q.height>0;}).length")
    pg4.screenshot(path=str(OUT / f"{RUN_ID}-e-leaf-select.png"))
    rec("E4-overflow幅で葉をキー選択", _epath != "/pcp" and _emain.startswith("IN-MAIN") and _epop == 0,
        "別機能へ遷移+IN-MAIN+popup0", f"path={_epath} focus={_emain} pop={_epop} leafwas={_leaf_info}")
    # E5: 現在機能(FAMD)の再選択。E3で入口へ復帰済みのため入口Enterから開始(E4と同一手順)
    _h0 = pg4.evaluate("() => history.length")
    # N007-02対応(E5): 入口Enter後は分類リストにフォーカス済み。ArrowDownで次元削減へ移動
    pg4.keyboard.press("Enter"); pg4.wait_for_timeout(1000)
    for _ in range(12):
        _t = pg4.evaluate("() => (document.activeElement&&document.activeElement.textContent||'').slice(0,40)")
        if "次元削減" in _t: break
        pg4.keyboard.press("ArrowDown"); pg4.wait_for_timeout(200)
    pg4.keyboard.press("Enter"); pg4.wait_for_timeout(1000)
    for _ in range(8):
        pg4.keyboard.press("ArrowDown"); pg4.wait_for_timeout(200)
        _t = pg4.evaluate("() => (document.activeElement&&document.activeElement.textContent||'').slice(0,40)")
        if "FAMD" in _t: break
    pg4.keyboard.press("Enter"); pg4.wait_for_timeout(2000)
    _h1 = pg4.evaluate("() => history.length")
    _pp = pg4.evaluate("() => location.pathname")
    _fm = pg4.evaluate("() => { const e=document.activeElement; const m=document.querySelector('[role=main]'); return (m&&e&&m.contains(e)?'IN-MAIN:':'OUT:')+((e&&(e.tagName||''))||'none'); }")
    _ppop = pg4.evaluate("() => [...document.querySelectorAll('.feature-navigation-popup')].filter(x=>{const q=x.getBoundingClientRect();return q.width>0&&q.height>0;}).length")
    pg4.screenshot(path=str(OUT / f"{RUN_ID}-e-reselect.png"))
    rec("E5-overflow幅で現在機能をキー再選択", _pp == _epath and _h1 == _h0 and _fm.startswith("IN-MAIN") and _ppop == 0,
        "同一path+履歴不増+IN-MAIN+popup0", f"path={_pp} hist={_h0}->{_h1} focus={_fm} pop={_ppop}")
    pg4.close(); pg.close(); browser.close()

with open(OUT / f"{RUN_ID}-results.json", "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
npass = sum(1 for c in results["cases"] if c["ok"])
print(f"TOTAL {npass}/{len(results['cases'])}")
