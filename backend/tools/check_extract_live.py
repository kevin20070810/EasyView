"""鐜板満楠岃瘉 easyview-extension/src/extract.js锛堥〉闈㈠唴鎻愬彇妯″潡锛夈€?
鏈嶅姟绔姄鍙栧凡閫€褰癸紝鎻愬彇鏀逛负鍦ㄦ墿灞曠殑 content script 閲屽仛锛屾墍浠ヨ繖涓伐鍏风敤 Playwright
**鐪熺殑鎶?extract.js 娉ㄨ繘椤甸潰**璺戜竴閬嶏紝鑰屼笉鏄牎楠屽浐鍖栦骇鍑猴細

  1. 鍔犺浇 backend/fixtures/{hospital,gov,traffic,generic}.html
  2. 娉ㄥ叆 easyview-extension/src/extract.js锛岃皟鐢?EasyViewExtract.run()
  3. 鐢?docs/elements.schema.json 鏍￠獙杩斿洖鐨?elements.json
  4. 鏍￠獙 selfcheck 閭ｅ涓氬姟涓嶅彉閲?+ resolve() 蹇呴』鑳芥嬁鍥炵湡瀹?DOM 鍏冪礌
  5. 棰濆鐢ㄤ竴涓复鏃剁敓鎴愮殑銆岃秴 400 鍏冪礌 + 闅愯棌琛ㄥ崟銆嶉〉闈㈤獙璇併€屽彲瑙佷紭鍏堟埅鏂€?
鐢ㄦ硶锛?    python tools/check_extract_live.py
    python tools/check_extract_live.py --dump out/     # 椤轰究鎶婁骇鍑鸿惤鐩樹究浜庝汉鐪?"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path

# 鍏佽浠ヨ剼鏈柟寮忕洿鎺ヨ繍琛?sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import jsonschema  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

from app.config import DOCS_DIR, FIXTURES_DIR, MAX_ELEMENTS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent      # D:\EasyView
EXTRACT_JS = ROOT / "easyview-extension" / "src" / "extract.js"

ID_RE = re.compile(r"^el_[0-9a-f]{8}$")
GROUP_RE = re.compile(r"^(grp|form)_[0-9a-f]{8}$")
SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:")

_ok = 0
_fail = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global _ok, _fail
    if condition:
        _ok += 1
        print(f"  [PASS] {label}")
    else:
        _fail += 1
        print(f"  [FAIL] {label} {detail}")


# --------------------------------------------------------------------------
# 椤甸潰鍐呮帰閽堬細璺?run()锛岄『甯︽妸 resolve() 鐨勭粨鏋滀竴璧峰甫鍥炴潵锛堝厓绱犳棤娉曞簭鍒楀寲锛?# --------------------------------------------------------------------------
PROBE = r"""
() => {
  const api = globalThis.EasyViewExtract;
  if (!api || typeof api.run !== 'function') {
    return { error: 'globalThis.EasyViewExtract.run 涓嶅瓨鍦? };
  }
  const first = api.run();
  const doc = first.elements;
  if (!doc || !Array.isArray(doc.elements)) {
    return { error: 'run() 娌℃湁杩斿洖 { elements: <elements.json> }' };
  }
  const ids = doc.elements.map((e) => e.id);

  // 1) resolve(id) 蹇呴』鎷垮洖鐪熷疄銆佷粛鍦ㄦ枃妗ｉ噷鐨?DOM 鍏冪礌
  const resolveReport = doc.elements.map((e) => {
    let node = null;
    let err = null;
    try { node = first.resolve(e.id); } catch (ex) { err = String(ex); }
    return {
      id: e.id,
      ok: !!(node && node.nodeType === 1),
      connected: !!(node && node.isConnected),
      inDoc: !!(node && document.documentElement.contains(node)),
      tag: node && node.tagName ? node.tagName.toLowerCase() : null,
      err: err,
    };
  });

  // 2) resolve(id) 涓?selector 蹇呴』鎸囧悜鍚屼竴涓妭鐐癸紙涓嬫父楂樹寒/缁戝畾闈犺繖涓級
  const selectorMatches = doc.elements.map((e) => {
    let node = null;
    let q = null;
    try { node = first.resolve(e.id); } catch (ex) { /* 涓婇潰宸茬粡鎶ヨ繃 */ }
    try { q = document.querySelector(e.selector); } catch (ex) { /* 閫夋嫨鍣ㄩ潪娉?*/ }
    return { id: e.id, same: !!node && node === q, foundBySelector: !!q };
  });

  // 3) 閫夐」锛坮adio/checkbox锛夌殑 element_id 涔熷簲鍙В鏋愬洖瀵瑰簲鎺т欢
  const optionReport = [];
  doc.elements.forEach((e) => {
    (e.options || []).forEach((o) => {
      if (!o.element_id) return;
      let node = null;
      let q = null;
      try { node = first.resolve(o.element_id); } catch (ex) { /* ignore */ }
      try { q = document.querySelector(o.selector); } catch (ex) { /* ignore */ }
      optionReport.push({
        id: o.element_id,
        type: e.type,
        ok: !!(node && node.nodeType === 1 && node.isConnected),
        same: !!node && node === q,
      });
    });
  });

  // 4) 鍐嶈窇涓€娆★細蹇呴』閲嶆柊鎻愬彇涓?ID 绋冲畾锛涗笂涓€娆＄殑 resolve 浠嶈鍙敤
  const second = api.run();
  const secondIds = second.elements.elements.map((e) => e.id);
  const repeat = {
    sameCount: doc.elements.length === second.elements.elements.length,
    sameIds: JSON.stringify(ids) === JSON.stringify(secondIds),
    sameSelectors:
      JSON.stringify(doc.elements.map((e) => e.selector)) ===
      JSON.stringify(second.elements.elements.map((e) => e.selector)),
    firstStillWorks: ids.every((id) => {
      const n = first.resolve(id);
      return !!(n && n.nodeType === 1 && n.isConnected);
    }),
    secondWorks: secondIds.every((id) => {
      const n = second.resolve(id);
      return !!(n && n.nodeType === 1 && n.isConnected);
    }),
    secondResolveMissing: secondIds.filter((id) => {
      const n = second.resolve(id);
      return !(n && n.nodeType === 1 && n.isConnected);
    }),
  };

  // 5) 鐩存帴浠?DOM 鏁颁竴閬嶅彲瑙?闅愯棌閾炬帴锛岀敤鏉ヤ氦鍙夐獙璇併€屽彲瑙佸厓绱犱竴涓兘娌¤鎴帀銆?  //    锛堝彲瑙佹€у垽鎹笌妯″潡涓€鑷达細display/visibility/opacity + 闆跺昂瀵革級
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  const vis = (n) => {
    const st = getComputedStyle(n);
    if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
    if (parseFloat(st.opacity) === 0) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const dom = {
    anchorTotal: anchors.length,
    visibleAnchorHrefs: anchors.filter(vis).map((n) => n.href),
    hiddenAnchorCount: anchors.filter((n) => !vis(n)).length,
  };

  return {
    error: null,
    doc: doc,
    resolveReport: resolveReport,
    selectorMatches: selectorMatches,
    optionReport: optionReport,
    repeat: repeat,
    dom: dom,
    page: {
      href: location.href,
      title: document.title,
      lang: document.documentElement.getAttribute('lang'),
    },
  };
}
"""


def run_probe(page) -> dict:
    return page.evaluate(PROBE)


# --------------------------------------------------------------------------
# 鏍￠獙
# --------------------------------------------------------------------------
def validate_document(payload: dict, probe: dict, label: str) -> None:
    doc = payload
    elements = doc["elements"]
    groups = doc["groups"]
    ids = [e["id"] for e in elements]

    # ---- 鏂囨。绾у瓧娈?----
    check(f"{label}: schema_version = 1.1.0", doc.get("schema_version") == "1.1.0",
          f"(鏀跺埌 {doc.get('schema_version')!r})")
    check(f"{label}: page_url/final_url = location.href",
          doc.get("page_url") == probe["page"]["href"] == doc.get("final_url"),
          f"(page_url={doc.get('page_url')!r} final_url={doc.get('final_url')!r} "
          f"href={probe['page']['href']!r})")
    check(f"{label}: page_title = document.title",
          doc.get("page_title") == probe["page"]["title"].strip(),
          f"({doc.get('page_title')!r} vs {probe['page']['title']!r})")
    check(f"{label}: lang 涓?<html lang> 涓€鑷?,
          doc.get("lang") == probe["page"]["lang"],
          f"({doc.get('lang')!r} vs {probe['page']['lang']!r})")
    check(f"{label}: source = live 涓?fallback_reason = null",
          doc.get("source") == "live" and doc.get("fallback_reason") is None,
          f"(source={doc.get('source')!r} reason={doc.get('fallback_reason')!r})")
    try:
        parsed = datetime.fromisoformat(doc["extracted_at"])
        check(f"{label}: extracted_at 鏄惈鏃跺尯鐨?ISO-8601", parsed.tzinfo is not None,
              f"({doc['extracted_at']!r})")
    except Exception as exc:  # noqa: BLE001
        check(f"{label}: extracted_at 鏄惈鏃跺尯鐨?ISO-8601", False, f"({exc!r})")

    # ---- JSON Schema ----
    try:
        jsonschema.validate(doc, SCHEMA, format_checker=jsonschema.FormatChecker())
        check(f"{label}: 閫氳繃 elements.schema.json 鏍￠獙", True)
    except jsonschema.ValidationError as exc:
        path = "/".join(str(p) for p in exc.absolute_path)
        check(f"{label}: 閫氳繃 elements.schema.json 鏍￠獙", False,
              f"\n        璺緞: {path}\n        鍘熷洜: {exc.message}")

    # ---- ID ----
    check(f"{label}: 鍏冪礌 ID 鏃犻噸澶?, len(ids) == len(set(ids)),
          f"(鍏?{len(ids)}锛屽幓閲?{len(set(ids))})")
    check(f"{label}: 鍏冪礌 ID 鍏ㄩ儴鍖归厤 ^el_[0-9a-f]{{8}}$",
          all(ID_RE.match(i) for i in ids),
          f"(寮傚父: {[i for i in ids if not ID_RE.match(i)][:5]})")
    check(f"{label}: 鍒嗙粍 ID 鍏ㄩ儴鍖归厤 ^(grp|form)_[0-9a-f]{{8}}$",
          all(GROUP_RE.match(g["id"]) for g in groups),
          f"(寮傚父: {[g['id'] for g in groups if not GROUP_RE.match(g['id'])][:5]})")
    check(f"{label}: 鍒嗙粍 ID 鏃犻噸澶?, len({g["id"] for g in groups}) == len(groups))

    # ---- order ----
    check(f"{label}: order 浠?0 杩炵画閫掑",
          [e["order"] for e in elements] == list(range(len(elements))))

    # ---- 鍒嗙粍涓庡厓绱犲弻鍚戜竴鑷?----
    group_ids = {g["id"] for g in groups}
    dangling = [e["id"] for e in elements if e["group_id"] and e["group_id"] not in group_ids]
    check(f"{label}: 鍏冪礌 group_id 鏃犳偓绌哄紩鐢?, not dangling, f"(鎮┖: {dangling[:5]})")
    dangling_form = [e["id"] for e in elements if e["form_id"] and e["form_id"] not in group_ids]
    check(f"{label}: 鍏冪礌 form_id 鏃犳偓绌哄紩鐢?, not dangling_form, f"(鎮┖: {dangling_form[:5]})")
    check(f"{label}: form_id 鍏ㄩ儴鎸囧悜 form_ 鍓嶇紑",
          all(e["form_id"].startswith("form_") for e in elements if e["form_id"]))

    by_id = {e["id"]: e for e in elements}
    bad = []
    for g in groups:
        for eid in g["element_ids"]:
            el = by_id.get(eid)
            if el is None or el["group_id"] != g["id"]:
                bad.append((g["id"], eid))
    check(f"{label}: 鍒嗙粍 element_ids 涓庡厓绱犲綊灞炲弻鍚戜竴鑷?, not bad, f"(涓嶄竴鑷? {bad[:5]})")
    check(f"{label}: 鍒嗙粍 element_ids 涓庡厓绱犲悓搴忥紙鏂囨。搴忥級",
          all(g["element_ids"] == sorted(g["element_ids"], key=lambda i: by_id[i]["order"])
              for g in groups if all(i in by_id for i in g["element_ids"])))
    check(f"{label}: 娌℃湁绌?element_ids 鐨勫垎缁?, all(g["element_ids"] for g in groups),
          f"(绌? {[g['id'] for g in groups if not g['element_ids']][:5]})")

    # ---- 缁熻 ----
    stats = doc["stats"]
    check(f"{label}: stats.total = elements.length", stats["total"] == len(elements),
          f"({stats['total']} vs {len(elements)})")
    check(f"{label}: stats.visible = 瀹為檯鍙鏁?,
          stats["visible"] == sum(1 for e in elements if e["visible"]),
          f"({stats['visible']} vs {sum(1 for e in elements if e['visible'])})")
    real_by_type: dict[str, int] = {}
    for e in elements:
        real_by_type[e["type"]] = real_by_type.get(e["type"], 0) + 1
    check(f"{label}: stats.by_type 涓庡疄闄呯被鍨嬪垎甯冧竴鑷?,
          stats["by_type"] == real_by_type,
          f"({stats['by_type']} vs {real_by_type})")
    if stats.get("truncated"):
        check(f"{label}: truncated 鏃跺厓绱犳暟鎭扮瓑浜庝笂闄?{MAX_ELEMENTS}",
              len(elements) == MAX_ELEMENTS, f"(瀹為檯 {len(elements)})")
    else:
        check(f"{label}: 鏈埅鏂椂鍏冪礌鏁颁笉瓒呰繃涓婇檺",
              len(elements) <= MAX_ELEMENTS, f"(瀹為檯 {len(elements)})")

    # ---- bbox / visible 璇箟 ----
    check(f"{label}: 涓嶅彲瑙佸厓绱?bbox 涓?null",
          all(e["bbox"] is None for e in elements if not e["visible"]))
    check(f"{label}: 鍙鍏冪礌 bbox 闈炵┖涓斿楂樹负姝?,
          all(e["bbox"] and e["bbox"]["width"] > 0 and e["bbox"]["height"] > 0
              for e in elements if e["visible"]))

    # ---- href 缁濆鍖?----
    bad_hrefs = [e["href"] for e in elements
                 if e["href"] and not SCHEME_RE.match(e["href"])]
    check(f"{label}: href 鍧囦负缁濆 URL", not bad_hrefs, f"(鐩稿/寮傚父: {bad_hrefs[:3]})")

    # ---- 閫夐」 ----
    choice_els = [e for e in elements if e["type"] in ("radio", "checkbox")]
    empty_choice = [e["id"] for e in choice_els if not e.get("options")]
    check(f"{label}: radio/checkbox 鐨?options 闈炵┖", not empty_choice,
          f"(绌? {empty_choice[:5]})")
    check(f"{label}: radio/checkbox 閫夐」 selector 闈炵┖",
          all(o["selector"] for e in choice_els for o in (e.get("options") or [])))
    check(f"{label}: radio/checkbox 閫夐」 element_id 闈炵┖",
          all(o["element_id"] for e in choice_els for o in (e.get("options") or [])))
    select_els = [e for e in elements if e["type"] == "select"]
    check(f"{label}: select 鐨勯€夐」 selector/element_id 涓?null",
          all(o["selector"] is None and o["element_id"] is None
              for e in select_els for o in (e.get("options") or [])))
    check(f"{label}: 闈?select/radio/checkbox 鍏冪礌 options 涓?null",
          all(e.get("options") is None for e in elements
              if e["type"] not in ("select", "radio", "checkbox")))

    # ---- resolve() ----
    rr = probe["resolveReport"]
    bad_resolve = [r for r in rr if not r["ok"] or not r["connected"] or not r["inDoc"]]
    check(f"{label}: resolve(id) 瀵规瘡涓厓绱犻兘杩斿洖鐪熷疄 DOM 鍏冪礌",
          not bad_resolve,
          f"(澶辫触 {len(bad_resolve)}/{len(rr)}: {[r['id'] for r in bad_resolve][:5]})")
    sm = probe["selectorMatches"]
    not_same = [r for r in sm if not r["same"]]
    check(f"{label}: resolve(id) 涓?selector 鎸囧悜鍚屼竴鑺傜偣",
          not not_same,
          f"(涓嶄竴鑷?{len(not_same)}: {[r['id'] for r in not_same][:5]})")
    orr = probe["optionReport"]
    check(f"{label}: resolve(閫夐」 element_id) 鑳藉洖鍒板搴旀帶浠?,
          all(r["ok"] and r["same"] for r in orr),
          f"(澶辫触: {[r['id'] for r in orr if not (r['ok'] and r['same'])][:5]})")

    rep = probe["repeat"]
    check(f"{label}: 閲嶅 run() 鍏冪礌鏁颁竴鑷?, rep["sameCount"])
    check(f"{label}: 閲嶅 run() ID 绋冲畾", rep["sameIds"])
    check(f"{label}: 閲嶅 run() selector 绋冲畾", rep["sameSelectors"])
    check(f"{label}: 閲嶅 run() 鍚庢棫 resolve 浠嶅彲鐢?, rep["firstStillWorks"])
    check(f"{label}: 閲嶅 run() 鍚庢柊 resolve 鍏ㄩ儴鍙敤",
          rep["secondWorks"], f"(缂哄け: {rep['secondResolveMissing'][:5]})")


def print_summary(label: str, doc: dict) -> None:
    stats = doc["stats"]
    print(f"  鏍囬: {doc['page_title']}")
    print(f"  鍏冪礌: {stats['total']} 涓紙鍙 {stats['visible']}锛?
          f" 鍒嗙粍: {len(doc['groups'])} 涓? truncated={stats.get('truncated')}")
    print(f"  绫诲瀷鍒嗗竷: {stats['by_type']}")
    print(f"  鍒嗙粍: {[(g['id'], g['type'], g['label'], len(g['element_ids'])) for g in doc['groups']]}")


# --------------------------------------------------------------------------
# 涓存椂椤甸潰锛氶獙璇併€屽彲瑙佷紭鍏堟埅鏂?+ 闅愯棌鍏冪礌淇濈暀銆?# --------------------------------------------------------------------------
def build_big_page(dirpath: Path) -> tuple[Path, dict]:
    visible_links = 100
    hidden_links = 400
    parts = [
        "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'>",
        "<title>鎴柇涓庨殣钘忓厓绱犳帰閽?/title>",
        "<style>.hid{display:none} .zero{visibility:hidden}</style></head><body>",
        # 闅愯棌琛ㄥ崟鏀炬渶鍓嶏細鎴柇鎸夋枃妗ｅ簭琛ヨ冻闅愯棌鍏冪礌锛屼繚璇佸畠鐨勫瓧娈佃兘琚暀涓?        "<form id='buyForm' class='hid' action='/buy' method='post'>",
        "<fieldset><legend>闅愯棌鐨勮喘绁ㄨ〃鍗?/legend>",
        "<label for='from'>鍑哄彂鍦?/label><input id='from' name='from' type='text' required>",
        "<input type='radio' name='seat' value='a' checked><input type='radio' name='seat' value='b'>",
        "<button type='submit'>鎻愪氦璁㈠崟</button>",
        "</fieldset></form>",
    ]
    for i in range(hidden_links):
        parts.append(f"<a class='hid' href='/hidden/{i}'>闅愯棌閾炬帴 {i}</a>")
    for i in range(visible_links):
        parts.append(f"<a id='vis{i}' href='/visible/{i}'>鍙鏈嶅姟鍏ュ彛 {i}</a>")
    parts.append("<div class='zero'><a href='/zero'>闆跺昂瀵搁摼鎺?/a></div>")
    parts.append("</body></html>")
    path = dirpath / "big.html"
    path.write_text("\n".join(parts), encoding="utf-8")
    return path, {"visible_links": visible_links, "hidden_links": hidden_links}


def check_truncation(probe: dict, expect: dict) -> None:
    label = "big(鎴柇鎺㈤拡)"
    doc = probe["doc"]
    stats = doc["stats"]
    elements = doc["elements"]
    dom = probe["dom"]

    check(f"{label}: 涓婃姤 truncated=true", stats.get("truncated") is True)
    check(f"{label}: 鍏冪礌鏁版伆绛変簬涓婇檺 {MAX_ELEMENTS}", len(elements) == MAX_ELEMENTS,
          f"(瀹為檯 {len(elements)})")
    check(f"{label}: 鍊欓€夋€绘暟纭疄瓒呴檺锛堝惁鍒欒繖涓帰閽堟病鎰忎箟锛?,
          len(dom["visibleAnchorHrefs"]) + dom["hiddenAnchorCount"] > MAX_ELEMENTS,
          f"(鍙 {len(dom['visibleAnchorHrefs'])} + 闅愯棌 {dom['hiddenAnchorCount']})")

    # 鍏抽敭涓嶅彉閲忥細鍙浜や簰鍏冪礌灞炰簬 rank 0銆屽繀鐣欍€嶏紝涓€涓兘涓嶈兘琚埅鎺?    output_visible_hrefs = {e["href"] for e in elements if e["visible"] and e["type"] == "link"}
    missing = set(dom["visibleAnchorHrefs"]) - output_visible_hrefs
    check(f"{label}: 鍏ㄩ儴鍙閾炬帴閮借淇濈暀锛堝彲瑙佷紭鍏堬級", not missing,
          f"(涓簡 {len(missing)}/{len(dom['visibleAnchorHrefs'])}: {sorted(missing)[:3]})")
    check(f"{label}: 杈撳嚭閲岀殑鍙鍏冪礌鏁颁笌 DOM 瀹炴祴鍙鏁颁竴鑷?,
          stats["visible"] == len(dom["visibleAnchorHrefs"]),
          f"(杈撳嚭 {stats['visible']} vs DOM {len(dom['visibleAnchorHrefs'])})")

    # 闅愯棌鍏冪礌鏄銆屾埅鏂€嶈€屼笉鏄銆岃繃婊ゃ€嶏細闅愯棌琛ㄥ崟/杈撳叆妗嗕粛鍦紝鍙槸鎺掓渶鍚?    hidden_form = [e for e in elements if e["type"] == "form" and not e["visible"]]
    check(f"{label}: 闅愯棌琛ㄥ崟鏈韩琚繚鐣?, bool(hidden_form),
          f"(闅愯棌 form 鍏冪礌 {len(hidden_form)} 涓?")
    check(f"{label}: 闅愯棌琛ㄥ崟閲岀殑杈撳叆妗嗚淇濈暀锛寁isible=false 涓?bbox=null",
          any(e["type"] == "input" and not e["visible"] and not e["bbox"]
              and e["form_id"] for e in elements))
    check(f"{label}: 闅愯棌鐨?radio 缁勮鍚堝苟鎴愪竴涓厓绱犱笖 options 闈炵┖",
          any(e["type"] == "radio" and not e["visible"] and len(e.get("options") or []) == 2
              for e in elements))
    out_hidden = sum(1 for e in elements if not e["visible"] and e["type"] == "link")
    check(f"{label}: 闅愯棌閾炬帴鍙繚鐣欎竴閮ㄥ垎锛堣秴闄愰儴鍒嗚鎴柇锛?,
          out_hidden < expect["hidden_links"],
          f"(淇濈暀 {out_hidden} / {expect['hidden_links']})")
    # 杈撳嚭椤哄簭 = 鏂囨。搴忥紝涓斿彲瑙佸厓绱犲湪鎴柇鍚庝粛鎸夋枃妗ｅ簭鎺掑垪
    check(f"{label}: order 涓庢枃妗ｅ簭涓€鑷达紙鎴柇鍚庢湭鎸夐噸瑕佹€ч噸鎺掞級",
          [e["order"] for e in elements] == list(range(len(elements))))
    check(f"{label}: resolve() 瀵规埅鏂悗鐨勬瘡涓厓绱犱粛鍙敤",
          all(r["ok"] and r["inDoc"] for r in probe["resolveReport"]),
          f"(澶辫触: {[r['id'] for r in probe['resolveReport'] if not r['ok']][:5]})")


# --------------------------------------------------------------------------
# 瀵圭収鍥哄寲浜у嚭锛氭妸 fixture 閫氳繃璺敱鎸傚湪 demo 鍩熷悕涓嬭窇涓€閬嶏紝閫愬瓧娈垫瘮瀵?# docs/examples/elements.*.json锛堥偅浜涙槸閫€褰圭殑鏈嶅姟绔疄鐜颁骇鍑虹殑銆岀湡鍊笺€嶏級銆?# 鍙烦杩?id锛堟湰娆℃敼鎴愰€掑璁℃暟鍣紝蹇呯劧涓嶅悓锛変笌 group/form 鐨?ID 瀛楅潰鍊?# 锛堢敤銆屽綊灞炵瓑浠风被銆嶈€屼笉鏄瓧绗︿覆鏉ユ瘮瀵癸級銆?#
# 涓や釜鍒绘剰鐨勪緥澶栵紝閮藉凡鍦?check_against_example 閲屽崟鐙鏄庯細
#   - page_title锛氬浐鍖栦骇鍑鸿蛋鐨勬槸蹇収閾捐矾锛屾爣棰樿鏀瑰啓杩囷紙甯︺€岋紙鏈湴蹇収锛夈€嶅悗缂€锛夛紝
#     fixture 鑷韩鐨?<title> 涓庢湰妯″潡涓€鑷淬€?#   - options[].element_id锛氭湰妯″潡缁欓€夐」涔熷彂閫掑 ID锛屾棫瀹炵幇鏄?sha1(selector)銆?# bbox 鏄鍙ｇ浉鍏崇殑锛氬疄娴嬪浐鍖栦骇鍑哄嚭鑷?1366脳768 瑙嗗彛锛屾晠瀵圭収杩欎竴杞敤鍚屼竴瑙嗗彛銆?# --------------------------------------------------------------------------
COMPARE_FIELDS = ["type", "text", "label", "aria_label", "placeholder", "name", "value",
                  "href", "xpath", "visible", "bbox", "in_form", "required", "disabled",
                  "level", "order"]
VIEWPORT = {"width": 1366, "height": 768}


def _norm_options(opts):
    """閫夐」姣斿鏃跺墺鎺?element_id锛圛D 瑙勫垯鏄湁鎰忔敼鐨勶級锛屽叾浣欓€愰」姣斻€?""
    if opts is None:
        return None
    return [{k: v for k, v in o.items() if k != "element_id"} for o in opts]


def serve_demo(route, request, files: dict[str, Path]) -> None:
    """鎶?https://demo.easyview.local/<name>/ 鏄犲皠鍒版湰鍦?fixture銆?""
    name = request.url.split("//", 1)[-1].split("/", 1)[-1].strip("/").split("/")[0]
    fixture = files.get(name)
    if fixture and fixture.is_file():
        route.fulfill(status=200, content_type="text/html; charset=utf-8",
                      body=fixture.read_text(encoding="utf-8"))
    else:
        route.fulfill(status=404, body="not found")


def check_against_example(label: str, probe: dict, example: dict) -> None:
    print(f"  [INFO] 瀵圭収 docs/examples/elements.{label}.json"
          f"锛堣鏂囦欢鐢遍€€褰圭殑鏈嶅姟绔疄鐜颁骇鍑猴紝瑙嗗彛 {VIEWPORT['width']}脳{VIEWPORT['height']}锛?)
    live = probe["doc"]
    ex_els = {e["selector"]: e for e in example["elements"]}
    lv_els = {e["selector"]: e for e in live["elements"]}
    check(f"{label}=瀵圭収: 鍏冪礌 selector 闆嗗悎瀹屽叏涓€鑷?,
          set(ex_els) == set(lv_els),
          f"(澶氫簡 {sorted(set(lv_els) - set(ex_els))[:3]}锛?
          f"灏戜簡 {sorted(set(ex_els) - set(lv_els))[:3]})")
    check(f"{label}=瀵圭収: lang 涓€鑷?, example["lang"] == live["lang"])
    if example["page_title"] != live["page_title"]:
        print(f"  [INFO] {label}=瀵圭収: page_title 涓嶅悓 鈥斺€?鍥哄寲浜у嚭璧板揩鐓ч摼璺鏀瑰啓杩囷細"
              f"ex={example['page_title']!r} lv={live['page_title']!r}"
              f"锛堟湰妯″潡鐢ㄧ殑鏄?document.title={probe['page']['title']!r}锛屼笌 fixture 涓€鑷达級")

    diffs: list[str] = []
    per_field: dict[str, int] = {}
    for sel in sorted(set(ex_els) & set(lv_els)):
        ex, lv = ex_els[sel], lv_els[sel]
        for f in COMPARE_FIELDS:
            if ex.get(f) != lv.get(f):
                per_field[f] = per_field.get(f, 0) + 1
                if len(diffs) < 4:
                    diffs.append(f"{sel}::{f} ex={ex.get(f)!r} lv={lv.get(f)!r}")
        if _norm_options(ex.get("options")) != _norm_options(lv.get("options")):
            per_field["options(涓嶅惈 element_id)"] = per_field.get("options(涓嶅惈 element_id)", 0) + 1
            if len(diffs) < 4:
                diffs.append(f"{sel}::options ex={ex.get('options')!r} lv={lv.get('options')!r}")
    check(f"{label}=瀵圭収: 閫愬瓧娈垫瘮瀵癸紙鍚?bbox/order/options锛夋棤宸紓", not diffs,
          f"(宸紓 {sum(per_field.values())} 澶勶紝鎸夊瓧娈? {per_field}锛屾牱渚? {diffs[:2]})")

    # 鍒嗙粍锛氱敤銆屾垚鍛?selector 闆嗗悎 + type + label銆嶆瘮瀵癸紝缁曞紑 ID 瀛楅潰鍊?    ex_groups = sorted(
        (g["type"], g["label"],
         frozenset(ex_els[i]["selector"] for i in g["element_ids"] if i in ex_els))
        for g in example["groups"])
    lv_groups = sorted(
        (g["type"], g["label"],
         frozenset(lv_els[i]["selector"] for i in g["element_ids"] if i in lv_els))
        for g in live["groups"])
    check(f"{label}=瀵圭収: 鍒嗙粍锛坱ype/label/鎴愬憳锛夊畬鍏ㄤ竴鑷?, ex_groups == lv_groups,
          f"(example {len(ex_groups)} 缁?vs live {len(lv_groups)} 缁?")

    # 褰掑睘绛変环绫伙細example 鐨?group_id/form_id -> live 鐨勶紝蹇呴』鏄竴涓€鏄犲皠
    mapping: dict[str, str] = {}
    bad: list[str] = []
    for sel in sorted(set(ex_els) & set(lv_els)):
        for f in ("group_id", "form_id"):
            a, b = ex_els[sel].get(f), lv_els[sel].get(f)
            if a is None and b is None:
                continue
            if a is None or b is None:
                bad.append(f"{sel}::{f} ex={a} lv={b}")
                continue
            if mapping.setdefault(a, b) != b:
                bad.append(f"{sel}::{f} {a} 鍚屾椂鏄犲皠鍒?{mapping[a]} 鍜?{b}")
    check(f"{label}=瀵圭収: group_id/form_id 褰掑睘鍏崇郴涓€涓€瀵瑰簲", not bad,
          f"(鐭涚浘 {len(bad)}: {bad[:3]})")


# --------------------------------------------------------------------------
SCHEMA = json.loads((DOCS_DIR / "elements.schema.json").read_text(encoding="utf-8-sig"))


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # Windows 鎺у埗鍙伴粯璁?GBK锛屼腑鏂囨爣绛句細涔辩爜
    except Exception:  # noqa: BLE001
        pass
    parser = argparse.ArgumentParser(description="extract.js 鐜板満楠岃瘉")
    parser.add_argument("--dump", default=None, help="鎶婃瘡涓〉闈㈢殑浜у嚭鍐欏埌姝ょ洰褰?)
    args = parser.parse_args()

    print("=== 鍓嶇疆妫€鏌?===")
    check("easyview-extension/src/extract.js 瀛樺湪", EXTRACT_JS.is_file(), str(EXTRACT_JS))
    src = EXTRACT_JS.read_text(encoding="utf-8")
    check("extract.js 鏃?import/export 妯″潡璇硶",
          not re.search(r"^\s*(import|export)\s", src, re.M))
    check("extract.js 鍔犺浇鏃朵笉鑷姩鎵ц run()锛堝彧鎸傝浇鎺ュ彛锛?,
          "globalThis.EasyViewExtract" in src and "EasyViewExtract = {" in src)
    dump_dir = Path(args.dump) if args.dump else None
    if dump_dir:
        dump_dir.mkdir(parents=True, exist_ok=True)

    tmp = Path(tempfile.mkdtemp(prefix="easyview-extract-"))
    big_page, big_expect = build_big_page(tmp)

    cases = [(name, FIXTURES_DIR / f"{name}.html") for name in
             ("hospital", "gov", "traffic", "generic")]
    cases.append(("big", big_page))

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            for label, path in cases:
                print(f"\n=== {label} ({path.name}) ===")
                page = browser.new_page(viewport=VIEWPORT)
                errors: list[str] = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(path.as_uri())
                page.add_script_tag(path=str(EXTRACT_JS))
                probe = run_probe(page)
                if probe.get("error"):
                    check(f"{label}: run() 鍙敤", False, probe["error"])
                    page.close()
                    continue
                check(f"{label}: 娉ㄥ叆鍚庢棤 JS 寮傚父", not errors, f"({errors[:2]})")
                print_summary(label, probe["doc"])
                if label == "big":
                    check_truncation(probe, big_expect)
                else:
                    validate_document(probe["doc"], probe, label)
                if dump_dir:
                    (dump_dir / f"elements.{label}.live.json").write_text(
                        json.dumps(probe["doc"], ensure_ascii=False, indent=2), encoding="utf-8")
                page.close()
        finally:
            browser.close()

    # ---- 瀵圭収鍥哄寲浜у嚭锛堟妸 fixture 鐢ㄨ矾鐢辨寕鍒?demo 鍩熷悕锛岄€愬瓧娈垫瘮瀵圭湡鍊硷級 ----
    print(f"\n{'=' * 52}")
    print("=== 瀵圭収 docs/examples 鍥哄寲浜у嚭 ===")
    fixtures = {n: FIXTURES_DIR / f"{n}.html"
                for n in ("hospital", "gov", "traffic", "generic")}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            for label in ("hospital", "gov", "traffic"):
                ex_path = DOCS_DIR / "examples" / f"elements.{label}.json"
                if not ex_path.is_file():
                    continue
                example = json.loads(ex_path.read_text(encoding="utf-8-sig"))
                page = browser.new_page(viewport=VIEWPORT)
                page.route("https://demo.easyview.local/**",
                           lambda route, request: serve_demo(route, request, fixtures))
                page.goto(example["page_url"])
                page.add_script_tag(path=str(EXTRACT_JS))
                probe = run_probe(page)
                print(f"\n--- {label} @ {example['page_url']} ---")
                if probe.get("error"):
                    check(f"{label}=瀵圭収: run() 鍙敤", False, probe["error"])
                else:
                    check_against_example(label, probe, example)
                page.close()
        finally:
            browser.close()

    print(f"\n{'=' * 52}")
    print(f"鐜板満楠岃瘉缁撴灉: {_ok} 閫氳繃 / {_fail} 澶辫触")
    print("=" * 52)
    return 1 if _fail else 0


if __name__ == "__main__":
    raise SystemExit(main())

