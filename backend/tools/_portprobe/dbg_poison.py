# -*- coding: utf-8 -*-
"""找出：同一份 doc 在浏览器会话里被前面的用例"污染"的根因。"""
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
REPO = TOOLS.parent.parent
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(REPO / "ai-service"))

import check_port_fidelity as cpf  # noqa: E402
import random  # noqa: E402

JS_TWICE = """
(payload) => {
  const a = globalThis.EasyViewDigest.build(payload.doc, {});
  const b = globalThis.EasyViewDigest.build(payload.doc, {});
  return { same: a === b, a: a, b: b };
}
"""


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    index = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    prefix = int(sys.argv[2]) if len(sys.argv) > 2 else index
    rng = random.Random(20261002)
    cases = [cpf.gen_fuzz_case(rng, i) for i in range(index + 1)]
    name, data, draft, extra = cases[index]
    py_text = cpf.run_python(name, data, draft, extra, cpf.SHA256_ENCODED.encode())[ "digest"]
    print("case", name, "python", len(py_text))

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("about:blank")
        page.add_script_tag(path=str(REPO / "easyview-extension" / "src" / "digest.js"))

        res = page.evaluate(JS_TWICE, {"doc": data})
        print("空会话: 两次相同=%s  与 python 相同=%s" % (res["same"], res["a"] == py_text))

        feeds = [(n, d) for (n, d, _dr, _ex) in cpf.boundary_cases()]
        feeds += [("fuzz_%03d" % i, cases[i][1]) for i in range(index)]

        # 依次喂前面的用例，找第一个把它搞坏的
        for n, d in feeds:
            before = page.evaluate(JS_TWICE, {"doc": data})
            ok_before = before["a"] == py_text
            page.evaluate("(payload) => globalThis.EasyViewDigest.build(payload.doc, {})", {"doc": d})
            after = page.evaluate(JS_TWICE, {"doc": data})
            ok_after = after["a"] == py_text
            if ok_before != ok_after or not ok_after:
                print("  喂入 %s 之后: %s -> %s (两次相同=%s)"
                      % (n, "OK" if ok_before else "BAD", "OK" if ok_after else "BAD",
                         after["same"]))
                if not ok_after:
                    py_lines = py_text.split("\n")
                    js_lines = after["a"].split("\n")
                    print("    python 行数 %d, js 行数 %d" % (len(py_lines), len(js_lines)))
                    for k in range(max(len(py_lines), len(js_lines))):
                        x = py_lines[k] if k < len(py_lines) else "<缺>"
                        y = js_lines[k] if k < len(js_lines) else "<缺>"
                        if x != y:
                            print("    line %d\n      py: %r\n      js: %r" % (k, x, y))
                    break
        browser.close()


if __name__ == "__main__":
    main()
