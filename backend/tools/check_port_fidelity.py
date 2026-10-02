# -*- coding: utf-8 -*-
"""digest.js / binder.js 与 Python 基准的差分测试。

用法（在 D:\\EasyView 下）：
    python backend/tools/check_port_fidelity.py                 # 具名用例 + 150 组随机输入
    python backend/tools/check_port_fidelity.py --fuzz 500      # 加大随机量
    python backend/tools/check_port_fidelity.py --fuzz 0        # 只跑具名用例

做四件事：
 1. 三份 fixture：分别调用 ai-service/digest.py 与 ai-service/binder.py
    （binder 的草稿由 pipeline.rules_draft() 生成），落基准文件；
 2. Playwright 打开空白页注入 easyview-extension/src/digest.js / binder.js，
    对同样输入调用 JS 版，把结果抓回 Python；
 3. 逐字节比对：digest 文本必须完全一致；ui_schema 用
    json.dumps(..., ensure_ascii=False, sort_keys=True) 必须完全一致，
    并额外比对"不排序"的序列化（检查键序）与 dropped_report；
 4. 跑边界输入 + 随机输入，两边必须一致或"同样报错"；
    另外单独验证几处"Python 与 JS 天生不同"的地方。

产物写在 backend/tools/port_fidelity_out/ 下：
    <case>.py.digest.txt / <case>.js.digest.txt
    <case>.py.schema.json / <case>.js.schema.json
    report.txt
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import sys
import traceback
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO_DIR = TOOLS_DIR.parent.parent
AI_DIR = REPO_DIR / "ai-service"
EXAMPLES = REPO_DIR / "docs" / "examples"
EXT_SRC = REPO_DIR / "easyview-extension" / "src"
OUT_DIR = TOOLS_DIR / "port_fidelity_out"

sys.path.insert(0, str(AI_DIR))

import binder  # noqa: E402
import digest  # noqa: E402
import pipeline  # noqa: E402

FIXTURES = ["elements.hospital.json", "elements.gov.json", "elements.traffic.json"]

# 两边写死的同一组参数，否则没法比
GENERATED_AT = "2026-10-02T12:00:00+08:00"
SHA256_ENCODED = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
GENERATOR = {"mode": "rules", "prompt_version": None, "fallback_reason": None}


# --------------------------------------------------------------------------
# 造输入的小工具
# --------------------------------------------------------------------------

def el(eid, etype, **kwargs):
    base = {
        "id": eid, "type": etype, "text": None, "label": None, "aria_label": None,
        "placeholder": None, "name": None, "value": None, "href": None,
        "selector": "body > div > *", "xpath": "/html[1]/body[1]/div[1]/*[1]",
        "visible": True, "bbox": {"x": 10.0, "y": 10.0, "width": 100.0, "height": 20.0},
        "group_id": None, "in_form": False, "form_id": None, "required": None,
        "disabled": False, "level": None, "options": None, "order": 0,
    }
    base.update(kwargs)
    return base


def doc(elements=None, groups=None, **kwargs):
    out = {
        "schema_version": "0.3.0-draft",
        "page_url": "https://demo.easyview.local/index",
        "final_url": "https://demo.easyview.local/index",
        "page_title": "测试页面",
        "lang": "zh-CN",
        "source": "extract",
        "fallback_reason": None,
        "extracted_at": "2026-10-02T11:59:00+08:00",
        "stats": {"total": len(elements or []), "visible": len(elements or []), "truncated": False},
        "elements": elements or [],
        "groups": groups or [],
    }
    out.update(kwargs)
    return out


# --------------------------------------------------------------------------
# 具名边界输入
# --------------------------------------------------------------------------

def boundary_cases():
    cases = []

    # 1. 全空
    cases.append(("empty", doc(), "rules"))

    # 2. 缺字段：只有 id/type，其余键全无；groups / stats 也没有
    cases.append(("missing_fields", {
        "page_url": None, "final_url": None, "page_title": None, "source": None,
        "elements": [{"id": "el_a", "type": "link"}, {"id": "el_b", "type": "text"},
                     {"type": "text"}, {"id": "el_c"}],
    }, "rules"))

    # 3. 超长文本 / 超长路径 / 超长选项
    cases.append(("long_text", doc([
        el("el_t1", "text", text="很长的文字" * 40),
        el("el_t2", "text", text="a" * 59),
        el("el_t3", "text", text="b" * 60),
        el("el_t4", "text", text="c" * 61),
        el("el_t5", "link", text="超长链接文字" * 10, href="https://a.com/" + "p" * 100),
        el("el_t6", "input", label="姓名", placeholder="请输入" + "很长" * 40,
           options=["选项" * 40, "第二个选项"]),
        el("el_t7", "link", text="短", href="/" + "q" * 39),
        el("el_t8", "link", text="短2", href="/" + "q" * 40),
        el("el_t9", "link", text="短3", href="/" + "q" * 41),
        el("el_t10", "link", text="短4", href="/" + "路" * 41),
    ]), "rules"))

    # 4. emoji / 星平面字符（切片的码点 vs 码元差异）
    cases.append(("emoji_astral", doc([
        el("el_e1", "text", text="😀" * 61),
        el("el_e2", "text", text="😀" * 60),
        el("el_e3", "text", text="😀" * 59),
        el("el_e4", "link", text="😀页面入口", href="/x"),
        el("el_e5", "text", text="𝕏" * 61),
        el("el_e6", "text", text="中😀文😀字"),
        el("el_e7", "input", label="😀" * 20, placeholder="😀提示"),
        el("el_e8", "select", label="选择", options=[{"label": "😀" * 61, "value": "1"}]),
        el("el_e9", "link", text="😀😀😀😀😀", href="/" + "😀" * 41),
        el("el_e10", "text", text="👨‍👩‍👧‍👦家庭"),
    ]), "rules"))

    # 5. Unicode 空白（NBSP / 全角空格 / NEL / FS / FEFF / VT）
    cases.append(("unicode_space", doc([
        el("el_s1", "text", text="\u00a0登\u3000录\u0085测\x1c试\ufeff文\x0b字\u2003"),
        el("el_s2", "text", text="  \t\n 前后空白 \r\n "),
        el("el_s3", "text", text="a\u00a0\u00a0b\u3000\u3000c"),
        el("el_s4", "heading", text="登 录"),
        el("el_s5", "heading", text="登\u3000录"),
        el("el_s6", "heading", text="中\t文 测 试"),
        el("el_s7", "text", text="\u00a0"),
        el("el_s8", "link", text="入口", href="https://a.com/\u00a0x\u3000y"),
        el("el_s9", "text", text="\u2028\u2029\u202f\u205f\u1680"),
    ], [
        {"id": "grp_1", "type": "form", "label": "登 录", "element_ids": ["el_s4"]},
        {"id": "grp_2", "type": "list", "label": "", "element_ids": ["el_s6"]},
    ]), "rules"))

    # 6. 页头/主体/页脚分带 + 页脚特征词
    cases.append(("bands", doc([
        el("el_b1", "link", text="首页", href="/", bbox={"y": 0.0, "height": 20.0}),
        el("el_b2", "text", text="版权所有", bbox={"y": 200.0, "height": 20.0}),
        el("el_b3", "text", text="正文内容", bbox={"y": 100.0, "height": 20.0}),
        el("el_b4", "text", text="ICP 备案号", bbox={"y": 10.0, "height": 20.0}),
        el("el_b5", "text", text="底部", bbox={"y": 260.0, "height": 20.0}),
        el("el_b6", "nav", text="导航", bbox={"y": 5.0, "height": 20.0}),
    ]), "rules"))

    # 7. 超预算（>160 行）触发丢弃
    big = [el(f"el_x{i:04d}", "link" if i % 3 == 0 else "text",
              text=f"条目 {i}", href="/p" + str(i),
              bbox={"y": float(i), "height": 10.0}) for i in range(200)]
    big += [el("el_foot", "text", text="版权", bbox={"y": 999.0, "height": 10.0})]
    cases.append(("budget", doc(big), "rules"))

    # 8. 各种 href
    hrefs = ["javascript:void(0)", "tel:123", "tel://host/1", "mailto:a@b.com", "#frag",
             "/guahao?x=1#f", "https://例子.中国/路径?q=1", "https://[::1]:8080/x",
             "https://[::1/x", "www.example.com/x", "HTTP://EXAMPLE.COM:8080/a",
             "//host/p", "  https://a.com/path  ", "https://u:p@Host.COM:443/x",
             "a/b", "", "https://host:99999/x", "https://host:abc/x", "snapshot://abc/def",
             "https://a.com:80", "https://a.com/x#y#z", "ht\ntp://a.com/x", "中文://host/p",
             "https://[fe80::1%25eth0]:80/x", "https://[192.168.1.1]/x", "https://[gggg::1]/x",
             "https://[v1a.b]/x", "https://[vzzz.b]/x", "https://a.com", "?q=1", "a:b",
             "https://xn--fiqs8s.example/", "https://ＡＢＣ.com/", "https://a.com/\u2100x"]
    cases.append(("weird_urls", doc([
        el(f"el_u{i}", "link", text=f"入口{i}", href=h) for i, h in enumerate(hrefs)
    ]), "rules"))

    # 9. 重复 id、缺 id、非对象条目、组引用缺失、table 组、容器元素配对
    cases.append(("structure_odd", {
        "schema_version": "0.3.0-draft",
        "page_url": "https://demo.easyview.local/x",
        "page_title": "结构",
        "source": "extract",
        "stats": {"total": 8, "visible": 3, "truncated": True},
        "elements": [
            el("el_dup", "text", text="第一份", bbox={"y": 10.0, "height": 5.0}),
            el("el_dup", "text", text="第二份", bbox={"y": 20.0, "height": 5.0}),
            el("", "text", text="没有 id"),
            el("el_ok", "input", label="姓名", selector="body input", bbox={"y": 30.0, "height": 5.0}),
            el("el_tbl", "table", text="整表文本", bbox={"y": 40.0, "height": 5.0}),
            el("el_cell", "text", text="单元格", bbox={"y": 41.0, "height": 5.0}),
            "我是字符串", 42, None, [1, 2],
            el("el_c", "text", text="容器文字", bbox={"y": 50.0, "height": 5.0}),
            el("el_vis_off", "text", text="隐藏元素", visible=False, bbox={"y": 60.0, "height": 5.0}),
        ],
        "groups": [
            {"id": "form_abc123", "type": "form", "label": "", "element_ids": ["el_ok", "el_missing"]},
            {"id": "grp_tbl", "type": "table", "label": "表格", "element_ids": ["el_tbl", "el_cell"]},
            {"id": "grp_c", "type": "group", "label": "", "element_ids": ["el_c"]},
            {"id": "grp_empty", "type": "list", "label": "空组", "element_ids": []},
            {"id": "grp_dup", "type": "list", "label": "重复组", "element_ids": ["el_dup"]},
            "我不是组", 7, None,
            {"id": "grp_noids", "type": "nav", "label": "没有元素", "element_ids": []},
        ],
    }, "rules"))

    # 10. bbox 各种怪值
    cases.append(("bbox_odd", doc([
        el("el_bb1", "text", text="无 bbox"),                      # bbox 键不存在
        el("el_bb2", "text", text="null bbox", bbox=None),
        el("el_bb3", "text", text="空 bbox", bbox={}),
        el("el_bb4", "text", text="字符串 bbox", bbox={"y": "12.5", "height": "7.5"}),
        el("el_bb5", "text", text="坏 bbox", bbox={"y": "abc", "height": "7.5"}),
        el("el_bb6", "text", text="nan bbox", bbox={"y": "nan", "height": 1.0}),
        el("el_bb7", "text", text="bool bbox", bbox={"y": True, "height": True}),
        el("el_bb8", "text", text="list bbox", bbox=[1, 2]),
        el("el_bb9", "text", text="零 bbox", bbox={"y": 0, "height": 0}),
        el("el_bb10", "text", text="负 bbox", bbox={"y": -5.0, "height": -1.0}),
        el("el_bb11", "text", text="类型错 bbox", bbox={"y": [1], "height": 2.0}),
        el("el_bb12", "text", text="无穷", bbox={"y": "inf", "height": 1.0}),
        el("el_bb13", "text", text="负零", bbox={"y": -0.0, "height": 0.0}),
        el("el_bb14", "text", text="下划线数字", bbox={"y": "1_0.5", "height": "1e2"}),
        el("el_bb15", "text", text="空串", bbox={"y": "", "height": ""}),
    ]), "rules"))

    # 11. order 怪值（int(order or 0)：字符串抛 ValueError）
    cases.append(("order_odd", doc([
        el("el_o1", "text", text="order 字符串数字", order="3"),
        el("el_o2", "text", text="order 浮点", order=3.7),
        el("el_o3", "text", text="order true", order=True),
        el("el_o4", "text", text="order 空字符串", order=""),
        el("el_o5", "text", text="order null", order=None),
        el("el_o6", "text", text="order 负", order=-2),
        el("el_o7", "text", text="order 带空格", order="  7  "),
        el("el_o8", "text", text="order 下划线", order="1_0"),
    ]), {"greeting": "", "summary": "", "cards": []}))
    cases.append(("order_bad", doc([
        el("el_o1", "text", text="order 非法", order="abc"),
    ]), {"greeting": "", "summary": "", "cards": []}))
    cases.append(("order_bad2", doc([
        el("el_o1", "text", text="order 浮点串", order="1.5"),
    ]), {"greeting": "", "summary": "", "cards": []}))

    # 12. type 怪值（JS 对象原型陷阱 / 未知类型）
    cases.append(("type_odd", doc([
        el("el_ty1", "constructor", text="原型键"),
        el("el_ty2", "toString", text="toString"),
        el("el_ty3", "__proto__", text="proto"),
        el("el_ty4", "valueOf", text="valueOf"),
        el("el_ty5", "hasOwnProperty", text="hasOwnProperty"),
        el("el_ty6", "", text="空类型"),
        el("el_ty7", None, text="null 类型"),
        el("el_ty8", 5, text="数字类型"),
        el("el_ty9", "FORM", text="大写类型"),
        el("el_ty10", "form", text="小写类型"),
    ], [
        {"id": "grp_ty", "type": "constructor", "label": "", "element_ids": ["el_ty1"]},
        {"id": "grp_ty2", "type": "__proto__", "label": "原型组", "element_ids": ["el_ty2"]},
    ]), {"greeting": "", "summary": "", "cards": []}))

    # 13. 选项 / label-first / 去重
    cases.append(("options_dedupe", doc([
        el("el_op1", "select", label="科室", options=[
            {"label": "内科", "value": "1"}, {"label": "", "value": "外科"},
            {"value": "儿科"}, "眼科", "", None, 5, {"label": None, "value": None}]),
        el("el_op2", "radio", label="性别", options=[{"label": "男"}, {"label": "女"}]),
        el("el_op3", "checkbox", label="项目", options="不是列表"),
        el("el_op4", "text", text="内科"),
        el("el_op5", "text", text="内科/外科/儿科/眼科"),
        el("el_op6", "link", text="医疗服务价格公示", href="/price"),
        el("el_op7", "text", text="医疗服务价格公示"),
        el("el_op8", "text", text="医疗服务价格公示（含附件）"),
        el("el_op9", "link", text="短", href="/s"),
        el("el_op10", "text", text="短"),
        el("el_op11", "input", label="就诊人姓名", placeholder="请填写"),
        el("el_op12", "text", text="就诊人姓名"),
        el("el_op13", "input", label="", placeholder="字节数一样但长度不同", value=12345),
        el("el_op14", "checkbox", label="项目", options={"a": 1}),
    ]), "rules"))

    # 14. 站点名 / 标题的兜底
    cases.append(("site_fallback", {
        "page_url": "", "final_url": "snapshot://abc", "page_title": "", "source": None,
        "fallback_reason": "  网络超时  ",
        "stats": {"total": 0, "visible": 0},
        "elements": [el("el_z", "text", text="x")],
    }, "rules"))
    cases.append(("site_snapshot_pageurl", {
        "page_url": "https://demo.easyview.local/x", "final_url": "snapshot://abc",
        "page_title": "快照", "source": "fallback",
        "elements": [el("el_z", "link", text="同站链接", href="https://DEMO.easyview.local:443/y")],
        "groups": [],
    }, "rules"))
    cases.append(("site_scheme_only", {
        "page_url": "中文://主机/路径", "final_url": "about:blank", "page_title": "协议",
        "elements": [],
    }, "rules"))
    cases.append(("site_greek_host", {
        "page_url": "https://\u039f\u03a3.example/\u0130stanbul", "page_title": "希腊",
        "elements": [el("el_z", "link", text="链接", href="https://\u039f\u03a3.example/x")],
    }, "rules"))
    cases.append(("stats_odd", {
        "page_url": "https://a.com/", "page_title": 42, "source": 7, "fallback_reason": False,
        "stats": {"total": 0, "visible": 0, "truncated": "yes"},
        "elements": [el("el_z", "text", text="x")],
    }, "rules"))
    cases.append(("stats_missing", {
        "page_url": "https://a.com/", "page_title": "无 stats",
        "elements": [el("el_z", "text", text="x"), el("el_y", "text", text="y")],
    }, "rules"))

    # 15. scrubCopy 的正则细节：IGNORECASE 折叠字符、CJK 邻接的 \b、空括号
    cases.append(("scrub_regex", doc([
        el("el_r1", "link", text="入口", href="/a"),
    ]), {
        "greeting": "to\u212aen 与 s\u017felector 与 u\u0130_schema",
        "summary": "\u75c5\u5386com \u75c5\u5386.com a-com 1com _com com\u75c5\u5386",
        "cards": [
            {"title": "T0KEN", "element_id": "el_r1", "reason": "to\u212aen TOKEN token"},
            {"title": "DOM", "element_id": "el_r1",
             "reason": "s\u017felector xp\u0130th j\u017fon UI_SCHEMA"},
            {"title": "路径", "element_id": "el_r1",
             "reason": "/guahao?x=1 www.example.com \u00b2com \u75c5\u5386.com"},
            {"title": "括号", "element_id": "el_r1", "reason": "A（  ）B( )C（\u3000）D(  x  )E"},
            {"title": "边界", "element_id": "el_r1",
             "reason": "…——·、,，。;； 收尾 \u00a0\u2003"},
            {"title": "拼音域名", "element_id": "el_r1", "reason": "abc.aspx x.html y.php z.asp"},
            {"title": "反斜杠", "element_id": "el_r1", "reason": "C:\\Windows\\system32 /etc/passwd"},
            {"title": "协议", "element_id": "el_r1", "reason": "javascript:alert(1) tel:123 mailto:a@b.c"},
        ],
    }))

    # ---------------- binder 专属草稿 ----------------

    elements_for_draft = [
        el("el_l1", "link", text="在线预约挂号", href="https://demo.easyview.local/guahao",
           selector="#gh", xpath="/html/body/a[1]"),
        el("el_l2", "link", text="查看检验报告", href="https://demo.easyview.local/report",
           selector="#rp", xpath=None),
        el("el_l3", "link", text="拨打电话", href="tel://010-12345", selector="#tel"),
        el("el_l4", "link", text="拨打电话2", href="tel:010-12345", selector="#tel2"),
        el("el_l5", "button", text="提交预约", selector="#sub"),
        el("el_f1", "form", text="门诊预约登记", selector="#form", href=None),
        el("el_i1", "input", label="身份证号", selector="#idcard"),
        el("el_i2", "input", label="就诊人姓名", placeholder="请填写", selector="#name"),
        el("el_d1", "link", text="已禁用链接", href="/x", selector="#dis", disabled=True),
        el("el_n1", "link", text="无 selector", href="/y"),
        el("el_x1", "text", text="纯文字元素", selector="#t1"),
        el("el_ext1", "link", text="外部站点", href="https://other.example.com/z", selector="#ext"),
    ]

    base_doc = doc(elements_for_draft, [], source="extract",
                   final_url="https://demo.easyview.local/index",
                   page_url="https://demo.easyview.local/index")

    draft_features = {
        "greeting": "您好，这里是演示医院。",
        "summary": "您可以预约挂号。",
        "cards": [
            # 正常：标题与原文一致 → verbatim；带 also_cite
            {"title": "在线预约挂号", "subtitle": "预约门诊", "icon": "calendar",
             "element_id": "el_l1", "intent": "book", "reason": "来源里的预约入口。",
             "also_cite": ["el_l2", "el_x1", "el_x1", "el_nope", 12]},
            # 风险升级：normal → blocked
            {"title": "查看报告", "element_id": "el_l2", "intent": "query", "risk": "blocked"},
            # 风险降级：不允许（模型说 normal，但策略判 sensitive）
            {"title": "身份入口", "element_id": "el_i1", "intent": "apply", "risk": "normal"},
            # tel:// → external
            {"title": "拨打电话", "element_id": "el_l3", "intent": "contact"},
            # tel: → 无法定位，被丢弃
            {"title": "电话二", "element_id": "el_l4", "intent": "contact"},
            # form + blocked（标题含"缴费"）
            {"title": "缴费", "element_id": "el_f1", "intent": "pay"},
            # button → scroll，副标题被替换
            {"title": "提交预约", "element_id": "el_l5", "subtitle": "点这里", "intent": "book"},
            # 第 8 张起超上限
            {"title": "纯文字", "element_id": "el_x1", "intent": "learn"},
            {"title": "外部站点", "element_id": "el_ext1", "intent": "learn"},
            # 被丢弃的各种原因
            {"title": "", "element_id": "el_l1"},
            {"title": "标题实在太长了超过十二个字啦", "element_id": "el_l1"},
            {"title": "元素不存在", "element_id": "el_none"},
            {"title": "已禁用", "element_id": "el_d1"},
            {"title": "无定位", "element_id": "el_n1"},
            "字符串卡片", 42, None,
            {"title": "没有三环", "element_id": "", "intent": "learn"},
        ],
    }
    cases.append(("draft_features", base_doc, draft_features))

    # 副标题截断 / 证据字段 / fact / icon 归一 / 去 scrub
    draft_scrub = {
        "greeting": "请看 https://a.com/x  和 DOM 选择器(  ) 内容",
        "summary": "访问 www.example.com 或 /guahao?x=1 查看",
        "cards": [
            {"title": "预约 挂号", "subtitle": "副标题" * 20,
             "element_id": "el_l1", "intent": "book",
             "reason": "见 https://a.com/very/long/path?q=1 xpath token JSON ui_schema element_id target_selector 免责声明",
             "evidence_field": "label", "icon": "不存在的图标",
             "fact": {"element_id": "el_l2", "field": "text"}},
            {"title": "记录", "element_id": "el_l2", "intent": "query",
             "fact": {"element_id": "el_i2", "field": ""}},
            {"title": "姓名", "element_id": "el_i2", "intent": "apply",
             "fact": {"element_id": "el_missing"}},
            {"title": "事实无文字", "element_id": "el_n1", "intent": "learn"},
            {"title": "跨站", "element_id": "el_ext1", "intent": "learn", "icon": "info"},
            {"title": "比对大小写", "element_id": "el_l2", "icon": "INFO"},
            {"title": "副标题刚好48", "subtitle": "b" * 48, "element_id": "el_l1"},
            {"title": "副标题48个emoji", "subtitle": "😀" * 48, "element_id": "el_l1"},
            {"title": "副标题49个emoji", "subtitle": "😀" * 49, "element_id": "el_l1"},
            {"title": "12个emoji的标题", "element_id": "el_l1"},
        ],
    }
    cases.append(("draft_scrub", base_doc, draft_scrub))

    # 12 个 emoji 的标题（Python len=12 保留，JS 若按码元会误判超长）
    cases.append(("draft_emoji_title", base_doc, {
        "cards": [
            {"title": "😀😀😀😀😀😀", "element_id": "el_l1"},
            {"title": "😀😀😀😀😀😀😀", "element_id": "el_l2"},
            {"title": "𝕏𝕏𝕏𝕏", "element_id": "el_l3"},
        ],
    }))

    # 空草稿 / 草稿只有文字
    cases.append(("draft_empty", base_doc, {}))
    cases.append(("draft_text_only", base_doc, {"greeting": "", "summary": "", "cards": []}))
    cases.append(("draft_cards_not_list", base_doc,
                  {"greeting": "你好", "summary": "简介", "cards": "不是列表"}))
    cases.append(("draft_cards_missing", base_doc, {"greeting": "你好"}))
    cases.append(("draft_cards_dict", base_doc, {"greeting": "你好", "cards": {"a": 1}}))

    # 目标元素无法产生证据（无可引用文字）
    cases.append(("draft_no_evidence", base_doc, {
        "cards": [{"title": "无文字", "element_id": "el_empty_text"}],
    }))

    # 同标题 → 同一 slug → id 冲突后加后缀
    cases.append(("draft_dup_ids", base_doc, {
        "cards": [
            {"title": "同名卡片", "element_id": "el_l1"},
            {"title": "同名卡片", "element_id": "el_l2"},
            {"title": "!!!", "element_id": "el_l3"},
            {"title": "İstanbul", "element_id": "el_x1"},
            {"title": "ＡＢＣ", "element_id": "el_x1"},
        ],
    }))

    # user_goal / generator 传参 + 无页面标题（走 greeting 兜底）
    cases.append(("draft_user_goal", {
        "schema_version": "0.3.0-draft", "page_url": "https://a.com/x",
        "final_url": "https://a.com/x", "page_title": "", "source": "fallback",
        "stats": {"total": 1, "truncated": "yes"},
        "elements": [el("el_l1", "link", text="在线预约挂号", href="/guahao", selector="#gh")],
    }, {"cards": [{"title": "在线预约挂号", "element_id": "el_l1"}]}))

    # 空文本元素（无任何可引用文字）
    cases.append(("draft_no_evidence2", doc([
        el("el_empty_text", "text", text="   ", selector="#e"),
        el("el_noselector", "text", text="有文字没选择器"),
    ]), {"cards": [{"title": "无文字", "element_id": "el_empty_text"},
                   {"title": "无选择器", "element_id": "el_noselector"}]}))

    # href 不是字符串（Python 会在 .lower() 上抛 AttributeError）
    cases.append(("draft_href_number", doc([
        el("el_h1", "link", text="数字 href", href=5, selector="#h"),
    ]), {"cards": [{"title": "数字链接", "element_id": "el_h1"}]}))
    cases.append(("draft_href_number_sensitive", doc([
        el("el_h2", "link", text="报告查询", href=5, selector="#h2"),
    ]), {"cards": [{"title": "报告查询", "element_id": "el_h2"}]}))

    # 真正传入 user_goal / generator 的一例
    cases.append(("draft_user_goal2", base_doc,
                  {"cards": [{"title": "在线预约挂号", "element_id": "el_l1"}]},
                  {"user_goal": "  我想挂号  ",
                   "generator": {"mode": "model", "prompt_version": "senior-v0.3.1",
                                 "fallback_reason": "network_error"}}))

    # 统一成 4 元组
    normalized = []
    for item in cases:
        if len(item) == 3:
            normalized.append((item[0], item[1], item[2], {}))
        else:
            normalized.append(item)
    return normalized


# --------------------------------------------------------------------------
# 随机输入（fuzz）
# --------------------------------------------------------------------------

EL_TYPES = ["link", "button", "input", "textarea", "select", "radio", "checkbox", "form",
            "heading", "text", "table", "image", "nav", "div", "", None, "FORM",
            "constructor", "__proto__", "Link ", " link"]

TEXTS = [
    "", "  ", "\u00a0", "登录", "登 录", "中 文 字", "医疗服务价格公示", "就诊人姓名",
    "在线预约挂号", "查看检验报告", "缴费", "提交预约", "身份证号", "拨打电话",
    "版权", "© 2026", "ICP 备案", "友情链接", "网站地图", "无障碍", "手机版", "公安备案",
    "a" * 59, "a" * 60, "a" * 61, "😀" * 59, "😀" * 60, "😀" * 61, "𝕏" * 61, "中😀文",
    "\u00a0前后\u3000空白\u0085", "a\x1cb", "x\ufeffy", "\u2003", "\u3000",
    "点击 https://a.com/x 查看", "www.example.com", "/guahao?x=1", "见 http://x.com/p?a=1#f",
    "DOM 选择器 xpath token JSON ui_schema element_id target_selector",
    "免责声明：候选元素与技术字段", "（  ）", "( )", "【 】", "…", "——·、,，。;；",
    "to\u212aen", "s\u017felector", "u\u0130_schema", "\u0131stanbul", "ΟΣ", "Τοκεν",
    "\u2100x", "日本語", "한국어", "emoji 😀 mix 👍🏽", "com", "a.com", "1com", "_com",
    "病历com", "x" * 200, "\t\n\r\v\f", "0", "12345", "true", "None", "null",
]

HREFS = [
    None, "", "javascript:void(0)", "tel:123", "tel://host/1", "mailto:a@b.com", "#frag",
    "/guahao?x=1#f", "https://例子.中国/路径?q=1", "https://[::1]:8080/x", "https://[::1/x",
    "www.example.com/x", "HTTP://EXAMPLE.COM:8080/a", "//host/p", "  https://a.com/path  ",
    "https://u:p@Host.COM:443/x", "a/b", "https://host:99999/x", "https://host:abc/x",
    "snapshot://abc/def", "https://a.com:80", "https://a.com/x#y#z", "ht\ntp://a.com/x",
    "中文://host/p", "https://[fe80::1%25eth0]:80/x", "https://[192.168.1.1]/x",
    "https://[gggg::1]/x", "https://[v1a.b]/x", "https://[vzzz.b]/x", "?q=1", "a:b",
    "https://a.com/" + "p" * 100, "/" + "路" * 45, "https://\u039f\u03a3.example/x",
    "https://\u4f8b\u5b50.\u4e2d\u56fd/a", "HTTPS://A.COM/", "https://a.com/\u2100x",
    "https://a.com/\u00a0x", "//", "///x", ":", "://x", "http://", "5",
]


def gen_fuzz_case(rng, index):
    n = rng.choice([0, 1, 2, 3, 5, 8, 13, 21, 34, 60, 200])
    ids = [f"el_{i:03d}" for i in range(max(1, n))]
    if rng.random() < 0.15:
        ids = ids + ["el_000", "", "el_dup", "el_dup"]
    elements = []
    for i in range(n):
        eid = rng.choice(ids)
        etype = rng.choice(EL_TYPES)
        kwargs = {}
        fields = ["text", "label", "aria_label", "placeholder", "value"]
        for f in fields:
            if rng.random() < 0.65:
                kwargs[f] = rng.choice(TEXTS)
        if rng.random() < 0.75:
            kwargs["href"] = rng.choice(HREFS)
        if rng.random() < 0.15:
            kwargs.pop("href", None)
        if rng.random() < 0.85:
            kwargs["selector"] = rng.choice(["#a", "body div:nth", "  ", "", "constructor"])
        if rng.random() < 0.5:
            kwargs["xpath"] = rng.choice(["/html/body/a[1]", "", None, "  "])
        if rng.random() < 0.3:
            kwargs["visible"] = rng.choice([True, False, None, 0, 1, "true"])
        if rng.random() < 0.3:
            kwargs["disabled"] = rng.choice([True, False, None, 0, ""])
        if rng.random() < 0.3:
            kwargs["required"] = rng.choice([True, False, None, 1, "yes"])
        if rng.random() < 0.4:
            kwargs["bbox"] = rng.choice([
                None, {}, {"y": 0}, {"y": 10.5, "height": 20.25},
                {"y": "3", "height": "4.5"}, {"y": -0.0, "height": 1e-7},
                {"y": 1e21, "height": "inf"}, {"y": "nan", "height": "nan"},
                {"y": True, "height": None}, {"y": [1], "height": {}},
                [1, 2], "not-a-bbox", 5,
            ])
        if rng.random() < 0.4:
            kwargs["order"] = rng.choice([0, 1, -1, 3.7, True, "2", " 4 ", None, "", "x"])
        if rng.random() < 0.4:
            kwargs["options"] = rng.choice([
                None, [], ["男", "女"], [{"label": "内科"}, {"value": "外科"}],
                [{"label": "", "value": "空"}, None, 5, "眼科"],
                "不是列表", {"a": 1}, [{"label": "😀" * 40}],
                ["选项" * 40, "x" * 100],
            ])
        elements.append(el(eid, etype, **kwargs))

    groups = []
    for g in range(rng.choice([0, 0, 1, 2, 3, 5])):
        gtype = rng.choice(["form", "nav", "header", "footer", "table", "list", "group",
                            "constructor", "", None, "FORM"])
        pick = [rng.choice(ids) for _ in range(rng.randint(0, 8))]
        if rng.random() < 0.3:
            pick.append("el_missing")
        groups.append({
            "id": rng.choice([f"form_{index:06x}", f"grp_{g}", "no_underscore", "", None]),
            "type": gtype,
            "label": rng.choice(TEXTS + ["", "主导航", "登 录"]),
            "element_ids": pick if rng.random() < 0.9 else rng.choice(["", 5, None, "abc"]),
        })

    data = doc(elements, groups,
               page_url=rng.choice(HREFS + ["https://demo.easyview.local/x"]),
               final_url=rng.choice(HREFS + ["https://demo.easyview.local/x"]),
               page_title=rng.choice(TEXTS + ["测试页面"]),
               source=rng.choice(["extract", "fallback", "", None, 7]),
               stats=rng.choice([None, {}, {"total": len(elements)},
                                 {"total": 0, "visible": 0},
                                 {"total": "5", "visible": None, "truncated": "yes"},
                                 {"truncated": True}, {"visible": 0}]))
    if data["stats"] is None:
        data.pop("stats")

    card_count = rng.choice([0, 1, 2, 3, 5, 8, 12])
    cards = []
    for c in range(card_count):
        if rng.random() < 0.08:
            cards.append(rng.choice(["字符串", 42, None, [1], {"x": 1}]))
            continue
        card = {}
        if rng.random() < 0.9:
            card["title"] = rng.choice(TEXTS + ["在线预约挂号", "查看报告", "同名", ""])
        if rng.random() < 0.5:
            card["subtitle"] = rng.choice(TEXTS + ["预约门诊", ""])
        if rng.random() < 0.85:
            card["element_id"] = rng.choice(ids + ["el_missing", "", None])
        if rng.random() < 0.5:
            card["intent"] = rng.choice(["book", "query", "pay", "apply", "contact",
                                         "help", "learn", "", None, "PAY", " 查询 "])
        if rng.random() < 0.4:
            card["risk"] = rng.choice(["normal", "sensitive", "blocked", "", None, "NORMAL",
                                       "unknown", 5])
        if rng.random() < 0.4:
            card["icon"] = rng.choice(["home", "info", "payment", "warning", "?", "", None,
                                       "constructor", "INFO"])
        if rng.random() < 0.4:
            card["reason"] = rng.choice(TEXTS + ["规则引擎选的。", ""])
        if rng.random() < 0.3:
            card["evidence_field"] = rng.choice(["text", "label", "aria_label", "placeholder",
                                                 "", "nope", None])
        if rng.random() < 0.3:
            card["also_cite"] = rng.choice([
                [], [rng.choice(ids)], [rng.choice(ids), rng.choice(ids), "el_missing", 5],
                "abc", None, 5, {"a": 1}, [None, ""],
            ])
        if rng.random() < 0.25:
            card["fact"] = rng.choice([
                None, {}, {"element_id": rng.choice(ids)},
                {"element_id": rng.choice(ids), "field": "text"},
                {"element_id": "el_missing", "field": "label"},
                {"element_id": "", "field": ""},
            ])
        cards.append(card)

    draft = {"cards": cards}
    if rng.random() < 0.7:
        draft["greeting"] = rng.choice(TEXTS + ["您好。", ""])
    if rng.random() < 0.7:
        draft["summary"] = rng.choice(TEXTS + ["您可以……", ""])
    if rng.random() < 0.1:
        draft["cards"] = rng.choice(["不是列表", 5, None, {"a": 1}])

    extra = {}
    if rng.random() < 0.3:
        extra["user_goal"] = rng.choice(["我想挂号", "  ", "", None, "查询"])
    if rng.random() < 0.3:
        extra["generator"] = rng.choice([
            {"mode": "model", "prompt_version": "senior-v0.3.1"},
            {"mode": "", "prompt_version": None, "fallback_reason": "network_error"},
            {"mode": 5},
            {},
        ])
    return ("fuzz_%03d" % index, data, draft, extra)


# --------------------------------------------------------------------------
# 跑一侧
# --------------------------------------------------------------------------

def run_python(name, data, case_draft, extra=None, raw_bytes=None):
    extra = extra or {}
    if raw_bytes is None:
        raw_bytes = extra.get("sha_input", SHA256_ENCODED).encode("utf-8")
    result = {"digest": None, "digest_error": None, "schema": None,
              "schema_error": None, "dropped": None, "draft": None}
    try:
        result["digest"] = digest.build_digest(data)
    except Exception as exc:  # noqa: BLE001
        result["digest_error"] = "%s: %s" % (type(exc).__name__, exc)

    if case_draft is None:
        return result
    try:
        draft = pipeline.rules_draft(data) if case_draft == "rules" else case_draft
    except Exception as exc:  # noqa: BLE001
        result["schema_error"] = "draft %s: %s" % (type(exc).__name__, exc)
        return result
    result["draft"] = draft
    dropped: list[str] = []
    try:
        result["schema"] = binder.bind(
            draft, data, raw_bytes,
            generated_at=GENERATED_AT,
            generator=extra.get("generator", GENERATOR),
            user_goal=extra.get("user_goal"),
            dropped_report=dropped)
    except Exception as exc:  # noqa: BLE001
        result["schema_error"] = "%s: %s" % (type(exc).__name__, exc)
    result["dropped"] = dropped
    return result


JS_DIGEST = """
(payload) => {
  try {
    return { ok: true, value: globalThis.EasyViewDigest.build(payload.doc, payload.options) };
  } catch (e) {
    return { ok: false, error: (e && e.name ? e.name : "Error") + ": " + (e && e.message) };
  }
}
"""

JS_BIND = """
(payload) => {
  try {
    const dropped = [];
    const schema = globalThis.EasyViewBinder.bind(payload.draft, payload.doc, {
      generatedAt: payload.generatedAt,
      sha256: payload.sha256,
      generator: payload.generator,
      userGoal: payload.userGoal === undefined ? null : payload.userGoal,
      droppedReport: dropped,
    });
    return { ok: true, value: schema, dropped: dropped };
  } catch (e) {
    return { ok: false, error: (e && e.name ? e.name : "Error") + ": " + (e && e.message) };
  }
}
"""


def run_js(js_payloads, expression=None):
    from playwright.sync_api import sync_playwright

    out = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("about:blank")
        page.add_script_tag(path=str(EXT_SRC / "digest.js"))
        page.add_script_tag(path=str(EXT_SRC / "binder.js"))
        mounted = page.evaluate(
            "() => [typeof globalThis.EasyViewDigest, typeof globalThis.EasyViewBinder]")
        if mounted != ["object", "object"]:
            raise RuntimeError("脚本没有正确挂载: %r" % (mounted,))
        for name, payload in js_payloads.items():
            result = {"digest": None, "digest_error": None, "schema": None,
                      "schema_error": None, "dropped": None}
            res = page.evaluate(JS_DIGEST, {"doc": payload["doc"], "options": {}})
            if res["ok"]:
                result["digest"] = res["value"]
            else:
                result["digest_error"] = res["error"]
            if payload.get("draft") is not None:
                res = page.evaluate(JS_BIND, {
                    "doc": payload["doc"], "draft": payload["draft"],
                    "generatedAt": GENERATED_AT,
                    "sha256": payload["sha256"],
                    "generator": payload["generator"],
                    "userGoal": payload.get("user_goal"),
                })
                if res["ok"]:
                    result["schema"] = res["value"]
                    result["dropped"] = res["dropped"]
                else:
                    result["schema_error"] = res["error"]
            out[name] = result
        browser.close()
    return out


def err_kind(text):
    if not text:
        return None
    return text.split(":", 1)[0].strip()


def doc_has_nan(data):
    """这份 elements.json 里是否存在会解析成 NaN 的 bbox 分量。

    真实的 elements.json 不会出现（bbox 来自 getBoundingClientRect，
    JSON 也没有 NaN 字面量），只有手写 "nan"/"NaN" 字符串才会。
    """
    if not isinstance(data, dict):
        return False
    elements = data.get("elements")
    if not isinstance(elements, list):
        return False
    for element in elements:
        if not isinstance(element, dict):
            continue
        bbox = element.get("bbox")
        if not isinstance(bbox, dict):
            continue
        for key in ("y", "height"):
            value = bbox.get(key)
            if isinstance(value, str):
                try:
                    if math.isnan(float(value)):
                        return True
                except ValueError:
                    continue
    return False


def rows_multiset_equal(a, b):
    """两份说明书是不是同一批行、只是顺序不同。"""
    from collections import Counter
    return Counter(a.split("\n")) == Counter(b.split("\n"))


def rows_only(a, b):
    """两份说明书渲染出的"元素行"（以 [ 开头的行）完全一样。

    NaN 只影响排序，所以行内容不该变；分区标题可能因排序不同而变
    （标题是从第一个成员推出来的），所以这里只比元素行。
    """
    from collections import Counter

    def rows(text):
        return Counter(line for line in text.split("\n") if line.startswith("["))

    return rows(a) == rows(b)


def sanitize_nan(data):
    """把会解析成 NaN 的 bbox 分量换成 0.0，作为对照输入。"""
    out = json.loads(json.dumps(data, ensure_ascii=False))
    for element in out.get("elements") or []:
        if not isinstance(element, dict):
            continue
        bbox = element.get("bbox")
        if not isinstance(bbox, dict):
            continue
        for key in ("y", "height"):
            value = bbox.get(key)
            if isinstance(value, str):
                try:
                    if math.isnan(float(value)):
                        bbox[key] = 0.0
                except ValueError:
                    continue
    return out


JS_DIGEST_NOLIMIT = """
(payload) => {
  try {
    return { ok: true, value: globalThis.EasyViewDigest.build(payload.doc, { maxRows: 1000000000 }) };
  } catch (e) {
    return { ok: false, error: (e && e.name ? e.name : "Error") + ": " + (e && e.message) };
  }
}
"""


def nan_control(payloads):
    """NaN 用例的两个对照，返回 (names, results, bad)。

    对照 1（分类依据）：把 NaN 换成 0.0，两边必须逐字节一致。
    对照 2（不变式）：不设行数上限时，两边渲染出的元素行必须完全相同
                    （NaN 只影响排序，不该影响"有哪些行"）。
    results[name] = True 仅当两个对照都通过。
    """
    nan_names = [n for n, p in payloads.items() if doc_has_nan(p["doc"])]
    if not nan_names:
        return [], {}, 0
    results = {}
    bad = 0
    js_payloads = {}
    py_control = {}
    for name in nan_names:
        san = sanitize_nan(payloads[name]["doc"])
        try:
            py_control[name] = ("ok", digest.build_digest(san))
        except Exception as exc:  # noqa: BLE001
            py_control[name] = ("err", type(exc).__name__)
        js_payloads[name] = {"doc": san}
    js_control = run_js(js_payloads, expression=JS_DIGEST_NOLIMIT)

    # 对照 2：不设上限，行集合必须一致（Python 侧可能会抛错，那就只比错误类型）
    js_rows = run_js({n: {"doc": payloads[n]["doc"]} for n in nan_names},
                     expression=JS_DIGEST_NOLIMIT)
    py_rows = {}
    for name in nan_names:
        try:
            py_rows[name] = ("ok", digest.build_digest(payloads[name]["doc"], max_rows=10 ** 9))
        except Exception as exc:  # noqa: BLE001
            py_rows[name] = ("err", type(exc).__name__)

    for name in nan_names:
        kind, value = py_control[name]
        js_res = js_control[name]
        if kind == "ok":
            ok1 = value is not None and value == js_res["digest"]
            detail1 = "NaN→0.0 逐字节一致" if ok1 else "NaN→0.0 MISMATCH"
        else:
            got = err_kind(js_res["digest_error"])
            ok1 = got == value
            detail1 = ("NaN→0.0 同样报错(%s)" % value if ok1
                       else "NaN→0.0 MISMATCH py=%s js=%s" % (value, got))

        kind2, value2 = py_rows[name]
        js_row_res = js_rows[name]
        if kind2 == "ok":
            js_text = js_row_res["digest"]
            ok2 = js_text is not None and rows_only(value2, js_text)
            detail2 = "元素行集合一致" if ok2 else "元素行集合不一致"
        else:
            got2 = err_kind(js_row_res["digest_error"])
            ok2 = got2 == value2
            detail2 = "同样报错(%s)" % value2 if ok2 else "报错不一致 py=%s js=%s" % (value2, got2)

        results[name] = ok1 and ok2
        if not results[name]:
            bad += 1
        results[name + "\0detail"] = "%s；%s" % (detail1, detail2)
    return nan_names, results, bad


def run_nan_control(report, nan_names, results, bad):
    report.add("")
    report.add("=" * 78)
    report.add("NaN 用例的对照验证（把这些 bbox 的 NaN 换成 0.0，两边必须逐字节一致）")
    report.add("=" * 78)
    if not nan_names:
        report.add("  （本次没有含 NaN 的输入）")
        return 0
    for name in nan_names:
        report.add("  %-12s %s" % (name, results[name + "\0detail"]))
    report.add("  合计 %d 个 NaN 用例，对照不一致 %d 个" % (len(nan_names), bad))
    return bad


# --------------------------------------------------------------------------
# 比对
# --------------------------------------------------------------------------

class Report:
    def __init__(self):
        self.lines = []
        self.failures = 0
        self.digest_ok = 0
        self.digest_err = 0
        self.bind_ok = 0
        self.bind_err = 0
        self.nan_order = 0
        self.nan_control_ok = {}

    def add(self, line=""):
        self.lines.append(line)

    def compare(self, name, py, js, doc=None, write_files=False, verbose=True):
        if verbose:
            self.add("")
            self.add("### %s" % name)

        # --- digest ---
        if py["digest_error"] or js["digest_error"]:
            same = err_kind(py["digest_error"]) == err_kind(js["digest_error"])
            if same:
                self.digest_err += 1
            else:
                self.failures += 1
            if verbose:
                self.add("  digest : %s  python=%r js=%r"
                         % ("OK(同样报错)" if same else "MISMATCH",
                            py["digest_error"], js["digest_error"]))
        else:
            py_text = py["digest"]
            js_text = js["digest"]
            if write_files:
                (OUT_DIR / ("%s.py.digest.txt" % name)).write_text(py_text, encoding="utf-8")
                (OUT_DIR / ("%s.js.digest.txt" % name)).write_text(js_text, encoding="utf-8")
            if py_text.encode("utf-8") == js_text.encode("utf-8"):
                self.digest_ok += 1
                if verbose:
                    self.add("  digest : OK  逐字节一致（%d 字节）"
                             % len(py_text.encode("utf-8")))
            elif (doc is not None and doc_has_nan(doc)
                  and self.nan_control_ok.get(name, False)):
                # bbox 解析出 NaN：CPython 的落点由 timsort 细节 + 浮点对象身份
                # 决定（未定义行为），JS 侧固定用确定性稳定排序。
                # 判定依据是 run_nan_control：把 NaN 换成 0.0 后两边逐字节一致，
                # 说明这份输入的所有差异都只来自 NaN 参与排序。
                self.nan_order += 1
                if verbose:
                    self.add("  digest : NaN 顺序差异（已知；NaN 换成 0.0 后逐字节一致）" +
                             ("，行集合也一致" if rows_only(py_text, js_text) else ""))
            else:
                self.failures += 1
                if verbose:
                    self.add("  digest : MISMATCH  python=%d 字节 js=%d 字节"
                             % (len(py_text.encode("utf-8")), len(js_text.encode("utf-8"))))
                    self._first_diff("码点", py_text, js_text, 40)
                (OUT_DIR / ("%s.py.digest.txt" % name)).write_text(py_text, encoding="utf-8")
                (OUT_DIR / ("%s.js.digest.txt" % name)).write_text(js_text, encoding="utf-8")

        # --- binder ---
        if py["draft"] is None:
            if verbose:
                self.add("  binder : (跳过：该输入只测 digest)")
            return
        if py["schema_error"] or js["schema_error"]:
            same = err_kind(py["schema_error"]) == err_kind(js["schema_error"])
            if same:
                self.bind_err += 1
            else:
                self.failures += 1
            if verbose:
                self.add("  binder : %s  python=%r js=%r"
                         % ("OK(同样报错)" if same else "MISMATCH",
                            py["schema_error"], js["schema_error"]))
        else:
            py_sorted = json.dumps(py["schema"], ensure_ascii=False, sort_keys=True)
            js_sorted = json.dumps(js["schema"], ensure_ascii=False, sort_keys=True)
            py_ordered = json.dumps(py["schema"], ensure_ascii=False)
            js_ordered = json.dumps(js["schema"], ensure_ascii=False)
            if write_files:
                (OUT_DIR / ("%s.py.schema.json" % name)).write_text(
                    json.dumps(py["schema"], ensure_ascii=False, indent=2), encoding="utf-8")
                (OUT_DIR / ("%s.js.schema.json" % name)).write_text(
                    json.dumps(js["schema"], ensure_ascii=False, indent=2), encoding="utf-8")
            if py_sorted == js_sorted:
                self.bind_ok += 1
                if verbose:
                    note = "  binder : OK  sort_keys 序列化一致（%d 字节）" % len(py_sorted.encode("utf-8"))
                    if py_ordered != js_ordered:
                        self.failures += 1
                        note += "；但键序不同！"
                    self.add(note)
            else:
                self.failures += 1
                if verbose:
                    self.add("  binder : MISMATCH")
                    self._first_diff("字符", py_sorted, js_sorted, 60)

            if py["dropped"] != js["dropped"]:
                self.failures += 1
                if verbose:
                    self.add("  dropped: MISMATCH")
                    self.add("           python: %r" % (py["dropped"],))
                    self.add("           js    : %r" % (js["dropped"],))
            elif verbose:
                self.add("  dropped: OK  两边 %d 条" % len(py["dropped"] or []))

    def _first_diff(self, unit, a, b, window):
        limit = min(len(a), len(b))
        at = next((i for i in range(limit) if a[i] != b[i]), limit)
        self.add("           首个差异在%s %d" % (unit, at))
        self.add("           python: %r" % a[max(0, at - window):at + window])
        self.add("           js    : %r" % b[max(0, at - window):at + window])


# --------------------------------------------------------------------------
# 已知的"Python 与 JS 天生不同"
# --------------------------------------------------------------------------

KNOWN_DIVERGENCE_CASES = [
    # (说明, doc, draft)
    ("int/float 不分：JSON 的 3.0 在 JS 里就是 3",
     doc([el("el_v1", "text", value=3.0, text="值")]),
     {"cards": [{"title": "值", "element_id": "el_v1"}]}),
    ("大整数：>2^53 的 stats.total 会被 JS 的 double 吃掉",
     doc([el("el_v1", "text", text="x")], stats={"total": 9007199254740993, "visible": 1}),
     None),
    ("非 ASCII 十进制数字：int('٣') 合法，JS 抛错",
     doc([el("el_v1", "text", text="阿拉伯数字 order", order="\u0663")]),
     {"cards": []}),
]


def run_known_divergences(report):
    report.add("")
    report.add("=" * 78)
    report.add("已知的 Python / JS 天生差异（下列内容是故意不一致的，逐条验证）")
    report.add("=" * 78)
    payloads = {}
    py_results = {}
    for i, (label, data, draft) in enumerate(KNOWN_DIVERGENCE_CASES):
        name = "divergence_%d" % i
        raw = SHA256_ENCODED.encode("utf-8")
        payloads[name] = {"doc": data, "raw_bytes": raw, "extra": {}}
        py_results[name] = run_python(name, data, draft, {}, raw)
    js_payloads = {}
    for name, payload in payloads.items():
        py = py_results[name]
        js_payloads[name] = {
            "doc": payload["doc"],
            "draft": py["draft"],
            "sha256": hashlib.sha256(payload["raw_bytes"]).hexdigest(),
            "generator": GENERATOR,
            "user_goal": None,
        }
    js_results = run_js(js_payloads)
    for i, (label, data, draft) in enumerate(KNOWN_DIVERGENCE_CASES):
        name = "divergence_%d" % i
        py = py_results[name]
        js = js_results[name]
        report.add("")
        report.add("### %s" % label)
        if py["digest_error"] or js["digest_error"]:
            report.add("  digest  python=%r" % py["digest_error"])
            report.add("  digest  js    =%r" % js["digest_error"])
        else:
            if py["digest"] == js["digest"]:
                report.add("  digest  两边一致（此例没有暴露差异）")
            else:
                report.add("  digest  不一致（正是上面说的原因）")
                limit = min(len(py["digest"]), len(js["digest"]))
                at = next((k for k in range(limit) if py["digest"][k] != js["digest"][k]), limit)
                report.add("          python: %r" % py["digest"][max(0, at - 30):at + 30])
                report.add("          js    : %r" % js["digest"][max(0, at - 30):at + 30])
        if py["draft"] is not None:
            if py["schema_error"] or js["schema_error"]:
                report.add("  binder  python=%r js=%r" % (py["schema_error"], js["schema_error"]))
            else:
                same = (json.dumps(py["schema"], ensure_ascii=False, sort_keys=True) ==
                        json.dumps(js["schema"], ensure_ascii=False, sort_keys=True))
                report.add("  binder  %s" % ("一致（此例没有暴露差异）" if same else "不一致（正是上面说的原因）"))


def run_nan_order_note(report):
    """单独把 NaN 排序这件事讲清楚，并验证"只有顺序不同"。"""
    report.add("")
    report.add("=" * 78)
    report.add("NaN 排序：为什么这里不追求逐字节一致")
    report.add("=" * 78)
    report.add("""  elements.json 里的 bbox 来自 getBoundingClientRect，JSON 也没有 NaN
  字面量，所以真实输入不可能出现 NaN。只有当人手工写 {"y": "nan"} 时，
  Python 的 float('nan') 才会参与排序键。此时：
    · CPython 的 list.sort 在 (y, order) 这种元组比较下不是全序
      （NaN 与任何值既不 < 也不 ==）；
    · 落点由 timsort 的二元插入/归并细节，以及浮点对象在元组比较里的
      身份短路（`v is w` 命中会让等于判定成立）共同决定 —— 同一批数据
      换个顺序构造，Python 自己给出的顺序都会不同，属于未定义行为。
  处理方式：JS 侧固定用"确定性稳定归并 + Python 的元组比较语义"。
  全序 key（真实输入）下与 Python 完全一致；含 NaN 时保证元素集合一致、
  顺序确定。上面的随机输入里出现的 NaN 用例按这个口径单独计数。""")


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def sha256_of(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def file_fingerprints():
    files = [AI_DIR / "digest.py", AI_DIR / "binder.py",
             EXT_SRC / "digest.js", EXT_SRC / "binder.js"]
    return {p.name: sha256_of(p) for p in files}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--fuzz", type=int, default=150, help="随机输入组数")
    parser.add_argument("--seed", type=int, default=20261002)
    args = parser.parse_args(argv)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    report = Report()
    fp_before = file_fingerprints()

    payloads = {}
    py_results = {}

    # ---------------- 1. 三份 fixture ----------------
    for fixture in FIXTURES:
        path = EXAMPLES / fixture
        raw = path.read_bytes()
        data = json.loads(raw.decode("utf-8-sig"))
        name = fixture.replace("elements.", "").replace(".json", "")
        payloads[name] = {"doc": data, "raw_bytes": raw, "extra": {}, "write": True}
        py_results[name] = run_python(name, data, "rules", {}, raw)

    # ---------------- 2. 具名边界输入 ----------------
    for name, data, case_draft, extra in boundary_cases():
        raw = extra.get("sha_input", SHA256_ENCODED).encode("utf-8")
        payloads[name] = {"doc": data, "raw_bytes": raw, "extra": extra, "write": True}
        py_results[name] = run_python(name, data, case_draft, extra, raw)

    # ---------------- 3. 随机输入 ----------------
    rng = random.Random(args.seed)
    for i in range(max(0, args.fuzz)):
        name, data, case_draft, extra = gen_fuzz_case(rng, i)
        raw = SHA256_ENCODED.encode("utf-8")
        payloads[name] = {"doc": data, "raw_bytes": raw, "extra": extra, "write": False}
        py_results[name] = run_python(name, data, case_draft, extra, raw)

    # JS 侧：把 Python 算好的草稿原样送进浏览器（JS 不实现 rules_draft）
    js_payloads = {}
    for name, payload in payloads.items():
        py = py_results[name]
        entry = {"doc": payload["doc"]}
        if py["draft"] is not None:
            entry["draft"] = py["draft"]
        extra = payload["extra"]
        entry["sha256"] = hashlib.sha256(payload["raw_bytes"]).hexdigest()
        entry["generator"] = extra.get("generator", GENERATOR)
        entry["user_goal"] = extra.get("user_goal")
        js_payloads[name] = entry

    js_results = run_js(js_payloads)

    # 先把 NaN 对照跑掉：它的结果决定 NaN 差异的分类口径
    nan_names, nan_results, nan_bad = nan_control(payloads)
    report.nan_control_ok = nan_results

    report.add("=" * 78)
    report.add("digest.js / binder.js 与 Python 基准的差分结果")
    report.add("=" * 78)
    report.add("用例：%d 个 fixture/具名用例 + %d 组随机输入"
               % (len(FIXTURES) + len(boundary_cases()), args.fuzz))

    named = list(payloads)[: len(FIXTURES) + len(boundary_cases())]
    for name in named:
        report.compare(name, py_results[name], js_results[name], payloads[name]["doc"],
                       write_files=payloads[name]["write"], verbose=True)
        if report.failures:
            (OUT_DIR / ("%s.doc.json" % name)).write_text(
                json.dumps(payloads[name]["doc"], ensure_ascii=False, indent=1), encoding="utf-8")

    if args.fuzz:
        report.add("")
        report.add("-" * 78)
        report.add("随机输入（%d 组，seed=%d）：只统计，逐条明细见下方失败项"
                   % (args.fuzz, args.seed))
        report.add("-" * 78)
        for name in list(payloads)[len(named):]:
            before_lines = len(report.lines)
            before_fail = report.failures
            before_nan = report.nan_order
            report.compare(name, py_results[name], js_results[name], payloads[name]["doc"],
                           verbose=True)
            if report.failures == before_fail and report.nan_order == before_nan:
                # 一切正常：丢掉这次产生的明细，只保留失败/可疑项
                del report.lines[before_lines:]

    run_known_divergences(report)
    report.failures += run_nan_control(report, nan_names, nan_results, nan_bad)
    run_nan_order_note(report)

    report.add("")
    report.add("=" * 78)
    report.add("统计")
    report.add("  digest 逐字节一致 / 两边同样报错 : %d / %d" % (report.digest_ok, report.digest_err))
    report.add("  digest 仅顺序不同（bbox 为 NaN，见下文说明）: %d" % report.nan_order)
    report.add("  binder 序列化一致 / 两边同样报错 : %d / %d" % (report.bind_ok, report.bind_err))
    report.add("  不一致项 : %d" % report.failures)
    report.add("=" * 78)
    report.add("")
    report.add("基准版本（本次运行开始时）：")
    for name, digest_hex in fp_before.items():
        report.add("  %-12s %s" % (name, digest_hex))
    fp_after = file_fingerprints()
    if fp_after != fp_before:
        report.add("  !! 基准/产物文件在本次运行期间被改动过，本次结果不可靠，请重跑：")
        for name in fp_before:
            if fp_before[name] != fp_after[name]:
                report.add("     %s: %s -> %s" % (name, fp_before[name][:16], fp_after[name][:16]))
    else:
        report.add("  （运行期间四个文件都没有变化）")

    text = "\n".join(report.lines)
    (OUT_DIR / "report.txt").write_text(text, encoding="utf-8")
    print(text)
    return 1 if report.failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        sys.exit(2)
