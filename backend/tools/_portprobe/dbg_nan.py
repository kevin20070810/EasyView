# -*- coding: utf-8 -*-
"""目标用例里到底有没有 NaN？漂移的元素是谁？"""
import copy
import hashlib
import json
import math
import random
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
REPO = TOOLS.parent.parent
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(REPO / "ai-service"))

import check_port_fidelity as cpf  # noqa: E402
import digest  # noqa: E402

JS_HASH = """
(payload) => {
  const enc = JSON.stringify(payload.doc);
  return { hash: enc.length + ":" + enc.slice(0, 40), text: globalThis.EasyViewDigest.build(payload.doc, {}) };
}
"""


def py_hash(obj):
    enc = json.dumps(obj, ensure_ascii=False, sort_keys=True)
    return "%d:%s" % (len(enc), enc[:40])


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    rng = random.Random(20261002)
    cases = [cpf.gen_fuzz_case(rng, i) for i in range(14)]
    name, data, _draft, _extra = cases[13]
    py_text = digest.build_digest(copy.deepcopy(data))

    # NaN 检查
    nans = []
    for e in data["elements"]:
        b = e.get("bbox")
        if isinstance(b, dict):
            for k in ("y", "height"):
                v = b.get(k)
                if isinstance(v, str):
                    try:
                        if math.isnan(float(v)):
                            nans.append((e.get("id"), k, v))
                    except ValueError:
                        pass
    print("NaN bbox 元素:", nans)

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("about:blank")
        page.add_script_tag(path=str(REPO / "easyview-extension" / "src" / "digest.js"))

        def run(label):
            out = page.evaluate(JS_HASH, {"doc": data})
            print("  %-14s py-doc=%s js-doc=%s 与python相同=%s"
                  % (label, py_hash(data), out["hash"], out["text"] == py_text))
            return out["text"]

        t0 = run("初始")
        for n, d in [(x[0], x[1]) for x in cpf.boundary_cases()][:3]:
            print("  --feed %s (py-doc=%s js-doc=%s)" % (n, py_hash(d), page.evaluate(
                "(payload) => { const e = JSON.stringify(payload.doc); return e.length + ':' + e.slice(0,40); }",
                {"doc": d})))
            page.evaluate("(payload) => globalThis.EasyViewDigest.build(payload.doc, {})", {"doc": d})
            run("喂 %s 后" % n)
        t1 = page.evaluate(JS_HASH, {"doc": data})["text"]
        browser.close()

    if t0 != t1:
        a = t0.split("\n")
        b = t1.split("\n")
        for i in range(max(len(a), len(b))):
            x = a[i] if i < len(a) else "<缺>"
            y = b[i] if i < len(b) else "<缺>"
            if x != y:
                print("漂移 line %d\n  前: %r\n  后: %r" % (i, x, y))


if __name__ == "__main__":
    main()
