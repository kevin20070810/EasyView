# -*- coding: utf-8 -*-
"""确认 checker 里的 fuzz_013 与单独生成的 fuzz_013 是不是同一份输入。"""
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


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    rng = random.Random(20261002)
    a = cpf.gen_fuzz_case(rng, 13)
    dumped = json.loads((cpf.OUT_DIR / "fuzz_013.doc.json").read_text(encoding="utf-8"))
    ja = json.dumps(a[1], ensure_ascii=False, sort_keys=True)
    jb = json.dumps(dumped, ensure_ascii=False, sort_keys=True)
    print("doc 相同:", ja == jb)
    if ja != jb:
        pa = json.dumps(a[1], ensure_ascii=False, indent=1).split("\n")
        pb = json.dumps(dumped, ensure_ascii=False, indent=1).split("\n")
        for i in range(max(len(pa), len(pb))):
            x = pa[i] if i < len(pa) else "<缺>"
            y = pb[i] if i < len(pb) else "<缺>"
            if x != y:
                print("line %d\n  gen : %r\n  dump: %r" % (i, x, y))
                break
    print("gen  sha:", hashlib.sha256(ja.encode()).hexdigest()[:16])
    print("dump sha:", hashlib.sha256(jb.encode()).hexdigest()[:16])
    print("draft 相同:", json.dumps(a[2], sort_keys=True) == json.dumps(dumped.get("_d"), sort_keys=True))

    # 单独在空会话里跑这份 dump 出来的 doc
    py_text = cpf.digest.build_digest(dumped)
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("about:blank")
        page.add_script_tag(path=str(REPO / "easyview-extension" / "src" / "digest.js"))
        js_text = page.evaluate(
            "(payload) => globalThis.EasyViewDigest.build(payload.doc, {})", {"doc": dumped})
        browser.close()
    print("dump 出来的 doc 单独跑:", "一致" if py_text == js_text else "不一致")


if __name__ == "__main__":
    main()
