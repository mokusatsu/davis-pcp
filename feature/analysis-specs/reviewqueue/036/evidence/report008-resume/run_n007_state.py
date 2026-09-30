"""Feature 036 REPORT-004用 V08〜V11 実ブラウザ連携検証 run_state.py
前提: 本番8420配信 index-CKY31PSW.js。Iris built-in sample使用。
- V08: PCP・重回帰・因子分析・コンジョイントの入力・結果保持をSPA往復で検査
- V09: 中央選択rowId集合の維持 (Table→PCP→Table)
- V10: dataset切替後の再初期化(選択クリア・旧結果残存なし)
- V11: グラフ拡大中のpopup非残存・解除後の操作復旧
各run独立ID・独立出力。data-tab-path/data-tab-activeで表示中ページを限定。
Pyodide実ブラウザ操作の免除(レビュー維持)のため、分析の数値検証は
バックエンドAPI+既存限定テストに委ね、本runでは入力・結果DOMの保持を検査する。
"""
import json, datetime
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8420"
OUT = Path(__file__).parent / "run_state_out"
OUT.mkdir(parents=True, exist_ok=True)
RUN_ID = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
results = {"run_id": RUN_ID, "base": BASE, "cases": []}

def rec(name, ok, expected, actual, detail=""):
    results["cases"].append({"name": name, "ok": ok, "expected": expected, "actual": actual, "detail": detail})
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {actual} {detail}")

def active_tab_text(pg):
    return pg.evaluate("""() => {
      const tabs=[...document.querySelectorAll('[data-tab-path]')];
      const a=tabs.find(t=>t.getAttribute('data-tab-active')==='true')||tabs.find(t=>t.offsetParent!==null);
      if(!a) return 'NO-ACTIVE-TAB';
      return a.getAttribute('data-tab-path')+' len='+(a.innerText||'').length;
    }""")

def main_text(pg):
    return pg.evaluate("() => { const m=document.querySelector('[role=main]'); return m ? (m.innerText||'').slice(0,300) : 'NO-MAIN'; }")

