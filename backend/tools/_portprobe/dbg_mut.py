# -*- coding: utf-8 -*-
"""两个问题：(1) build 会不会改 doc？(2) 同一会话里结果会不会漂移？"""
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
  const snapBefore = JSON.stringify(payload.doc);
  const t1 = globalThis.EasyViewDigest.build(payload.doc, {});
  const snapAfter = JSON.stringify(payload.doc);
  const t2 = globalThis.EasyViewDigest.build(payload.doc, {});
  return { text: t1, text2: t2, mutated: snapBefore !== snapAfter };
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

        def run(doc, label):
            out = page.evaluate(JS, {"doc": doc})
            same = out["text"] == py_text
            print("  %-16s 与python相同=%-5s 两次相同=%-5s build 改了 doc=%s"
                  % (label, same, out["text"] == out["text2"], out["mutated"]))
            return out["text"]

        t0 = run(data, "初始")
        feeds = [(n, d) for (n, d, _dr, _ex) in cpf.boundary_cases()]
        for n, d in feeds[:6]:
            page.evaluate("(payload) => globalThis.EasyViewDigest.build(payload.doc, {})", {"doc": d})
            run(data, "喂 %s 后" % n)
        browser.close()
    print("最终一致:", t0 == py_text)


if __name__ == "__main__":
    main()
