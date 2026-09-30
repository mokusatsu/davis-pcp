"""Feature 036 REPORT-010用 N009-01 デスクトップ実ブラウザ200%ページ倍率検証 run_zoom_real.py

手法: 実デスクトップブラウザ(Microsoft Edge Chromium)を --remote-debugging-port で
起動し、Playwrightは connect_over_cdp で接続する(自動操作ではなく実ブラウザ)。
ページ倍率は OS レベルの genuie Ctrl+= キーストローク(PowerShell SendKeys)を
フォアグラウンドの実ブラウザへ送り、window.devicePixelRatio==2.0 / innerWidth半減で
200%到達を確認する。CDP Emulation.setPageScaleFactor、deviceScaleFactor、
CSS zoom、固定viewportは一切使用しない。

記録: 到達前の倍率ステップ、200%到達時のdpr/innerWidth、実効CSS viewport、
機能一覧/overflowの到達、横スクロールなし、重なりなし、100%への復帰を同一runに保存する。
操作はすべて locator による実クリックのみ。fallbackなし(失敗時は例外→FAIL記録)。
"""
import json, datetime, subprocess, time, shutil, ctypes
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8420"
EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
UDIR = "C:/Users/lain/AppData/Local/Temp/zoomprof010"
PORT = 9343
OUT = Path(__file__).parent / "run_all_out"
OUT.mkdir(parents=True, exist_ok=True)
RUN_ID = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
results = {"run_id": RUN_ID, "base": BASE, "browser": "desktop-Edge-CDP-genuine-CtrlEqual",
           "zoom_method": "OS-level-SendKeys-CtrlEqual-to-foreground-browser", "cases": []}

PS1 = "C:/Users/lain/AppData/Local/Temp/zoom_step_010.ps1"
open(PS1, "w").write('Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait("^=")\nStart-Sleep -Milliseconds 1200\n')

def rec(name, ok, expected, actual, detail=""):
    results["cases"].append({"name": name, "ok": ok, "expected": expected, "actual": actual, "detail": detail})
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {actual} {detail}")

def state(pg):
    return pg.evaluate("() => ({iw: window.innerWidth, dpr: window.devicePixelRatio, vv: (window.visualViewport?window.visualViewport.scale:-1), vw: (window.visualViewport?Math.round(window.visualViewport.width):-1)})")

def foreground_edge():
    u32 = ctypes.windll.user32
    found = []
    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(h, l):
        n = u32.GetWindowTextLengthW(h)
        if n > 0:
            buf = ctypes.create_unicode_buffer(n + 1); u32.GetWindowTextW(h, buf, n + 1)
            if "DAVIS-PCP" in (buf.value or ""): found.append(h)
        return True
    u32.EnumWindows(cb, 0)
    if found:
        u32.SetForegroundWindow(found[0]); time.sleep(1.0)
        return True
    return False

shutil.rmtree(UDIR, ignore_errors=True)
proc = subprocess.Popen([EDGE, f"--remote-debugging-port={PORT}", f"--user-data-dir={UDIR}",
                         "--window-size=1280,800", "--no-first-run", "--force-device-scale-factor=1",
                         BASE + "/pcp"])
