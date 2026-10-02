# -*- coding: utf-8 -*-
"""复刻 checker 的单用例流程，确认 fuzz_013 到底差在哪。"""
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
    index = int(sys.argv[1]) if len(sys.argv) > 1 else 13
    rng = random.Random(20261002)
    cases = [cpf.gen_fuzz_case(rng, i) for i in range(index + 1)]
    name, data, draft, extra = cases[-1]
    print("case", name, "elements", len(data["elements"]))

    raw = cpf.SHA256_ENCODED.encode("utf-8")

    # 1) 单独跑
    py = cpf.run_python(name, data, draft, extra, raw)
    js = cpf.run_js({name: {"doc": data, "draft": py["draft"],
                            "sha256": cpf.SHA256_ENCODED, "generator": cpf.GENERATOR,
                            "user_goal": extra.get("user_goal")}})[name]
    print("单独跑 equal:", py["digest"] == js["digest"])

    # 2) 像 checker 一样：把前面所有 fuzz 用例一起丢进同一个浏览器会话
    payloads = {}
    for n, d, dr, ex in cases:
        payloads[n] = {"doc": d, "draft": dr, "sha256": cpf.SHA256_ENCODED,
                       "generator": cpf.GENERATOR, "user_goal": ex.get("user_goal")}
    js_all = cpf.run_js(payloads)
    for n, d, dr, ex in cases:
        p = cpf.run_python(n, d, dr, ex, raw)
        same = p["digest"] == js_all[n]["digest"]
        if not same:
            print("会话内 MISMATCH:", n)

    # 3) 把该用例单独放在一个会话里再跑一次
    js2 = cpf.run_js({name: {"doc": data, "draft": py["draft"],
                             "sha256": cpf.SHA256_ENCODED, "generator": cpf.GENERATOR,
                             "user_goal": extra.get("user_goal")}})[name]
    print("会话外再跑 equal:", py["digest"] == js2["digest"])

    py_text = py["digest"]
    js_text = js2["digest"]
    if py_text != js_text:
        Path(TOOLS / "_portprobe" / "case13.py.txt").write_text(py_text, encoding="utf-8")
        Path(TOOLS / "_portprobe" / "case13.js.txt").write_text(js_text, encoding="utf-8")
        Path(TOOLS / "_portprobe" / "case13.doc.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        py_lines = py_text.split("\n")
        js_lines = js_text.split("\n")
        for i in range(max(len(py_lines), len(js_lines))):
            a = py_lines[i] if i < len(py_lines) else "<缺>"
            b = js_lines[i] if i < len(js_lines) else "<缺>"
            if a != b:
                print("line %d\n  py: %r\n  js: %r" % (i, a, b))


if __name__ == "__main__":
    main()
