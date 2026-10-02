# -*- coding: utf-8 -*-
"""digest 的健壮性与边界测试。"""
import json, pathlib, sys
sys.path.insert(0, ".")
from digest import build_digest, build_sections, digest_stats, _y_top, _text_of

EX = pathlib.Path(r"D:\EasyView\docs\examples")
ok = fail = 0
def check(name, cond, detail=""):
    global ok, fail
    if cond: ok += 1; print(f"  [PASS] {name}")
    else: fail += 1; print(f"  [FAIL] {name} {detail}")

print("=== 1. 三份真实快照 ===")
for name in ("hospital", "gov", "traffic"):
    d = json.loads((EX / f"elements.{name}.json").read_text(encoding="utf-8"))
    text = build_digest(d)
    st = digest_stats(text, d)
    check(f"{name} 有输出", len(text) > 500)
    check(f"{name} 压缩到 10% 以内", st["ratio"] < 0.10, f"实际 {st['ratio']:.0%}")
    check(f"{name} 站点名正确", "demo.easyview.local" in text)
    check(f"{name} 无原始 selector 泄漏", "body >" not in text and "xpath" not in text)
    check(f"{name} 无完整 URL 泄漏", "https://demo" not in text)
    # 每个 id 最多出现一次
    ids = [l.split("]")[0][1:] for l in text.splitlines() if l.startswith("[el_")]
    check(f"{name} 元素不重复", len(ids) == len(set(ids)), f"{len(ids)} 行 / {len(set(ids))} 唯一")

print()
print("=== 2. 边界输入 ===")
cases = {
    "空对象": {},
    "无元素": {"elements": [], "groups": []},
    "元素非字典": {"elements": [None, 1, "x"], "groups": [None]},
    "缺 bbox": {"elements": [{"id": "el_00000001", "type": "link", "text": "测试"}], "groups": []},
    "bbox 非法": {"elements": [{"id": "el_00000001", "type": "link", "text": "x", "bbox": {"y": "abc"}}], "groups": []},
    "分组引用不存在的元素": {"elements": [], "groups": [{"id": "form_x", "type": "form", "element_ids": ["el_nope"]}]},
    "options 是字符串": {"elements": [{"id": "el_00000001", "type": "select", "options": "abc"}], "groups": []},
    "超长文本": {"elements": [{"id": "el_00000001", "type": "text", "text": "很长" * 500}], "groups": []},
}
for name, data in cases.items():
    try:
        text = build_digest(data)
        check(f"{name} 不崩溃", isinstance(text, str))
    except Exception as exc:
        check(f"{name} 不崩溃", False, f"{type(exc).__name__}: {exc}")

print()
print("=== 3. 超预算截断 ===")
d = json.loads((EX / "elements.hospital.json").read_text(encoding="utf-8"))
text = build_digest(d, max_rows=20)
rows = [l for l in text.splitlines() if l.startswith("[el_")]
check("截断生效", len(rows) <= 20, f"实际 {len(rows)} 行")
check("说明省略数量", "省略了" in text)
# 截断后按钮/输入框应该优先留下
check("截断后保留关键控件", any("提交预约" in l for l in rows))

print()
print("=== 4. 辅助函数 ===")
check("_text_of 控件优先 label",
      _text_of({"type": "input", "text": "提示语", "label": "字段名"}) == ("label", "字段名"))
check("_text_of 链接优先 text",
      _text_of({"type": "link", "text": "链接名", "label": "别的"}) == ("text", "链接名"))
check("_text_of 空元素", _text_of({}) == ("", ""))
check("_y_top 无 bbox", _y_top({}) == 0.0)

print()
print("=" * 46)
print(f"结果: {ok} 通过 / {fail} 失败")
print("=" * 46)
sys.exit(1 if fail else 0)
