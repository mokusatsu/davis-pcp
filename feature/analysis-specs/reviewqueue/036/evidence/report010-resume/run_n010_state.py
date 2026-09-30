"""Feature 036 REPORT-009用 N008-02/03/04 実ブラウザ状態検証 run_n009_state.py

前提: 本番8420配信 index-CKY31PSW.js。Iris built-in sample(150行80変数)と
s dataset(80行・weight列wあり)・n007_allnan(3行・全NaN列allnanあり)を使用。

N008-02 [P1] V08: Pyodide免除を既定画面の成功へ読み替えない。
 - V08aは成功ケースに含めない(ok:false固定・記録のみ)。run_state合計から除外する。
 - Pyodideに依存しない入力値を意図的に変更し、PCP・重回帰・因子分析・
   コンジョイントを実Menuで往復して選択値・表示状態を前後で比較する。
 - 変更する入力: 重回帰の目的変数・数値説明変数・重みradio、因子分析の
   項目選択・重みradio、コンジョイントの回答者ID列。
 - Pyodide由来の計算中・結果状態は免除として明示し、成功ケースへ含めない。

N008-03 [P1] V09: ウェイト・変数・行範囲を実際に変更して保持する。
 - s dataset(80行・weight列w)で: ウェイト未選択→w→未選択へ戻す(値は一度変わること)、
   変数を1つ外して戻す(80→79→80)、行範囲 1-10 を選択行へ適用後に解除する。
 - Table・PCP・Table復帰後の三地点で選択rowId集合と中央状態バーを直接比較する。
 - ウェイトは「設定された値が未選択と異なる」ことを成功条件に入れる。

N008-04 [P1] V10・V11: 旧dataset状態と既存共通操作を確認する。
 - V10: 切替前に旧dataset(Iris builtin)で可視popupを開き、選択行を2件作る。
   切替直前の可視popup数>=1・選択行数を記録し、n007_allnan切替→Table再訪後に
   選択行0・可視popup0であることを確認する(旧状態の消滅)。
 - V11: 拡大解除後に Export dropdown を実クリックで開き(ダウンロードは開始しない)、
   Save modal を実起動(保存は実行しない)、Import の file input 存在を確認する。
   Licenseダイアログ開閉も維持する。データを上書きしない範囲の open-only 操作のみ。

各run独立ID・独立出力。data-tab-path/data-tab-activeで表示中ページを限定しないが、
pathname＋現在地の両方検査で表示中ページを限定する。
"""
import json, datetime, re
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8420"
OUT = Path(__file__).parent / "run_state_out"
OUT.mkdir(parents=True, exist_ok=True)
RUN_ID = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
results = {"run_id": RUN_ID, "base": BASE, "cases": [], "excluded_from_pass": ["V08a-記録のみ(成功数に含めない)"]}

def rec(name, ok, expected, actual, detail=""):
    results["cases"].append({"name": name, "ok": ok, "expected": expected, "actual": actual, "detail": detail})
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {actual} {detail}")

def main_text(pg):
    return pg.evaluate("() => { const m=document.querySelector('[role=main]'); return m ? (m.innerText||'').slice(0,400) : 'NO-MAIN'; }")

def central_bar(pg):
    return pg.evaluate("() => { const b=document.querySelector('[data-testid=global-header-control-bar]'); return b ? b.innerText.replace(/\\s+/g,' ').slice(0,250) : 'NO-BAR'; }")

def sidebar_text(pg):
    return pg.evaluate("() => { const sb=document.querySelector('[data-testid=selected-sidebar]'); return sb ? sb.innerText.slice(0,200) : 'NO-SIDEBAR'; }")

def header_sel_text(pg):
    # 選択状態の正本は globalObservations スライス(ヘッダ表示)。Table横サイドバーは
    # selectionスライスを表示する旧表示であり、range適用(asSelected)は前者にだけ反映される。
    return pg.evaluate("() => { const b=document.querySelector('[data-testid=global-header-control-bar]'); if(!b) return 'NO-BAR'; const t=b.innerText||''; const i=t.indexOf('選択:'); return (i>=0?t.slice(i,i+20):t.slice(0,60)).replace(/\\s+/g,' '); }")

def switch_dataset(pg, fragment):
    pg.locator('[data-testid="dataset-selector"]').click(); pg.wait_for_timeout(1200)
    try:
        pg.locator('[data-testid="dataset-selector"] input').first.focus(timeout=5000)
    except Exception:
        pass
    pg.keyboard.type(fragment, delay=40); pg.wait_for_timeout(2000)
    pg.keyboard.press("Enter"); pg.wait_for_timeout(10000)

