# -*- coding: utf-8 -*-
"""浮点 repr 的定点核对：Python 的 str(float) vs JS 的 pyNumRepr 等价实现。"""
import json
import random
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "ai-service"))
import digest  # noqa: E402

JS = """
(doc) => {
  const out = {};
  const text = globalThis.EasyViewDigest.build(doc, {});
  for (const line of text.split("\\n")) {
    const m = /^\\[el_(\\d+)\\] \\S+ value=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
"""


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    rng = random.Random(11)
    vals = [0.0, -0.0, 1.5, 0.1, 100.0, 1e15, 1e16, 1e17, 1.5e-7, 1e-5, 1e-4, 1e21,
            -1234.5678, 3.0, 2.0 / 3.0, 123456789.123456789, 1.2e29, 5e-324, 1.7976931348623157e308,
            0.5, -0.5, 2.5, 123.456, 1000000.000001]
    for _ in range(60):
        vals.append(rng.uniform(-1e6, 1e6))
    for _ in range(30):
        vals.append(rng.uniform(-1, 1) * 10 ** rng.randint(-20, 20))

    doc = {
        "page_url": "https://a.com/", "page_title": "t",
        "elements": [
            {"id": "el_%04d" % i, "type": "input", "value": v, "selector": "#a",
             "bbox": {"y": float(i), "height": 1.0}}
            for i, v in enumerate(vals)
        ],
        "groups": [],
    }
    py = digest.build_digest(doc)

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("about:blank")
        page.add_script_tag(path=str(REPO / "easyview-extension" / "src" / "digest.js"))
        js = page.evaluate(JS, doc)
        browser.close()

    py_map = {}
    for line in py.split("\n"):
        if line.startswith("[el_") and " value=" in line:
            head, value = line.split(" value=", 1)
            py_map[head[4:head.index("]")]] = value

    bad = 0
    for i, v in enumerate(vals):
        key = "%04d" % i
        a, b = py_map.get(key), js.get(key)
        if a != b:
            bad += 1
            if bad <= 15:
                print("DIFF %r  python=%s js=%s" % (v, a, b))
    print("共 %d 个浮点，不一致 %d 个" % (len(vals), bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
