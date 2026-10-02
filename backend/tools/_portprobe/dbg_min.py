# -*- coding: utf-8 -*-
"""最小复现：同一份 doc 在同一会话里，结果为什么会变。"""
import copy
import hashlib
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


def h(obj):
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    rng = random.Random(20261002)
    cases = [cpf.gen_fuzz_case(rng, i) for i in range(14)]
    name, data, _draft, _extra = cases[13]
    feeds = cpf.boundary_cases()
    empty = feeds[0][1]
    missing = feeds[1][1]

    py_text = digest.build_digest(copy.deepcopy(data))
    print("python doc hash", h(data), "py_text len", len(py_text))

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("about:blank")
        page.add_script_tag(path=str(REPO / "easyview-extension" / "src" / "digest.js"))

        def run(doc, label):
            doc_hash = h(doc)
            before = json.dumps(doc, ensure_ascii=False, sort_keys=True)
            out = page.evaluate(
                "(payload) => { const t = globalThis.EasyViewDigest.build(payload.doc, {});"
                " return { text: t, after: JSON.stringify(payload.doc) }; }",
                {"doc": doc})
            same = out["text"] == py_text
            mutated = out["after"] != before
            print("  %-14s doc-hash=%s  与python相同=%s  JS内 doc 被改=%s"
                  % (label, doc_hash, same, mutated))
            return out["text"]

        t0 = run(data, "初始")
        t1 = run(data, "再来一次")
        print("  两次 JS 相同:", t0 == t1)
        run(empty, "喂 empty")
        t2 = run(data, "喂后")
        run(missing, "喂 missing")
        t3 = run(data, "再喂后")
        browser.close()

    for label, t in [("初始", t0), ("喂empty后", t2), ("喂missing后", t3)]:
        print("%s 与 python 相同: %s" % (label, t == py_text))


if __name__ == "__main__":
    main()