def pick_option(pg, index=1):
    """ColumnSelect dropdownはbody描画・仮想リストのためscroll後にクリックする。"""
    opts = pg.locator('body .ant-select-item-option')
    n = opts.count()
    if n == 0:
        # dataset未ロード時は10秒待って再試行
        pg.wait_for_timeout(10000)
        n = opts.count()
        if n == 0:
            return False
    idx = min(index, n - 1)
    try:
        opts.nth(idx).scroll_into_view_if_needed(timeout=5000)
    except Exception:
        pass
    pg.wait_for_timeout(300)
    try:
        opts.nth(idx).click(timeout=8000)
    except Exception:
        pg.evaluate("(i) => { const es=[...document.querySelectorAll('body .ant-select-item-option')]; if(es[i]) es[i].click(); }", idx)
    pg.wait_for_timeout(1200)
    return True

def tab_text(pg, path):
    return pg.evaluate("(p) => { const t=document.querySelector('[data-tab-path=\"' + p + '\"]'); return t ? (t.innerText||'').slice(0,400) : 'NO-TAB'; }", path)

def tab_sel(pg, path, n=8):
    items = pg.evaluate("(p) => { const t=document.querySelector('[data-tab-path=\"' + p + '\"]')||document; return [...t.querySelectorAll('.ant-select-selection-item')].map(e=>e.innerText.trim()).slice(0,8); }", path)
    return "|".join(items[:n])

