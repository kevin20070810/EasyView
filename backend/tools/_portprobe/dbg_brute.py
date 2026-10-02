# -*- coding: utf-8 -*-
"""暴力找：喂入哪个 doc 会让目标 doc 的结果变化；变化前后的元素分别是什么。"""
import copy
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
  const t = globalThis.EasyViewDigest.build(payload.doc, {});
  return t;
}
"""

JS_SECTIONS = """
(payload) => {
  const r = globalThis.EasyViewDigest.buildSections(payload.doc, {});
  return r[0].map((s) => ({ title: s.title, ids: s.elements.map((e) => e.id) }));
}
"""


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    rng = random.Random(20261002)
    cases = [cpf.gen_fuzz_case(rng, i) for i in range(14)]
    name, data, _draft, _extra = cases[13]
    py_text = digest.build_digest(copy.deepcopy(data))

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("about:blank")
        page.add_script_tag(path=str(REPO / "easyview-extension" / "src" / "digest.js"))

        base = page.evaluate(JS, {"doc": data})
        print("初始与 python 相同:", base == py_text)

        feeds = [(n, d) for (n, d, _dr, _ex) in cpf.boundary_cases()]
        feeds += [("fuzz_%03d" % i, cases[i][1]) for i in range(13)]
        trigger = None
        for n, d in feeds:
            page.evaluate(JS, {"doc": d})
            now = page.evaluate(JS, {"doc": data})
            if now != base:
                print("喂入 %s 后结果变化: 与python相同=%s" % (n, now == py_text))
                trigger = (n, d, now)
                break
        if trigger is None:
            print("没找到触发者（本轮没有漂移）")
        else:
            n, d, now = trigger
            # 再跑一次确认是否只是"排序不稳定"
            again = page.evaluate(JS, {"doc": data})
            print("  再跑一次是否相同:", again == now, " 与 base 相同:", again == base)
            a = base.split("\n")
            b = now.split("\n")
            for i in range(max(len(a), len(b))):
                x = a[i] if i < len(a) else "<缺>"
                y = b[i] if i < len(b) else "<缺>"
                if x != y:
                    print("  漂移 line %d\n    base: %r\n    now : %r" % (i, x, y))
            print("  base sections:", json.dumps(page.evaluate(JS_SECTIONS, {"doc": data}),
                                                ensure_ascii=False)[:200])
        browser.close()


if __name__ == "__main__":
    main()
