# -*- coding: utf-8 -*-
"""喂 bands 前后：JS 侧拿到的 doc 表示、分区结果、文本，全部对比。"""
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
  const docEnc = JSON.stringify(payload.doc);
  const r = globalThis.EasyViewDigest.buildSections(payload.doc, {});
  const text = globalThis.EasyViewDigest.build(payload.doc, {});
  return {
    docHash: docEnc.length + ":" + docEnc.slice(0, 60),
    sections: r[0].map((s) => [s.title, s.y, s.seq, s.elements.map((e) => e.id)]),
    text: text,
  };
}
"""


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    rng = random.Random(20261002)
    cases = [cpf.gen_fuzz_case(rng, i) for i in range(14)]
    data = cases[13][1]
    bands = [d for (n, d, _a, _b) in cpf.boundary_cases() if n == "bands"][0]
    py_text = digest.build_digest(copy.deepcopy(data))

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("about:blank")
        page.add_script_tag(path=str(REPO / "easyview-extension" / "src" / "digest.js"))

        a = page.evaluate(JS, {"doc": data})
        print("初始: docHash=%s 与python相同=%s" % (a["docHash"], a["text"] == py_text))
        page.evaluate("(p) => globalThis.EasyViewDigest.build(p.doc, {})", {"doc": bands})
        b = page.evaluate(JS, {"doc": data})
        print("喂后: docHash=%s 与python相同=%s" % (b["docHash"], b["text"] == py_text))
        print("docHash 相同:", a["docHash"] == b["docHash"])

        sa = json.dumps(a["sections"], ensure_ascii=False)
        sb = json.dumps(b["sections"], ensure_ascii=False)
        print("sections 相同:", sa == sb)
        if sa != sb:
            for i in range(max(len(a["sections"]), len(b["sections"]))):
                x = a["sections"][i] if i < len(a["sections"]) else None
                y = b["sections"][i] if i < len(b["sections"]) else None
                mark = "  " if x == y else "**"
                print("%s [%d]\n     a=%s\n     b=%s" % (mark, i, x, y))
        browser.close()


if __name__ == "__main__":
    main()
