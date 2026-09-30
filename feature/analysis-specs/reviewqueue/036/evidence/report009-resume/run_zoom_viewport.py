"""Feature 036 REPORT-009用 N008-01 代替検証 run_zoom_viewport.py

デスクトップChromeの200%ページズームは CSS viewport を半分にする
(1280px幅ウィンドウ x 200% = 640 CSS px相当)。headless Playwrightで
キーボードズームが効かない環境のため、レイアウト等価の 640px CSS viewport
(通常DPR=1、deviceScaleFactor不使用)で到達・横スクロール・重なりを検証する。
run_zoom.py (合成器ズーム) と合わせ、両面でV05相当を確認する。
"""
import json, datetime
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8420"
OUT = Path(__file__).parent / "run_all_out"
OUT.mkdir(parents=True, exist_ok=True)
RUN_ID = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
results = {"run_id": RUN_ID, "base": BASE, "method": "css-viewport-640-equiv-200pct", "cases": []}

def rec(name, ok, expected, actual, detail=""):
    results["cases"].append({"name": name, "ok": ok, "expected": expected, "actual": actual, "detail": detail})
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {actual} {detail}")

with sync_playwright() as p:
    browser = p.chromium.launch()
    pg = browser.new_page(viewport={"width": 640, "height": 360})
    pg.goto(BASE + "/pcp", wait_until="domcontentloaded")
    pg.wait_for_timeout(5000)
    pre = pg.evaluate("() => ({w: innerWidth, vis: document.visibilityState, dpr: window.devicePixelRatio, js: [...document.scripts].map(s=>s.src).join('|')})")
    rec("V0-前提条件(640 CSS px・DPR1・bundle)",
        pre["vis"] == "visible" and pre["w"] == 640 and pre["dpr"] == 1 and "index-CKY31PSW.js" in pre["js"],
        "visible/640/dpr1/CKY31PSW", f"{pre['vis']}/{pre['w']}/dpr={pre['dpr']}")
    pg.screenshot(path=str(OUT / f"{RUN_ID}-v640-pcp.png"))
    # 狭幅UI: 機能一覧ボタンでパネル→分類→末尾葉へ到達
    btn = pg.locator('[data-testid="feature-list-button"]').is_visible()
    rec("V1-200%相当幅で機能一覧ボタン", btn, "ボタン表示", str(btn))
    reached, wpath, wcur = False, "", ""
    if btn:
        pg.locator('[data-testid="feature-list-button"]').click(); pg.wait_for_timeout(1000)
        subs = pg.locator('#feature-list-panel .ant-menu-submenu-title')
        for i in range(subs.count()):
            if "次元削減" in subs.nth(i).inner_text():
                subs.nth(i).click(); pg.wait_for_timeout(800)
                break
        leaf = [e for e in pg.locator('#feature-list-panel .ant-menu-item').all() if e.inner_text().strip() == "因子分析"]
        if leaf:
            try: leaf[0].scroll_into_view_if_needed(timeout=5000)
            except Exception: pass
            pg.wait_for_timeout(300)
            leaf[0].click(); pg.wait_for_timeout(2500)
            wpath = pg.evaluate("() => location.pathname")
            wcur = pg.locator('[data-testid="navigation-current"]').inner_text()
            reached = (wpath == "/models/factor-analysis")
    rec("V2-200%相当幅で末尾葉へ到達", btn and reached, "/models/factor-analysis", f"{wpath} {wcur}")
    pg.screenshot(path=str(OUT / f"{RUN_ID}-v640-factor.png"))
    lay = pg.evaluate("""() => {
      const de = document.documentElement;
      const items=[...document.querySelectorAll('#feature-list-panel .ant-menu-item, .feature-navigation-menu > li')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>0&&r.height>0;});
      const rs=items.map(e=>e.getBoundingClientRect());
      let overlap=false;
      for(let i=1;i<rs.length;i++){ if(rs[i].x < rs[i-1].x+rs[i-1].width-1 && Math.abs(rs[i].y-rs[i-1].y)<2) overlap=true; }
      return {bodySW: de.scrollWidth, docCW: de.clientWidth, overlap, dpr: window.devicePixelRatio, iw: window.innerWidth};
    }""")
    rec("V3-200%相当幅で横スクロールなし・重なりなし",
        lay["bodySW"] <= lay["docCW"] + 1 and not lay["overlap"],
        "bodySW<=docCW+重なりなし", f"bodySW={lay['bodySW']} docCW={lay['docCW']} overlap={lay['overlap']} dpr={lay['dpr']} iw={lay['iw']}")
    pg.close(); browser.close()

with open(OUT / f"{RUN_ID}-results.json", "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
npass = sum(1 for c in results["cases"] if c["ok"])
print(f"TOTAL {npass}/{len(results['cases'])}")
