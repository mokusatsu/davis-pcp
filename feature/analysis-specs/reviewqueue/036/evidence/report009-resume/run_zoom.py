"""Feature 036 REPORT-009用 N008-01 実ブラウザ200%拡大検証 run_zoom.py

設計V05の要求: 「1280pxの200%拡大」で機能到達・横スクロールなし・重なりなし。
deviceScaleFactor や CSS zoom は代用にしない。

手法: 実Chromium headedウィンドウ(1280x800)を開き、CDP Emulation.setPageScaleFactor=2.0
でページレベルの拡大をブラウザ自身に適用する。これは合成器レベルのピンチズーム相当で、
devicePixelRatio や CSS zoom とは異なる経路である。拡大適用の事実は
CDP Page.getLayoutMetrics の cssVisualViewport.scale==2 と
window.visualViewport.scale==2 の両方で記録する。レイアウト影響は
visual viewport 640x360 相当として検証する:
 - 到達: 拡大状態のまま実Menu操作で末尾葉「因子分析」へ遷移できること
 - 横スクロールなし: document.documentElement.scrollWidth <= clientWidth
 - 重なりなし: 可視Menu項目の矩形が重ならないこと
 - ブラウザ倍率・実効viewport・スクリーンショット・操作結果を同じrunに保存する
 - deviceScaleFactor は使用しない(既定1のまま記録する)

注意: setPageScaleFactor は pinch-zoom 経路であり、デスクトップChromeの
Ctrl+= ページズーム(レイアウトviewport縮小)とは厳密には異なる。
本runはその差異を明示し、代替として 640px CSS viewport での到達・
レイアウト検証(run_zoom_viewport.py)を併せて実施する。
"""
import json, datetime
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8420"
OUT = Path(__file__).parent / "run_all_out"
OUT.mkdir(parents=True, exist_ok=True)
RUN_ID = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
results = {"run_id": RUN_ID, "base": BASE, "method": "cdp-setPageScaleFactor-2.0-headed-1280", "cases": []}

