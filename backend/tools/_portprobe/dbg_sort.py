# -*- coding: utf-8 -*-
"""只对比排序本身：给同一串 key，Python 的 sorted 与 pySortByKey 的顺序是否一致。"""
import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
REPO = TOOLS.parent.parent
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(REPO / "ai-service"))

JS = """
(keys) => globalThis.__EV_PYSORT(keys)
"""


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    nan = float("nan")
    cases = {
        "全部有序": [[0, 0], [10, 4], [20, 0], [30, 1]],
        "含 nan 在前": [[nan, 0], [10, 4], [0, 0]],
        "含 nan 在中": [[0, 0], [nan, 0], [10, 4]],
        "含 nan 在后": [[0, 0], [10, 4], [nan, 0]],
        "83 的 key 序列": [[10, 4], [10, 4], [10, 4], [nan, 0], [nan, 0], [10, 4], [0, 0], [0, 0]],
        "全 nan": [[nan, 0], [nan, 1], [nan, 2]],
        "降序": [[30, 0], [20, 0], [10, 0]],
        "等值": [[5, 0], [5, 0], [5, 0], [5, 0]],
        "nan+降序": [[nan, 0], [30, 0], [20, 0], [10, 0]],
        "100 项含 nan": [[i % 7, i] for i in range(100)] + [[nan, 999]],
    }
    allkeys = [k for v in cases.values() for k in v]

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("about:blank")
        page.add_script_tag(path=str(REPO / "easyview-extension" / "src" / "digest.js"))
        js_results = {name: page.evaluate(JS, keys) for name, keys in cases.items()}
        browser.close()

    for name, keys in cases.items():
        js_sorted = js_results[name]
        py_sorted = sorted(keys, key=lambda k: tuple(k))
        same = py_sorted == js_sorted
        print("%-14s %s" % (name, "OK" if same else "MISMATCH"))
        if not same:
            print("   keys : %s" % (keys,))
            print("   py   : %s" % (py_sorted,))
            print("   js   : %s" % (js_sorted,))


if __name__ == "__main__":
    main()