time.sleep(7)
try:
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}")
        ctx = browser.contexts[0]
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        pg.goto(BASE + "/pcp", wait_until="domcontentloaded"); pg.wait_for_timeout(6000)
        pre = state(pg)
        bundle = pg.evaluate("() => [...document.scripts].map(s=>s.src).join('|')")
        vis = pg.evaluate("() => document.visibilityState")
        rec("R0-前提条件(実ブラウザ・可視・bundle・dpr1)",
            vis == "visible" and abs(pre["dpr"] - 1.0) < 0.01 and "index-DwEu5-cI.js" in bundle,
            "visible/dpr1/DwEu5", f"{vis} dpr={pre['dpr']} iw={pre['iw']}")
        # 実ブラウザUI倍率を100%へリセット(Ctrl+0)してから段階的に上げる
        assert foreground_edge(), "Edge window not found"
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^0'); Start-Sleep -Milliseconds 1500;"],
                       timeout=60)
        base = state(pg)
        steps = []
        reached = False
        for i in range(8):
            assert foreground_edge(), "Edge window lost"
            subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1], timeout=60)
            st = state(pg)
            steps.append(f"{st['iw']}/{st['dpr']}")
            if abs(st["dpr"] - 2.0) < 0.01:
                reached = True
                break
        fin = state(pg)
        rec("R1-実ブラウザUIで200%ページ倍率へ到達(dpr==2)",
            reached, "dpr2.0", f"dpr={fin['dpr']} iw={fin['iw']} steps={steps}")
        pg.screenshot(path=str(OUT / f"{RUN_ID}-r-200pct.png"))
        # 到達: 200%のまま実Menuで次元削減→因子分析(完全一致・実クリックのみ)
        pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="次元削減").first.click(timeout=10000)
        pg.wait_for_timeout(1500)
        pg.screenshot(path=str(OUT / f"{RUN_ID}-r-popup.png"))
        items = pg.locator('.feature-navigation-popup .ant-menu-item').all()
        exact = [e for e in items if e.inner_text().strip() == "因子分析"]
        assert exact, "因子分析の葉なし"
        assert exact[0].is_visible(), "末尾葉が不可視"
        exact[0].click(timeout=10000); pg.wait_for_timeout(3500)
        rpath = pg.evaluate("() => location.pathname")
        rcur = pg.locator('[data-testid="navigation-current"]').inner_text()
        rec("R2-200%で末尾葉へ実クリック到達", rpath == "/models/factor-analysis",
            "/models/factor-analysis", f"{rpath} {rcur}")
        pg.screenshot(path=str(OUT / f"{RUN_ID}-r-factor.png"))
        lay = pg.evaluate("""() => {
          const de = document.documentElement;
          const m = document.querySelector('.feature-navigation-menu');
          const items=[...document.querySelectorAll('.feature-navigation-menu > li')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>0&&r.height>0;});
          const rs=items.map(e=>e.getBoundingClientRect());
          let overlap=false;
          for(let i=1;i<rs.length;i++){ if(rs[i].x < rs[i-1].x+rs[i-1].width-1) overlap=true; }
          return {bodySW: de.scrollWidth, docCW: de.clientWidth, menuSW: m?m.scrollWidth:null,
                  menuCW: m?m.clientWidth:null, overlap,
                  vis: items.map(e=>e.textContent.trim().slice(0,10)).join('|'),
                  iw: window.innerWidth, dpr: window.devicePixelRatio,
                  vv: (window.visualViewport?window.visualViewport.scale:-1)};
        }""")
        rec("R3-200%で横スクロールなし・重なりなし",
            lay["bodySW"] <= lay["docCW"] + 1 and not lay["overlap"],
            "bodySW<=docCW+重なりなし",
            f"bodySW={lay['bodySW']} docCW={lay['docCW']} overlap={lay['overlap']} menu={lay['menuSW']}/{lay['menuCW']} iw={lay['iw']} dpr={lay['dpr']} vv={lay['vv']} vis=[{lay['vis']}]")
        # 復帰: Ctrl+0で100%へ戻し、操作復旧を確認
        assert foreground_edge(), "Edge window lost before reset"
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^0'); Start-Sleep -Milliseconds 1500;"],
                       timeout=60)
        back = state(pg)
        try:
            pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="可視化").first.click(timeout=8000)
            pg.wait_for_timeout(1000)
            operable = pg.evaluate("() => document.querySelectorAll('.feature-navigation-popup').length") > 0
            pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
        except Exception:
            operable = False
        rec("R4-100%へ復帰し操作復旧", abs(back["dpr"] - 1.0) < 0.01 and operable,
            "dpr1+操作可", f"dpr={back['dpr']} iw={back['iw']} operable={operable}")
        browser.close()
finally:
    proc.terminate()

with open(OUT / f"{RUN_ID}-results.json", "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
npass = sum(1 for c in results["cases"] if c["ok"])
print(f"TOTAL {npass}/{len(results['cases'])}")