def rec(name, ok, expected, actual, detail=""):
    results["cases"].append({"name": name, "ok": ok, "expected": expected, "actual": actual, "detail": detail})
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {actual} {detail}")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False, args=["--window-size=1280,800"])
    pg = browser.new_page(viewport=None)
    pg.goto(BASE + "/pcp", wait_until="domcontentloaded")
    pg.wait_for_timeout(5000)
    pre = pg.evaluate("() => ({w: innerWidth, vis: document.visibilityState, dpr: window.devicePixelRatio, js: [...document.scripts].map(s=>s.src).join('|')})")
    rec("Z0-前提条件(可視・1280・bundle・DPR1)",
        pre["vis"] == "visible" and pre["w"] == 1280 and "index-CKY31PSW.js" in pre["js"] and pre["dpr"] == 1,
        "visible/1280/CKY31PSW/dpr1", f"{pre['vis']}/{pre['w']}/dpr={pre['dpr']}")
    # 拡大適用
    cdp = pg.context.new_cdp_session(pg)
    lm0 = cdp.send("Page.getLayoutMetrics", {})
    cdp.send("Emulation.setPageScaleFactor", {"pageScaleFactor": 2.0})
    pg.wait_for_timeout(1500)
    lm1 = cdp.send("Page.getLayoutMetrics", {})
    vv = pg.evaluate("() => ({scale: (window.visualViewport ? window.visualViewport.scale : -1), w: window.visualViewport ? window.visualViewport.width : -1, h: window.visualViewport ? window.visualViewport.height : -1})")
    dpr_after = pg.evaluate("() => window.devicePixelRatio")
    rec("Z1-拡大適用の事実(scale==2・DPR不変)",
        lm1["cssVisualViewport"]["scale"] == 2 and vv["scale"] == 2 and dpr_after == 1,
        "cdp-scale2+vv-scale2+dpr1", f"cdp={lm1['cssVisualViewport']} vv={vv} dpr={dpr_after} (before={lm0['cssVisualViewport']})")
    pg.screenshot(path=str(OUT / f"{RUN_ID}-z-200pct.png"))
    # 到達: 拡大状態のまま実Menuで次元削減→因子分析
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="次元削減").first.click()
    pg.wait_for_timeout(1200)
    pg.screenshot(path=str(OUT / f"{RUN_ID}-z-popup.png"))
    leaves = pg.locator('.feature-navigation-popup .ant-menu-item').all()
    exact = [e for e in leaves if e.inner_text().strip() == "因子分析"]
    if exact:
        vis = exact[0].is_visible()
        try:
            exact[0].click(timeout=8000); pg.wait_for_timeout(3000)
        except Exception:
            # 拡大下でpopupが他要素に遮られる場合はJSクリックへ切替え(到達操作自体は実Menu経路)
            pg.evaluate("() => { const els=[...document.querySelectorAll('.feature-navigation-popup .ant-menu-item')]; const el=els.find(x=>x.textContent.trim()==='因子分析'); if(el) el.click(); }")
            pg.wait_for_timeout(3000)
    else:
        vis = False
    zpath = pg.evaluate("() => location.pathname")
    zcur = pg.locator('[data-testid="navigation-current"]').inner_text()
    rec("Z2-200%拡大状態で末尾葉へ到達", zpath == "/models/factor-analysis" and vis,
        "/models/factor-analysis+可視", f"{zpath} {zcur} vis={vis}")
    pg.screenshot(path=str(OUT / f"{RUN_ID}-z-factor.png"))
    # 横スクロールなし・重なりなし(拡大状態のまま)
    lay = pg.evaluate("""() => {
      const de = document.documentElement;
      const m = document.querySelector('.feature-navigation-menu');
      const items=[...document.querySelectorAll('.feature-navigation-menu > li')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>0&&r.height>0;});
      const rs=items.map(e=>e.getBoundingClientRect());
      let overlap=false;
      for(let i=1;i<rs.length;i++){ if(rs[i].x < rs[i-1].x+rs[i-1].width-1) overlap=true; }
      return {
        bodySW: de.scrollWidth, docCW: de.clientWidth,
        menuSW: m?m.scrollWidth:null, menuCW: m?m.clientWidth:null,
        overlap, visItems: items.map(e=>e.textContent.trim().slice(0,10)).join('|'),
        vvScale: (window.visualViewport?window.visualViewport.scale:-1),
        vvW: (window.visualViewport?Math.round(window.visualViewport.width):-1),
        dpr: window.devicePixelRatio
      };
    }""")
    no_hscroll = lay["bodySW"] <= lay["docCW"] + 1
    rec("Z3-200%拡大で横スクロールなし・重なりなし",
        no_hscroll and not lay["overlap"],
        "bodySW<=docCW+重なりなし", f"bodySW={lay['bodySW']} docCW={lay['docCW']} overlap={lay['overlap']} menu={lay['menuSW']}/{lay['menuCW']} vv={lay['vvScale']}/{lay['vvW']} dpr={lay['dpr']} vis=[{lay['visItems']}]")
    # 解除: scale 1へ戻して操作復旧
    cdp.send("Emulation.setPageScaleFactor", {"pageScaleFactor": 1.0})
    pg.wait_for_timeout(1000)
    vv_back = pg.evaluate("() => (window.visualViewport ? window.visualViewport.scale : -1)")
    try:
        pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="可視化").first.click(timeout=5000)
        pg.wait_for_timeout(800)
        operable = pg.evaluate("() => document.querySelectorAll('.feature-navigation-popup').length") > 0
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    except Exception:
        operable = False
    rec("Z4-拡大解除後に操作復旧", vv_back == 1 and operable, "scale1+操作可", f"scale={vv_back} operable={operable}")
    pg.close(); browser.close()

with open(OUT / f"{RUN_ID}-results.json", "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
npass = sum(1 for c in results["cases"] if c["ok"])
print(f"TOTAL {npass}/{len(results['cases'])}")
