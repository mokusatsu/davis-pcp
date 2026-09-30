from playwright.sync_api import sync_playwright
BASE = "http://127.0.0.1:5181"
with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True, args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.goto(BASE + "/pcp", timeout=30000)
    pg.wait_for_selector('[data-testid="pcp-canvas"]', timeout=20000)
    pg.wait_for_timeout(2500)
    info = pg.evaluate("""(() => {
      const els = [...document.querySelectorAll('[data-testid^="axis-control-"]')];
      const boxes = els.map(el => { const r = el.getBoundingClientRect(); return { id: el.getAttribute('data-testid'), l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) }; });
      let overlap = 0;
      const sorted = [...boxes].sort((a, b) => a.l - b.l);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].l < sorted[i-1].r - 1) overlap++;
      }
      return { n: boxes.length, overlap, boxes: boxes.slice(0, 12) };
    })()""")
    print(info)
    b.close()
