# -*- coding: utf-8 -*-
"""对比 Python 与 JS 在 merge 之前的 sections（含成员顺序）。"""
import json
import random
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
REPO = TOOLS.parent.parent
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(REPO / "ai-service"))

import check_port_fidelity as cpf  # noqa: E402
import digest  # noqa: E402

JS = """
(payload) => {
  globalThis.__EV_DEBUG = {};
  globalThis.EasyViewDigest.build(payload.doc, {});
  const d = globalThis.__EV_DEBUG;
  globalThis.__EV_DEBUG = null;
  return d.sections;
}
"""


def py_sections_before_merge(data):
    """复刻 _build_sections 直到 sort，但不 merge。"""
    import copy
    d = copy.deepcopy(data)
    # 直接调用内部函数
    return digest._build_sections(d)


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    index = int(sys.argv[1]) if len(sys.argv) > 1 else 83
    rng = random.Random(20261002)
    cases = [cpf.gen_fuzz_case(rng, i) for i in range(index + 1)]
    name, data, _d, _e = cases[index]

    # Python：手工复刻 _build_sections 的最后一步
    import copy as _copy
    sections = digest._build_sections(_copy.deepcopy(data))
    py = [(s["title"], s["y"], s["seq"], [e.get("id") for e in s["elements"]]) for s in sections]

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("about:blank")
        page.add_script_tag(path=str(REPO / "easyview-extension" / "src" / "digest.js"))
        js = page.evaluate(JS, {"doc": data})
        browser.close()

    print("merge 前 sections: py=%d js=%d" % (len(py), len(js)))
    for i in range(max(len(py), len(js))):
        a = py[i] if i < len(py) else None
        b = js[i] if i < len(js) else None
        mark = "  " if a == b else "**"
        print("%s [%d] py=%s" % (mark, i, a))
        print("%s     js=%s" % (mark, b))


if __name__ == "__main__":
    main()