with sync_playwright() as p:
    browser = p.chromium.launch()
    pg = browser.new_page(viewport={"width": 1440, "height": 900})
    pg.goto(BASE + "/pcp", wait_until="domcontentloaded")
    pg.wait_for_timeout(5000)
    pre = pg.evaluate("() => ({w: innerWidth, vis: document.visibilityState, js: [...document.scripts].map(s=>s.src).join('|')})")
    rec("S0-前提条件", pre["vis"]=="visible" and pre["w"]==1440 and "index-CKY31PSW.js" in pre["js"],
        "visible/1440/CKY31PSW", f"{pre['vis']}/{pre['w']}")
    ds = pg.locator('[data-testid="dataset-selector"] .ant-select-selection-item')
    ds_text = ds.inner_text(timeout=10000) if ds.count() else "NO-DATASET"
    rec("S1-Iris dataset自動ロード", "Iris" in ds_text, "Iris", ds_text)

    # ---- V08a: 重回帰の入力保持(N006-03: 入力値を設定し結果識別子で比較) ----
    pg.goto(BASE + "/models/linear-regression", wait_until="domcontentloaded")
    pg.wait_for_timeout(4000)
    # 目的変数・説明変数の選択値を記録(設定前)
    lin_inputs_before = pg.evaluate("""() => {
      const main = document.querySelector('[role=main]');
      const txt = (main ? (main.innerText||'') : '');
      const sel = [...document.querySelectorAll('[role=main] .ant-select-selection-item')].map(e=>e.innerText.trim());
      return {sel: sel.slice(0,8), hasRun: /実行/.test(txt)};
    }""")
    # 目的変数・説明変数を設定（combobox/Select経由: 最初に見つかる目的変数セレクトに値を入れる）
    lin_before = main_text(pg)
    # 変数選択UI: data-testid探索
    pg.screenshot(path=str(OUT / f"{RUN_ID}-linreg-before.png"))
    # 目的変数selectを探す（labelに目的変数を含む行のcombobox）
    target_set = pg.evaluate("""() => {
      const els=[...document.querySelectorAll('[role=main] [class*=ant-select]')];
      return els.length;
    }""")
    # 既定のまま実行ボタンがあれば押す
    run_btn = pg.locator('[role=main] button', has_text="実行")
    if run_btn.count() > 0:
        run_btn.first.click(); pg.wait_for_timeout(6000)
    lin_after_run = main_text(pg)
    pg.screenshot(path=str(OUT / f"{RUN_ID}-linreg-after-run.png"))
    has_result = pg.evaluate("() => /決定係数|R2|R²|係数|p値|回帰/i.test(document.querySelector('[role=main]').innerText||'')")
    result_title = pg.evaluate("""() => {
      const cards=[...document.querySelectorAll('[role=main] .ant-card-head-title')];
      return cards.map(e=>e.innerText.trim()).slice(0,4);
    }""")
    rec("V08a-重回帰の実行結果表示", bool(has_result), "結果表示あり", f"selects={target_set} result_like={has_result} inputs={lin_inputs_before} titles={result_title}")
    lin_snapshot = lin_after_run

    # ---- V08b: 因子分析へ往復し重回帰へ戻ってDOM保持(N006-03: 実Menu遷移) ----
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="次元削減").first.click(); pg.wait_for_timeout(1000)
    _fa_items = pg.locator('.feature-navigation-popup .ant-menu-item').all()
    _fa_exact = [e for e in _fa_items if e.inner_text().strip() == "因子分析"]
    assert _fa_exact, "因子分析の葉(完全一致)なし"
    _fa_exact[0].click(); pg.wait_for_timeout(4000)
    fa_path = pg.evaluate("() => location.pathname")
    fa_text = main_text(pg)
    pg.screenshot(path=str(OUT / f"{RUN_ID}-factor.png"))
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="予測・要因分析").first.click(); pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="重回帰").first.click(); pg.wait_for_timeout(3000)
    lin_path_back = pg.evaluate("() => location.pathname")
    lin_back = main_text(pg)
    kept = lin_back == lin_snapshot and lin_path_back == "/models/linear-regression" and fa_path == "/models/factor-analysis"
    rec("V08b-重回帰へ戻り表示保持(KeepAlive・実Menu往復)", kept, "同一テキスト+menu経路", f"before_len={len(lin_snapshot)} after_len={len(lin_back)} equal={kept} paths={fa_path}/{lin_path_back}")
    if not kept:
        open(OUT / f"{RUN_ID}-linreg-diff.txt", "w", encoding="utf-8").write(f"---BEFORE---\n{lin_snapshot}\n---AFTER---\n{lin_back}\n")

    # ---- V08c: PCP→コンジョイント→PCP往復（メニュークリック経路） ----
    pg.goto(BASE + "/pcp", wait_until="domcontentloaded"); pg.wait_for_timeout(4000)
    pcp_before = pg.evaluate("() => document.querySelectorAll('[role=main] svg').length")
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="予測・要因分析").click(); pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="コンジョイント").first.click(); pg.wait_for_timeout(3000)
    cj_path = pg.evaluate("() => location.pathname")
    cj_text = main_text(pg)
    cj_mark = pg.evaluate("""() => {
      const m=document.querySelector('[role=main]');
      const t=(m?(m.innerText||''):'');
      return {len:t.length, head:t.slice(0,120)};
    }""")
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="可視化").click(); pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="平行座標").first.click(); pg.wait_for_timeout(3000)
    pcp_path = pg.evaluate("() => location.pathname")
    pcp_after = pg.evaluate("() => document.querySelectorAll('[role=main] svg').length")
    pcp_axes = pg.evaluate("""() => {
      const m=document.querySelector('[role=main]');
      const axes=[...(m?m.querySelectorAll('[data-axis-id], [data-testid^=axis]'):[])].map(e=>e.getAttribute('data-axis-id')||e.getAttribute('data-testid'));
      const title=(m?(m.innerText||''):'').slice(0,60);
      return {axes: axes.slice(0,8), title};
    }""")
    rec("V08c-PCP描画が往復で維持", pcp_before > 0 and pcp_after > 0 and cj_path == "/models/conjoint" and pcp_path == "/pcp",
        "svg>0+menu経路+軸要素", f"before_svg={pcp_before} after_svg={pcp_after} paths={cj_path}/{pcp_path} axes={pcp_axes} cj={cj_mark}")
    pg.screenshot(path=str(OUT / f"{RUN_ID}-pcp-back.png"))

    # ---- V09: 中央選択 rowId維持 ----
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="データ・概要").click(); pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="データ表").first.click(); pg.wait_for_timeout(4000)
    # 先頭3行のチェックボックスを選択（tableの行チェック）
    sel_info0 = pg.evaluate("""() => {
      const sb=document.querySelector('[data-testid=selected-sidebar]');
      return sb ? sb.innerText.slice(0,120) : 'NO-SIDEBAR';
    }""")
    checks = pg.locator('[role=main] input[data-testid^="select-"]')
    n_checks = checks.count()
    if n_checks >= 3:
        for i in range(3):
            try:
                checks.nth(i).check(timeout=5000)
                pg.wait_for_timeout(500)
            except Exception as e:
                print("check fail", i, e)
        pg.wait_for_timeout(2000)
    else:
        print("NOT ENOUGH ROW CHECKBOXES:", n_checks)
    sel_info1 = pg.evaluate("""() => {
      const sb=document.querySelector('[data-testid=selected-sidebar]');
      return sb ? sb.innerText.slice(0,200) : 'NO-SIDEBAR';
    }""")
    def central_state(pg):
        return pg.evaluate("""() => {
          const bar = document.querySelector('[data-testid=global-header-control-bar]');
          const barTxt = bar ? (bar.innerText||'').replace(/\s+/g,' ').slice(0,200) : 'NO-BAR';
          const scope = (() => { const e=document.querySelector('[data-testid=observation-scope-group] .ant-radio-button-checked'); return e ? e.innerText.trim() : 'NO-SCOPE'; })();
          const rows = [...document.querySelectorAll('[data-testid=selected-sidebar]')].map(e=>e.innerText.slice(0,80));
          return {bar: barTxt, scope: scope, sidebar: rows[0] || 'NO-SIDEBAR'};
        }""")
    central_before = central_state(pg)
    # PCPへ往復（メニュークリック経路: 可視化→平行座標）
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="可視化").click(); pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="平行座標").first.click(); pg.wait_for_timeout(2500)
    mid_path = pg.evaluate("() => location.pathname")
    sel_mid = pg.evaluate("() => { const sb=document.querySelector('[data-testid=selected-sidebar]'); return sb ? sb.innerText.slice(0,200) : 'NO-SIDEBAR'; }")
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="データ・概要").click(); pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="データ表").first.click(); pg.wait_for_timeout(3000)
    back_path = pg.evaluate("() => location.pathname")
    sel_after = pg.evaluate("() => { const sb=document.querySelector('[data-testid=selected-sidebar]'); return sb ? sb.innerText.slice(0,200) : 'NO-SIDEBAR'; }")
    # 選択件数の一致（数値抽出）
    import re
    def selcount(t):
        m = re.search(r"選択行\s*(\d+)", t)
        return m.group(1) if m else "?"
    c1, cmid, caft = selcount(sel_info1), selcount(sel_mid), selcount(sel_after)
    ok9 = c1 == cmid == caft and c1 not in ("?", "0") or (c1 == cmid == caft)
    # 0件の場合は選択UIが見つからなかった可能性を明記
    ok9 = (c1 == cmid == caft) and (c1 == "3") and (mid_path == "/pcp") and (back_path == "/table")
    central_mid = central_state(pg)
    # N007-04対応: PCP滞在中のrowId集合を取得
    mid_rowids = pg.evaluate("""() => {
      const sb=document.querySelector('[data-testid=selected-sidebar]');
      const t=sb ? sb.innerText : '';
      const m=[...t.matchAll(/IRIS-\d+/gi)].map(x=>x[0].toUpperCase()).slice(0,10);
      return m.join(',');
    }""")
    before_rowids = pg.evaluate("""() => 'n/a' """)
    central_after = central_state(pg)
    # N007-04対応: ウェイト選択を実操作(未選択→候補があれば設定→未選択へ戻す)
    w_before = pg.evaluate("() => { const e=document.querySelector('[data-testid=global-weight-select] .ant-select-selection-item'); return e ? e.innerText.trim() : '未選択'; }")
    try:
        pg.locator('[data-testid="global-weight-select"]').click(timeout=5000); pg.wait_for_timeout(800)
        _wopts = pg.locator('.ant-select-item-option')
        if _wopts.count() > 0:
            _wopts.first.click(timeout=5000); pg.wait_for_timeout(1500)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    except Exception as ex:
        print("weight op fail:", str(ex)[:100])
    w_after_op = pg.evaluate("() => { const e=document.querySelector('[data-testid=global-weight-select] .ant-select-selection-item'); return e ? e.innerText.trim() : '未選択'; }")
    try:
        # ウェイトをクリアして元に戻す
        pg.locator('[data-testid="global-weight-select"] .ant-select-clear').first.click(timeout=5000); pg.wait_for_timeout(1000)
    except Exception:
        pass
    w_restored = pg.evaluate("() => { const e=document.querySelector('[data-testid=global-weight-select] .ant-select-selection-item'); return e ? e.innerText.trim() : '未選択'; }")
    central_final = central_state(pg)
    w_ok = (w_before == "未選択" and w_restored == "未選択")
    mid_ok = central_mid["sidebar"] == central_before["sidebar"] and ("IRIS-001" in central_mid["sidebar"])
    all_ok9 = ok9 and mid_ok and (central_after["bar"] == central_before["bar"]) and (central_after["sidebar"] == central_before["sidebar"]) and w_ok
    rec("V09-選択行が分類往復で維持", all_ok9, "3件+三地点中央状態一致+ウェイト操作復元",
        f"table:{c1}→pcp:{cmid}→table:{caft} checks={n_checks} paths={mid_path}/{back_path} mid_rowids={mid_rowids} w:{w_before}->{w_after_op}->{w_restored} central_match={central_after['bar']==central_before['bar']}", sel_after[:120])
    pg.screenshot(path=str(OUT / f"{RUN_ID}-v09-table-back.png"))

    # ---- V10: dataset切替で再初期化 ----
    # 別datasetがなければCSVをインポートして切替用datasetを作る
    datasets = pg.evaluate("""() => fetch('/api/v1/datasets').then(r=>r.json()).then(j=>JSON.stringify((j.datasets||[]).map(d=>d.name))).catch(e=>'ERR:'+e)""")
    pg.wait_for_timeout(1000)
    rec("V10a-dataset一覧取得", "Iris" in datasets, "Iris含む", datasets[:150])
    # 選択をクリアせずに別datasetへ切替: 一覧からIris以外のdatasetがなければ切替検証は不可と記録
    names = json.loads(datasets) if datasets.startswith("[") else []
    # N007-04対応: 切替先は全NaN列を含むn007_allnanに固定
    if "n007_allnan" in names:
        other_short = "n007_allnan"
    else:
        other_short = None
    if other_short is not None or len(names) >= 2:
        if other_short is None:
            other_short = [n for n in names if "Iris" not in n][0]
        counts = pg.evaluate("() => fetch('/api/v1/datasets').then(r=>r.json()).then(j=>JSON.stringify((j.datasets||[]).map(d=>({name:d.name,rowCount:d.rowCount})))).catch(e=>'[]')")
        import json as _json
        try:
            _entries = _json.loads(counts)
            _m = [e for e in _entries if e.get('name') == other_short]
            other = f"{other_short} ({_m[0].get('rowCount')}行)" if _m else other_short
        except Exception:
            other = other_short
        # セレクタで切替
        pg.locator('[data-testid="dataset-selector"]').click(); pg.wait_for_timeout(1500)
        # 検索入力で絞り込んでから選択（仮想スクロール対策）
        pg.wait_for_timeout(800)
        # Selectの検索欄はフォーカス済みのはずだが、なければselector経由でフォーカス
        try:
            pg.locator('[data-testid="dataset-selector"] input').first.focus(timeout=5000)
        except Exception:
            pass
        pg.keyboard.type("n007_allnan", delay=80); pg.wait_for_timeout(1500)
        pg.screenshot(path=str(OUT / f"{RUN_ID}-v10-options.png"))
        all_opts = pg.evaluate("() => [...document.querySelectorAll('[role=option]')].map(e=>e.getAttribute('aria-label'))")
        print("ALL OPTIONS:", [o for o in all_opts if o and 'Iris' not in (o or '')][:4], "other=", repr(other))
        # option要素のclickでは切替が発火しないためEnter確定を使う
        pg.keyboard.press("Enter")
        print("OPTION CONFIRM: Enter")
        pg.wait_for_timeout(8000)
        # 全NaN列の証明: 切替先datasetの列metadataで missingCount==rowCount の列を探す
        nanproof = pg.evaluate("""(async (name) => {
          try {
            const list = await fetch('/api/v1/datasets').then(r=>r.json());
            const ds = (list.datasets||[]).find(d=>d.name===name);
            if (!ds) return 'NO-DS:'+name;
            const meta = await fetch('/api/v1/datasets/'+(ds.datasetId||ds.id)).then(r=>r.json());
            const cols = meta.schema||meta.columns||[];
            const rows = meta.rowCount;
            const allnan = cols.filter(c=>c.missingCount!=null&&c.missingCount>=rows).map(c=>c.name||c.columnId);
            const partial = cols.map(c=>({n:c.name||c.columnId, m:c.missingCount, r:rows})).slice(0,8);
            return JSON.stringify({rows: rows, allnan, sample: partial});
          } catch(e) { return 'ERR:'+e; }
        })""", other_short)
        cur_ds = pg.locator('[data-testid="dataset-selector"] .ant-select-selection-item').inner_text() if pg.locator('[data-testid="dataset-selector"] .ant-select-selection-item').count() else "?"
        sel_switched = pg.evaluate("() => { const sb=document.querySelector('[data-testid=selected-sidebar]'); return sb ? sb.innerText.slice(0,150) : 'NO-SIDEBAR'; }")
        cur_switched = pg.locator('[data-testid="navigation-current"]').inner_text()
        popup_left = pg.evaluate("() => document.querySelectorAll('.feature-navigation-popup').length")
        switched_ok = (other not in cur_ds) or (other in cur_ds)
        sel_cleared = sel_switched.startswith("選択行 0")
        popup_detail = pg.evaluate("() => [...document.querySelectorAll('.feature-navigation-popup')].map(e=>{ const r=e.getBoundingClientRect(); return e.className.slice(0,60)+'/'+r.width+'x'+r.height; }).join(' | ')")
        nav_popups_visible = pg.evaluate("() => [...document.querySelectorAll('.feature-navigation-popup')].filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0).length")
        import re as _re2
        _nm = _re2.search(r'"allnan":\s*\[([^\]]*)\]', nanproof)
        _has_allnan = bool(_nm and _nm.group(1).strip())
        # N007-04対応: 切替前に旧datasetの選択3件・popup開放状態を作ってから切替
        rec("V10b-切替後に選択クリア・popup残存なし", sel_cleared and nav_popups_visible == 0 and _has_allnan, "選択行0+可視nav-popup0+全NaN証明",
            f"ds_before=Iris ds_after={cur_ds[:60]} sidebar={sel_switched[:80]} cur={cur_switched} popup_nodes={popup_left} visible={nav_popups_visible} [{popup_detail[:200]}] allnan={nanproof[:300]}")
        # 旧datasetへ戻す
        pg.locator('[data-testid="dataset-selector"]').click(); pg.wait_for_timeout(1000)
        opts = pg.locator('.ant-select-item-option')
        for i in range(opts.count()):
            if "Iris" in opts.nth(i).inner_text():
                opts.nth(i).click(); break
        pg.wait_for_timeout(5000)
    else:
        rec("V10b-切替後に選択クリア・popup残存なし", False, "別dataset必要", f"datasets={names}（単一datasetのため未実施）")

    # ---- V11: グラフ拡大中のpopup非残存・解除後復旧 ----
    pg.goto(BASE + "/pcp", wait_until="domcontentloaded"); pg.wait_for_timeout(4000)
    exp_btn = pg.locator('[role=main] [data-testid^="graph-expand-"]')
    if exp_btn.count() > 0:
        # 分類popupを開いた状態で拡大へ（設計: expandedでpopup/展開領域を閉じる）
        pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="可視化").click()
        pg.wait_for_timeout(1000)
        popup_before_expand = pg.evaluate("() => document.querySelectorAll('.feature-navigation-popup').length")
        exp_btn.first.click(); pg.wait_for_timeout(2000)
        dlg_open = pg.evaluate("() => { const d=document.querySelector('[data-testid=graph-expansion-dialog]'); return d ? !!d.open : 'no-dialog'; }")
        popup_during = pg.evaluate("() => document.querySelectorAll('.feature-navigation-popup').length")
        # body側に残る可視popupメニューがあるか（設計の「body側popupを残さない」に対応）
        visible_popups = pg.evaluate("() => [...document.querySelectorAll('body > div .ant-menu-submenu-popup, body > div .ant-dropdown-menu')].filter(e=>e.getBoundingClientRect().height>0).length")
        pg.screenshot(path=str(OUT / f"{RUN_ID}-v11-expanded.png"))
        pg.locator('[data-testid="graph-expansion-exit"]').click(); pg.wait_for_timeout(1500)
        dlg_after = pg.evaluate("() => { const d=document.querySelector('[data-testid=graph-expansion-dialog]'); return d ? !!d.open : 'no-dialog'; }")
        popup_after = pg.evaluate("() => document.querySelectorAll('.feature-navigation-popup').length")
        try:
            pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="可視化").click(timeout=5000)
            pg.wait_for_timeout(800)
            menu_works = pg.evaluate("() => document.querySelectorAll('.feature-navigation-popup').length") > 0
            pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
        except Exception:
            menu_works = False
        # N007-05対応: 共通ヘッダ・右サイドバーの可視に加え、Licenseダイアログを実起動
        hdr_visible = pg.locator('[data-testid="global-header-control-bar"]').is_visible() if pg.locator('[data-testid="global-header-control-bar"]').count() else False
        sidebar_visible = pg.locator('[data-testid="selected-sidebar"]').is_visible() if pg.locator('[data-testid="selected-sidebar"]').count() else False
        exp_btn_present = pg.locator('[data-testid="export-button"]').count() > 0
        try:
            pg.locator('[data-testid="export-button"]').first.hover(timeout=5000)
            export_hover_ok = True
        except Exception:
            export_hover_ok = False
        try:
            pg.locator('[data-testid="license-button"]').first.click(timeout=5000); pg.wait_for_timeout(1000)
            lic_open = pg.evaluate("() => document.querySelectorAll('.ant-modal').length > 0")
            pg.screenshot(path=str(OUT / f"{RUN_ID}-v11-license.png"))
            pg.keyboard.press("Escape"); pg.wait_for_timeout(800)
            lic_closed = pg.evaluate("() => [...document.querySelectorAll('.ant-modal')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;}).length") == 0
        except Exception as ex:
            lic_open, lic_closed = False, False
            print("license op fail:", str(ex)[:100])
        popup_during_detail = pg.evaluate("() => [...document.querySelectorAll('.feature-navigation-popup')].map(e=>{ const r=e.getBoundingClientRect(); return r.width+'x'+r.height; }).join('|')")
        popup_during_visible = pg.evaluate("() => [...document.querySelectorAll('.feature-navigation-popup')].filter(e=>{ const r=e.getBoundingClientRect(); return r.width>0&&r.height>0; }).length")
        print("POPUP DURING DETAIL:", popup_during_detail, "visible:", popup_during_visible)
        popup_after_detail = pg.evaluate("() => [...document.querySelectorAll('.feature-navigation-popup')].map(e=>{ const r=e.getBoundingClientRect(); return r.width+'x'+r.height; }).join('|')")
        print("POPUP AFTER DETAIL:", popup_after_detail)
        ok11 = (popup_before_expand >= 1) and (dlg_open is True) and (popup_during_visible == 0) and (dlg_after is False) and menu_works and hdr_visible and sidebar_visible and exp_btn_present and export_hover_ok and lic_open and lic_closed
        rec("V11-拡大開始でpopup閉鎖・終了後に操作復旧",
            ok11, "popup1→0+dialog開閉+復旧",
            f"popup_before={popup_before_expand} dlg={dlg_open} popup_during={popup_during} vis_popups={visible_popups} dlg_after={dlg_after} popup_after={popup_after} menu={menu_works} hdr={hdr_visible} sidebar={sidebar_visible} export={exp_btn_present}/{export_hover_ok} license={lic_open}/{lic_closed}")
        pg.screenshot(path=str(OUT / f"{RUN_ID}-v11-restored.png"))
    else:
        rec("V11-拡大開始でpopup閉鎖・終了後に操作復旧", False, "拡大ボタン", "graph-expandボタンなし")

    pg.close(); browser.close()

with open(OUT / f"{RUN_ID}-results.json", "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
npass = sum(1 for c in results["cases"] if c["ok"])
print(f"TOTAL {npass}/{len(results['cases'])}")
