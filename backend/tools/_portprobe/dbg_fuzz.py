# -*- coding: utf-8 -*-
"""针对某个 fuzz 用例，逐分区对比 Python 与 JS 的分区/排序结果。"""
import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
REPO = TOOLS.parent.parent
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(REPO / "ai-service"))

import check_port_fidelity as cpf  # noqa: E402
import digest  # noqa: E402
import random  # noqa: E402

JS_DUMP = """
(payload) => {
  const res = globalThis.EasyViewDigest.buildSections(payload.doc, {});
  return res[0].map((s) => ({
    title: s.title, kind: s.kind, y: s.y, seq: s.seq,
    ids: s.elements.map((e) => e && e.id),
    ys: s.elements.map((e) => (e && e.bbox && typeof e.bbox.y === "number") ? e.bbox.y : null),
    orders: s.elements.map((e) => (e ? e.order : null)),
  }));
}
"""


def py_dump(data):
    sections, dropped = digest.build_sections(data)
    out = []
    for s in sections:
        out.append({
            "title": s["title"], "kind": s["kind"], "y": s["y"], "seq": s["seq"],
            "ids": [e.get("id") for e in s["elements"]],
            "ys": [(e.get("bbox") or {}).get("y") if isinstance(e.get("bbox"), dict) else None
                   for e in s["elements"]],
            "orders": [e.get("order") for e in s["elements"]],
        })
    return out, dropped


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    index = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    rng = random.Random(cpf.__dict__.get("SEED", 20261002))
    case = None
    for i in range(index + 1):
        case = cpf.gen_fuzz_case(rng, i)
    name, data, draft, extra = case
    print("case:", name)

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("about:blank")
        page.add_script_tag(path=str(REPO / "easyview-extension" / "src" / "digest.js"))
        js_sections = page.evaluate(JS_DUMP, {"doc": data})
        js_text = page.evaluate(
            "(payload) => globalThis.EasyViewDigest.build(payload.doc, {})", {"doc": data})
        browser.close()

    py_text = digest.build_digest(data)
    if py_text != js_text:
        py_lines = py_text.split("\n")
        js_lines = js_text.split("\n")
        print("lines py=%d js=%d" % (len(py_lines), len(js_lines)))
        shown = 0
        for i in range(max(len(py_lines), len(js_lines))):
            a = py_lines[i] if i < len(py_lines) else "<缺>"
            b = js_lines[i] if i < len(js_lines) else "<缺>"
            if a != b:
                print("  line %d" % i)
                print("    py: %r" % a)
                print("    js: %r" % b)
                shown += 1
                if shown >= 12:
                    print("  ...(只显示前 12 处)")
                    break

    py_sections, py_dropped = py_dump(data)
    print("sections py=%d js=%d" % (len(py_sections), len(js_sections)))
    for i in range(max(len(py_sections), len(js_sections))):
        a = py_sections[i] if i < len(py_sections) else None
        b = js_sections[i] if i < len(js_sections) else None
        if a is None or b is None:
            print("[%d] ONLY %s %r %r" % (i, "py" if a else "js", a or b, ""))
            continue
        if (a["title"], a["ids"]) == (b["title"], b["ids"]):
            continue
        print("[%d] TITLE py=%r js=%r" % (i, a["title"], b["title"]))
        print("    py y=%r seq=%r" % (a["y"], a["seq"]))
        print("    js y=%r seq=%r" % (b["y"], b["seq"]))
        for j in range(max(len(a["ids"]), len(b["ids"]))):
            ai = a["ids"][j] if j < len(a["ids"]) else None
            bi = b["ids"][j] if j < len(b["ids"]) else None
            if ai != bi:
                print("      idx %d py=%r(y=%r,order=%r) js=%r(y=%r,order=%r)"
                      % (j, ai, a["ys"][j] if j < len(a["ys"]) else None,
                         a["orders"][j] if j < len(a["orders"]) else None,
                         bi, b["ys"][j] if j < len(b["ys"]) else None,
                         b["orders"][j] if j < len(b["orders"]) else None))
                break
        py_ids, js_ids = set(a["ids"]), set(b["ids"])
        if py_ids != js_ids:
            print("      only-py=%r only-js=%r" % (sorted(py_ids - js_ids, key=str),
                                                   sorted(js_ids - py_ids, key=str)))
        print("      py full:")
        for j, eid in enumerate(a["ids"]):
            print("        %2d %-12r y=%-10r order=%-8r" % (j, eid, a["ys"][j], a["orders"][j]))
        print("      js full:")
        for j, eid in enumerate(b["ids"]):
            print("        %2d %-12r y=%-10r order=%-8r" % (j, eid, b["ys"][j], b["orders"][j]))


if __name__ == "__main__":
    main()