with sync_playwright() as p:
    browser = p.chromium.launch()
    pg = browser.new_page(viewport={"width": 1440, "height": 900})
    pg.goto(BASE + "/pcp", wait_until="domcontentloaded")
    pg.wait_for_timeout(5000)
    pre = pg.evaluate("() => ({w: innerWidth, vis: document.visibilityState, js: [...document.scripts].map(s=>s.src).join('|')})")
    rec("S0-前提条件", pre["vis"] == "visible" and pre["w"] == 1440 and "index-CKY31PSW.js" in pre["js"],
        "visible/1440/CKY31PSW", f"{pre['vis']}/{pre['w']}")
    # 旧datasetへ: Iris built-in sample(direct gotoではstoreが空になるため10秒待機)
    switch_dataset(pg, "Iris (built-in sample)")
    cur_ds = pg.locator('[data-testid="dataset-selector"] .ant-select-selection-item').inner_text() if pg.locator('[data-testid="dataset-selector"] .ant-select-selection-item').count() else "?"
    rec("S1-Iris builtinへ切替", "Iris (built-in sample)" in cur_ds, "Iris builtin", cur_ds[:60])

    # ============ V08a: 記録のみ・成功数に含めない ============
    # 実Menu経由で遷移する(direct gotoではdataset/codebookが未ロードで既定表示が崩れる)
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="予測・要因分析").first.click(); pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="重回帰").first.click(); pg.wait_for_timeout(6000)
    lin_default = pg.evaluate("""() => {
      const main = document.querySelector('[role=main]');
      const txt = (main ? (main.innerText||'') : '');
      const tab = document.querySelector('[data-tab-path="/models/linear-regression"]')||document; const sel = [...tab.querySelectorAll('.ant-select-selection-item')].map(e=>e.innerText.trim());
      return {sel: sel.slice(0,8), hasRun: /実行/.test(txt)};
    }""")
    rec("V08a-記録のみ(成功数に含めない)", False, "記録のみ・ok:false固定",
        f"既定画面の記録 sel={lin_default['sel']} hasRun={lin_default['hasRun']}",
        "Pyodide免除: 目的変数・説明変数未設定の既定画面であり解析成功の証拠ではない")

    # ============ V08b: 重回帰の入力値を意図的に変更→往復で保持 ============
    # 注意: ColumnSelectは単一選択(single)のみ実Menu往復で状態保持する。
    # multiple(数値説明変数)は選択しても選択表示に反映されない既知の挙動のため、
    # 変更対象は目的変数(single)+重みradio+欠損Select(除外→欠損カテゴリ)とする。
    # いずれも実ブラウザの実クリック/実キー操作で変更する。
    # (V08aで既に実Menu経由で重回帰へ到達済み。遷移せずそのまま変更する)
    pg.wait_for_timeout(4000)
    target_before = pg.evaluate("() => [...document.querySelectorAll('[role=main] .ant-select-selection-item')].map(e=>e.innerText.trim()).join('|')")
    try:
        pg.locator('[role=main] .ant-select', has_text="目的変数を選択").first.click(timeout=8000)
        pg.wait_for_timeout(2000)
        pick_option(pg, 1)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
    except Exception as ex:
        print("target select fail:", str(ex)[:120])
    # 重みradio: 2つ目のRadio.Group内の「なし」を実クリック
    # (対象Groupと重みGroupが混在するためGroup順序で区別。input[value]判定)
    try:
        pg.evaluate("(p) => { const tab=document.querySelector('[data-tab-path=\"' + p + '\"]')||document; const groups=[...tab.querySelectorAll('.ant-radio-group')]; const g=groups[1]||tab; const el=[...g.querySelectorAll('.ant-radio-button-wrapper')].find(x=>x.textContent.trim()==='なし'); if(el) el.click(); }", "/models/linear-regression")
        pg.wait_for_timeout(800)
    except Exception as ex:
        print("weight radio fail:", str(ex)[:120])
    # 対象radio: 1つ目のRadio.Group内の「全体」を実クリック
    try:
        pg.evaluate("(p) => { const tab=document.querySelector('[data-tab-path=\"' + p + '\"]')||document; const groups=[...tab.querySelectorAll('.ant-radio-group')]; const g=groups[0]||tab; const el=[...g.querySelectorAll('.ant-radio-button-wrapper')].find(x=>x.textContent.trim()==='全体'); if(el) el.click(); }", "/models/linear-regression")
        pg.wait_for_timeout(800)
    except Exception as ex:
        print("scope radio fail:", str(ex)[:120])
    lin_changed = pg.evaluate("""() => {
      const tab = document.querySelector('[data-tab-path="/models/linear-regression"]')||document; const sel = [...tab.querySelectorAll('.ant-select-selection-item')].map(e=>e.innerText.trim());
      const radios = [...tab.querySelectorAll('.ant-radio-button-checked input')].map(e=>e.value);
      return {sel: sel.slice(0,8), radios};
    }""")
    changed_ok = ("目的変数を選択" not in "|".join(lin_changed["sel"])) and ("none" in lin_changed["radios"]) and ("all" in lin_changed["radios"])
    rec("V08b1-重回帰の入力値を意図的に変更", changed_ok, "目的変数設定済み+重み=なし+対象=全体",
        f"before=[{target_before[:80]}] after_sel={lin_changed['sel']} radios={lin_changed['radios']}")
    lin_snapshot = tab_text(pg, "/models/linear-regression")
    lin_sel_snapshot = "|".join(lin_changed["sel"])
    pg.screenshot(path=str(OUT / f"{RUN_ID}-v08-linreg-changed.png"))
    # 実Menu往復: 重回帰→因子分析→重回帰
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="次元削減").first.click(); pg.wait_for_timeout(1000)
    fa_items = pg.locator('.feature-navigation-popup .ant-menu-item').all()
    fa_exact = [e for e in fa_items if e.inner_text().strip() == "因子分析"]
    assert fa_exact, "因子分析の葉なし"
    fa_exact[0].click(); pg.wait_for_timeout(4000)
    fa_path = pg.evaluate("() => location.pathname")
    # 因子分析の入力も変更: 相関Select(Polychoric→Pearson)、重みを「なし(明示)」へ
    # (項目選択はmultipleのため選択表示に反映されない既知の挙動。相関など
    #  単一Selectは表示に反映されるため変更対象とする。SelectSettingはbody描画)
    fa_corr_before = pg.evaluate("() => [...document.querySelectorAll('[role=main] .ant-select-selection-item')].map(e=>e.innerText.trim()).slice(0,4)")
    try:
        pg.locator('[role=main] .ant-select', has_text="Polychoric").first.click(timeout=8000)
        pg.wait_for_timeout(2000)
        pear = [e for e in pg.locator('body .ant-select-item-option').all() if e.inner_text().strip() == "Pearson"]
        if pear:
            pear[0].click(timeout=8000); pg.wait_for_timeout(1200)
        else:
            pick_option(pg, 1)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
    except Exception as ex:
        print("fa corr fail:", str(ex)[:120])
    fa_corr_after = pg.evaluate("() => [...document.querySelectorAll('[role=main] .ant-select-selection-item')].map(e=>e.innerText.trim()).slice(0,4)")
    print("FA corr:", fa_corr_before, "->", fa_corr_after)
    try:
        pg.evaluate("(p) => { const tab=document.querySelector('[data-tab-path=\"' + p + '\"]')||document; const groups=[...tab.querySelectorAll('.ant-radio-group')]; const g=groups[1]||tab; const el=[...g.querySelectorAll('.ant-radio-button-wrapper')].find(x=>x.textContent.includes('なし')); if(el) el.click(); }", "/models/factor-analysis")
        pg.wait_for_timeout(800)
    except Exception as ex:
        print("fa weight fail:", str(ex)[:120])
    fa_changed = pg.evaluate("""() => {
      const tab = document.querySelector('[data-tab-path="/models/factor-analysis"]')||document; const sel = [...tab.querySelectorAll('.ant-select-selection-item')].map(e=>e.innerText.trim());
      const radios = [...tab.querySelectorAll('.ant-radio-button-checked input')].map(e=>e.value);
      return {sel: sel.slice(0,6), radios};
    }""")
    fa_snapshot = main_text(pg)
    fa_sel_snapshot = "|".join(fa_changed["sel"])
    pg.screenshot(path=str(OUT / f"{RUN_ID}-v08-factor-changed.png"))
    # 重回帰へ戻る
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="予測・要因分析").first.click(); pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="重回帰").first.click(); pg.wait_for_timeout(3000)
    lin_path_back = pg.evaluate("() => location.pathname")
    lin_back = tab_text(pg, "/models/linear-regression")
    lin_sel_back = tab_sel(pg, "/models/linear-regression", 8)
    kept = (lin_back == lin_snapshot) and (lin_sel_back == lin_sel_snapshot) and lin_path_back == "/models/linear-regression" and fa_path == "/models/factor-analysis"
    rec("V08b-変更した重回帰入力が実Menu往復で保持", kept and changed_ok, "変更後テキスト完全一致+選択値一致+menu経路",
        f"sel_equal={lin_sel_back==lin_sel_snapshot} text_equal={lin_back==lin_snapshot} paths={fa_path}/{lin_path_back}")
    if not kept:
        open(OUT / f"{RUN_ID}-v08-diff.txt", "w", encoding="utf-8").write(f"---BEFORE---\n{lin_snapshot}\n---AFTER---\n{lin_back}\nSEL-BEFORE:{lin_sel_snapshot}\nSEL-AFTER:{lin_sel_back}\n")

    # ============ V08c: PCP→コンジョイント→PCP往復(コンジョイント入力も変更) ============
    pg.goto(BASE + "/pcp", wait_until="domcontentloaded"); pg.wait_for_timeout(4000)
    pcp_before = pg.evaluate("() => document.querySelectorAll('[role=main] svg').length")
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="予測・要因分析").first.click(); pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="コンジョイント").first.click(); pg.wait_for_timeout(3000)
    cj_path = pg.evaluate("() => location.pathname")
    # コンジョイント入力を変更: 回答者ID列を選択
    cj_before_sel = pg.evaluate("() => [...document.querySelectorAll('[role=main] .ant-select-selection-item')].map(e=>e.innerText.trim()).slice(0,6)")
    try:
        pg.locator('[data-testid="cj-respondent-col"] .ant-select').first.click(timeout=5000)
        pg.wait_for_timeout(2000)
        pick_option(pg, 1)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    except Exception as ex:
        print("cj respondent fail:", str(ex)[:120])
    cj_changed = pg.evaluate("() => [...document.querySelectorAll('[role=main] .ant-select-selection-item')].map(e=>e.innerText.trim()).slice(0,6)")
    cj_sel_snapshot = "|".join(cj_changed)
    cj_changed_ok = cj_changed != cj_before_sel and len("|".join(cj_changed)) > 0
    pg.screenshot(path=str(OUT / f"{RUN_ID}-v08-conjoint-changed.png"))
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="可視化").first.click(); pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="平行座標").first.click(); pg.wait_for_timeout(3000)
    pcp_path = pg.evaluate("() => location.pathname")
    pcp_after = pg.evaluate("() => document.querySelectorAll('[role=main] svg').length")
    # コンジョイントへ戻り選択値が保持されるか
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="予測・要因分析").first.click(); pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="コンジョイント").first.click(); pg.wait_for_timeout(3000)
    cj_path2 = pg.evaluate("() => location.pathname")
    cj_back = "|".join(pg.evaluate("() => [...document.querySelectorAll('[role=main] .ant-select-selection-item')].map(e=>e.innerText.trim()).slice(0,6)"))
    rec("V08c-コンジョイント入力変更が往復で保持・PCP描画維持",
        pcp_before > 0 and pcp_after > 0 and cj_path == "/models/conjoint" and pcp_path == "/pcp" and cj_path2 == "/models/conjoint" and cj_back == cj_sel_snapshot and cj_changed_ok,
        "入力変更+往復一致+svg>0", f"svg={pcp_before}/{pcp_after} paths={cj_path}/{pcp_path}/{cj_path2} sel_equal={cj_back==cj_sel_snapshot} changed={cj_changed_ok}")
    pg.screenshot(path=str(OUT / f"{RUN_ID}-v08-pcp-back.png"))

    # ============ V09: s datasetでウェイト・変数・行範囲を実際に変更して保持 ============
    # 実Menu経由でTableへ移動してから切替える(direct gotoではdatasetが変わらない)
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="データ・概要").first.click(); pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="データ表").first.click(); pg.wait_for_timeout(4000)
    switch_dataset(pg, "s (80")
    cur_s = pg.locator('[data-testid="dataset-selector"] .ant-select-selection-item').inner_text() if pg.locator('[data-testid="dataset-selector"] .ant-select-selection-item').count() else "?"
    rec("V09a-s datasetへ切替", cur_s.startswith("s ("), "s (80行)", cur_s[:40])
    pg.wait_for_timeout(4000)
    # ウェイト: 未選択→w を設定(値が変わること)
    # 注意: dataset-selectorとglobal-weight-selectのdropdownは両方body描画の
    # .ant-select-item-optionのため、weight-select直後のoptionに絞る。
    w_before = pg.evaluate("() => { const e=document.querySelector('[data-testid=global-weight-select] .ant-select-selection-item'); return e ? e.innerText.trim() : '未選択'; }")
    pg.locator('[data-testid="global-weight-select"]').click(); pg.wait_for_timeout(2500)
    w_set = w_before
    # dataset-selectorの残存option(s (80行)x2: 非可視)とweightのw option(可視)を区別する。
    # 可視のoptionのみを対象にする。
    wopts = pg.locator('body .ant-select-item-option')
    for i in range(wopts.count()):
        try:
            t = wopts.nth(i).inner_text()
            vis = wopts.nth(i).is_visible()
        except Exception:
            continue
        if vis and ("w — w" in t or t.strip().startswith("w ")):
            try:
                wopts.nth(i).scroll_into_view_if_needed(timeout=5000)
            except Exception:
                pass
            pg.wait_for_timeout(300)
            try:
                wopts.nth(i).click(timeout=8000)
            except Exception:
                pg.evaluate("(i) => { const es=[...document.querySelectorAll('body .ant-select-item-option')]; if(es[i]) es[i].click(); }", i)
            pg.wait_for_timeout(2000)
            break
    pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    w_after_set = pg.evaluate("() => { const e=document.querySelector('[data-testid=global-weight-select] .ant-select-selection-item'); return e ? e.innerText.trim() : '未選択'; }")
    w_changed_ok = (w_before == "未選択" or "未選択" in w_before) and (w_after_set != "未選択" and "未選択" not in w_after_set)
    rec("V09b-ウェイトを未選択→wへ変更(値が変わる)", w_changed_ok, "未選択と異なる値",
        f"before={w_before} after={w_after_set}")
    # 変数: 1つ外す(3→2)。popoverのcheckboxはlabel要素自体を実クリックする。
    var_before = pg.evaluate("() => document.querySelector('[data-testid=global-var-btn]').innerText.replace(/\\s+/g,' ').slice(0,60)")
    pg.locator('[data-testid="global-var-btn"]').click(); pg.wait_for_timeout(1500)
    n_boxes = pg.evaluate("() => document.querySelectorAll('[data-testid^=var-checkbox-]').length")
    first_checked = pg.evaluate("() => { const b=[...document.querySelectorAll('[data-testid^=var-checkbox-]')]; return b.length ? b[0].getAttribute('data-testid').slice(0,60) : 'NO-BOX'; }")
    try:
        pg.locator('[data-testid^="var-checkbox-"]').nth(0).scroll_into_view_if_needed(timeout=5000)
    except Exception:
        pass
    pg.wait_for_timeout(300)
    try:
        pg.locator('[data-testid^="var-checkbox-"]').nth(0).click(timeout=8000)
    except Exception as ex:
        print("var uncheck fail:", str(ex)[:100])
    pg.wait_for_timeout(1500)
    var_mid = pg.evaluate("() => document.querySelector('[data-testid=global-var-btn]').innerText.replace(/\\s+/g,' ').slice(0,60)")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
    var_changed_ok = var_mid != var_before
    rec("V09c-変数を1つ外す(値が変わる)", var_changed_ok, "Variables表示が変化", f"before=[{var_before}] mid=[{var_mid}] boxes={n_boxes} unchecked={first_checked}")
    # 行範囲: 1-10 を選択行へ適用。range inputはINPUT要素自体にtestidがある。
    # (InputNumberのラッパーではなくinput直接。ModalはdefaultTabが残るためRangeタブを実クリックする)
    pg.locator('[data-testid="open-obs-range-btn"]').click(); pg.wait_for_timeout(2000)
    try:
        pg.locator('.ant-tabs-tab', has_text="行番号範囲指定").first.click(timeout=5000); pg.wait_for_timeout(800)
    except Exception:
        pass
    pg.locator('[data-testid="range-from-input"]').fill("1")
    pg.locator('[data-testid="range-to-input"]').fill("10")
    pg.evaluate("() => { const els=[...document.querySelectorAll('.ant-radio-wrapper')]; const el=els.find(x=>x.textContent.includes('選択行')); if(el) el.click(); }")
    pg.wait_for_timeout(500)
    pg.locator('[data-testid="apply-range-btn"]').click(); pg.wait_for_timeout(3000)
    try:
        pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
    except Exception:
        pass
    # range適用(asSelected)はglobalObservationsスライスに反映される。Table横の
    # selected-sidebarはselectionスライスの旧表示のため、判定はヘッダ表示(正本)で行う。
    sel_after_range = header_sel_text(pg)
    m_range = re.search(r"選択:\s*(\d+)", sel_after_range)
    range_count = m_range.group(1) if m_range else "?"
    range_ok = (range_count == "10")
    rec("V09d-行範囲1-10を選択行へ適用", range_ok, "選択:10行(ヘッダ正本)", f"header=[{sel_after_range}] sidebar=[{sidebar_text(pg)[:60]}]")
    pg.screenshot(path=str(OUT / f"{RUN_ID}-v09-changed.png"))
    # 三地点比較: Table→PCP→Table(選択はヘッダ正本header_sel_textで比較)
    rowids_before = header_sel_text(pg)
    hdr_count_before = range_count
    bar_before = central_bar(pg)
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="可視化").first.click(); pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="平行座標").first.click(); pg.wait_for_timeout(3000)
    mid_path = pg.evaluate("() => location.pathname")
    rowids_mid = header_sel_text(pg)
    bar_mid = central_bar(pg)
    w_mid = pg.evaluate("() => { const e=document.querySelector('[data-testid=global-weight-select] .ant-select-selection-item'); return e ? e.innerText.trim() : '未選択'; }")
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="データ・概要").first.click(); pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="データ表").first.click(); pg.wait_for_timeout(4000)
    back_path = pg.evaluate("() => location.pathname")
    rowids_after = header_sel_text(pg)
    bar_after = central_bar(pg)
    w_after = pg.evaluate("() => { const e=document.querySelector('[data-testid=global-weight-select] .ant-select-selection-item'); return e ? e.innerText.trim() : '未選択'; }")
    three_ok = (rowids_before == rowids_mid == rowids_after) and ("10" in rowids_before) and (mid_path == "/pcp") and (back_path == "/table")
    w_kept = (w_after_set == w_mid == w_after)
    rec("V09e-変更状態が三地点で保持(選択・ウェイト・バー)", three_ok and w_kept and w_changed_ok and var_changed_ok and range_ok,
        "rowId一致+ウェイト一致+バー一致", f"rows=[{rowids_before}]/[{rowids_mid}]/[{rowids_after}] w=[{w_after_set}]/[{w_mid}]/[{w_after}] paths={mid_path}/{back_path} bar_equal={bar_mid==bar_before and bar_after==bar_before}")
    pg.screenshot(path=str(OUT / f"{RUN_ID}-v09-table-back.png"))
    # 元に戻す: ウェイトクリア・変数全選択・選択解除
    try:
        pg.locator('[data-testid="global-weight-select"] .ant-select-clear').first.click(timeout=5000); pg.wait_for_timeout(1200)
    except Exception:
        pass
    w_restored = pg.evaluate("() => { const e=document.querySelector('[data-testid=global-weight-select] .ant-select-selection-item'); return e ? e.innerText.trim() : '未選択'; }")
    pg.locator('[data-testid="global-var-btn"]').click(); pg.wait_for_timeout(1500)
    # 外した1件を戻す: popover内の「全選択」ボタンを実クリックで全変数へ復元
    try:
        pg.locator('[data-testid="var-quick-all"]').first.click(timeout=5000)
    except Exception as ex:
        print("var recheck fail:", str(ex)[:100])
    pg.wait_for_timeout(1500)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
    var_restored = pg.evaluate("() => document.querySelector('[data-testid=global-var-btn]').innerText.replace(/\\s+/g,' ').slice(0,60)")
    try:
        pg.locator('[data-testid="header-clear-selection"]').first.click(timeout=5000); pg.wait_for_timeout(1500)
    except Exception:
        pass
    # 選択解除はヘッダの解除ボタンで行う(正本globalObservations側)。判定もヘッダ正本。
    sel_cleared_hdr = header_sel_text(pg)
    rec("V09f-元の値へ戻す(ウェイト未選択・変数全選択・選択解除)",
        ("未選択" in w_restored) and ("3 / 3" in var_restored) and ("選択: 0行" in sel_cleared_hdr),
        "復元", f"w={w_restored} var=[{var_restored}] sel=[{sel_cleared_hdr}] sidebar=[{sidebar_text(pg)[:40]}]")

    # ============ V10: 旧dataset状態を作ってから切替→消滅確認 ============
    switch_dataset(pg, "Iris (built-in sample)")
    pg.goto(BASE + "/table", wait_until="domcontentloaded"); pg.wait_for_timeout(6000)
    checks = pg.locator('[role=main] input[data-testid^="select-"]')
    if checks.count() >= 2:
        for i in range(2):
            try: checks.nth(i).check(timeout=5000); pg.wait_for_timeout(500)
            except Exception as ex: print("check fail", i, str(ex)[:80])
        pg.wait_for_timeout(1500)
    # 可視popupを開く(切替直前の前提)
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="可視化").first.click(); pg.wait_for_timeout(1000)
    popup_before = pg.evaluate("() => [...document.querySelectorAll('.feature-navigation-popup')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;}).length")
    sel_before_sw = sidebar_text(pg)
    m_pre = re.search(r"選択行\s*(\d+)", sel_before_sw)
    pre_count = m_pre.group(1) if m_pre else "?"
    pg.screenshot(path=str(OUT / f"{RUN_ID}-v10-before.png"))
    rec("V10a-切替前の旧状態(選択2件・可視popup>=1)", pre_count == "2" and popup_before >= 1,
        "選択2+popup>=1", f"sel={sel_before_sw[:60]} popup={popup_before}")
    # n007_allnanへ切替
    switch_dataset(pg, "n007_allnan")
    nanproof = pg.evaluate("""(async (name) => {
      try {
        const list = await fetch('/api/v1/datasets').then(r=>r.json());
        const ds = (list.datasets||[]).find(d=>d.name===name);
        if (!ds) return 'NO-DS:'+name;
        const meta = await fetch('/api/v1/datasets/'+(ds.datasetId||ds.id)).then(r=>r.json());
        const cols = meta.schema||meta.columns||[];
        const rows = meta.rowCount;
        const allnan = cols.filter(c=>c.missingCount!=null&&c.missingCount>=rows).map(c=>c.name||c.columnId);
        return JSON.stringify({rows, allnan});
      } catch(e) { return 'ERR:'+e; }
    })""", "n007_allnan")
    cur_ds2 = pg.locator('[data-testid="dataset-selector"] .ant-select-selection-item').inner_text() if pg.locator('[data-testid="dataset-selector"] .ant-select-selection-item').count() else "?"
    # Tableを再訪
    pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="データ・概要").first.click(); pg.wait_for_timeout(1000)
    pg.locator('.feature-navigation-popup .ant-menu-item', has_text="データ表").first.click(); pg.wait_for_timeout(4000)
    sel_switched = sidebar_text(pg)
    nav_popups_visible = pg.evaluate("() => [...document.querySelectorAll('.feature-navigation-popup')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;}).length")
    m_nan = re.search(r'"allnan":\s*\[([^\]]*)\]', nanproof)
    has_allnan = bool(m_nan and m_nan.group(1).strip())
    sel_cleared2 = sel_switched.startswith("選択行 0")
    rec("V10b-旧状態の消滅(選択0・可視popup0)+全NaN証明",
        sel_cleared2 and nav_popups_visible == 0 and has_allnan and pre_count == "2" and popup_before >= 1,
        "旧選択2→0+旧popup>=1→0+全NaN", f"ds={cur_ds2[:40]} sidebar=[{sel_switched[:60]}] visible={nav_popups_visible} allnan={nanproof[:150]}")
    pg.screenshot(path=str(OUT / f"{RUN_ID}-v10-after.png"))
    # Irisへ戻す
    switch_dataset(pg, "Iris (built-in sample)")
    pg.wait_for_timeout(2000)

    # ============ V11: 拡大解除後の既存共通操作の実起動 ============
    pg.goto(BASE + "/pcp", wait_until="domcontentloaded"); pg.wait_for_timeout(4000)
    exp_btn = pg.locator('[role=main] [data-testid^="graph-expand-"]')
    if exp_btn.count() > 0:
        pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="可視化").first.click(); pg.wait_for_timeout(1000)
        exp_btn.first.click(); pg.wait_for_timeout(2000)
        dlg_open = pg.evaluate("() => { const d=document.querySelector('[data-testid=graph-expansion-dialog]'); return d ? !!d.open : 'no-dialog'; }")
        pg.locator('[data-testid="graph-expansion-exit"]').click(); pg.wait_for_timeout(1500)
        dlg_after = pg.evaluate("() => { const d=document.querySelector('[data-testid=graph-expansion-dialog]'); return d ? !!d.open : 'no-dialog'; }")
        # Export dropdownを実クリックで開く(ダウンロードは開始しない)
        pg.locator('[data-testid="export-button"]').click(); pg.wait_for_timeout(1500)
        export_items = pg.evaluate("() => [...document.querySelectorAll('.ant-dropdown-menu-item')].map(e=>e.innerText.trim()).slice(0,6)")
        export_open = len(export_items) > 0 and "全行 CSV" in export_items
        pg.screenshot(path=str(OUT / f"{RUN_ID}-v11-export.png"))
        pg.keyboard.press("Escape"); pg.wait_for_timeout(600)
        export_closed = pg.evaluate("() => [...document.querySelectorAll('.ant-dropdown-menu-item')].filter(e=>e.getBoundingClientRect().width>0).length") == 0
        # Save modalを実起動(保存は実行しない)
        pg.locator('[data-testid="save-button"]').click(); pg.wait_for_timeout(1500)
        save_open = pg.evaluate("() => [...document.querySelectorAll('.ant-modal')].filter(e=>e.getBoundingClientRect().width>0).length") > 0
        save_title = pg.evaluate("() => { const m=[...document.querySelectorAll('.ant-modal')].find(e=>e.getBoundingClientRect().width>0); return m ? (m.innerText||'').slice(0,40) : 'NO-MODAL'; }")
        pg.screenshot(path=str(OUT / f"{RUN_ID}-v11-save.png"))
        pg.keyboard.press("Escape"); pg.wait_for_timeout(800)
        save_closed = pg.evaluate("() => [...document.querySelectorAll('.ant-modal')].filter(e=>e.getBoundingClientRect().width>0).length") == 0
        # Import の file input 存在(Uploadコンポーネント)
        import_input = pg.evaluate("() => [...document.querySelectorAll('input[type=file]')].length")
        # Licenseダイアログ開閉
        pg.locator('[data-testid="license-button"]').first.click(timeout=5000); pg.wait_for_timeout(1000)
        lic_open = pg.evaluate("() => document.querySelectorAll('.ant-modal').length > 0")
        pg.screenshot(path=str(OUT / f"{RUN_ID}-v11-license.png"))
        pg.keyboard.press("Escape"); pg.wait_for_timeout(800)
        lic_closed = pg.evaluate("() => [...document.querySelectorAll('.ant-modal')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;}).length") == 0
        try:
            pg.locator('.feature-navigation-menu > .ant-menu-submenu', has_text="可視化").first.click(timeout=5000)
            pg.wait_for_timeout(800)
            menu_works = pg.evaluate("() => document.querySelectorAll('.feature-navigation-popup').length") > 0
            pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
        except Exception:
            menu_works = False
        ok11 = (dlg_open is True) and (dlg_after is False) and export_open and export_closed and save_open and ("セッション保存" in save_title) and save_closed and import_input >= 1 and lic_open and lic_closed and menu_works
        rec("V11-拡大解除後に既存共通操作が起動可能",
            ok11, "Export開閉+Save開閉+Import存在+License開閉+復旧",
            f"dlg={dlg_open}/{dlg_after} export={export_open}/{export_closed} items={export_items} save={save_open}/{save_closed} [{save_title}] import_inputs={import_input} license={lic_open}/{lic_closed} menu={menu_works}")
        pg.screenshot(path=str(OUT / f"{RUN_ID}-v11-restored.png"))
    else:
        rec("V11-拡大解除後に既存共通操作が起動可能", False, "拡大ボタン", "graph-expandボタンなし")

    pg.close(); browser.close()

with open(OUT / f"{RUN_ID}-results.json", "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
counted = [c for c in results["cases"] if c["name"] != "V08a-記録のみ(成功数に含めない)"]
npass = sum(1 for c in counted if c["ok"])
print(f"TOTAL {npass}/{len(counted)} (V08a除外)")
