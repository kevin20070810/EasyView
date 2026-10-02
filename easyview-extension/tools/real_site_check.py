# -*- coding: utf-8 -*-
"""真实网站端到端检查：加载扩展 → 打开真实网页 → 走完整链路。

与 test_extract_privacy.py / e2e_check.py 的区别：那几个跑的是本地 fixture，
结构干净、为规则引擎手工设计过。这里跑的是**真实网站**，会暴露 fixture 上
永远看不到的问题：元素触顶、SPA 异步渲染、几百个导航链接、广告混杂。

链路（与用户点扩展图标完全一致）：
    注入 privacy/digest/binder/extract/ai-content
      -> 页面内提取
      -> 本地生成说明书并脱敏
      -> 同意（首次）
      -> 分析服务 /draft 只回任务草稿
      -> 本地绑定（selector/xpath/href 都不出浏览器）
      -> 校验 0.3 + 统计

用法：
    python tools/real_site_check.py                    # 默认站点列表
    python tools/real_site_check.py --url https://...
    python tools/real_site_check.py --sites 12306,gov
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import pathlib
import shutil
import sys
import time

from playwright.async_api import async_playwright

HERE = pathlib.Path(__file__).resolve().parent
EXTENSION_DIR = HERE.parent
REPO = EXTENSION_DIR.parent
PROFILE_DIR = pathlib.Path.home() / "AppData" / "Local" / "Temp" / "easyview-real-profile"
TEST_EXTENSION_DIR = pathlib.Path.home() / "AppData" / "Local" / "Temp" / "easyview-real-ext"
VALIDATOR_PATH = REPO / "docs" / "drafts" / "ui-schema-0.3" / "validate.py"


def build_test_extension() -> pathlib.Path:
    """做一份 host_permissions 放宽到 <all_urls> 的测试副本。

    为什么需要这个
    --------------
    正式 manifest 里 host_permissions 只有 localhost（那是给分析服务用的），
    真实网页的注入靠 activeTab —— 而 activeTab **只在用户主动触发时**
    （点图标 / 快捷键 / 右键菜单）才临时授予，自动化没法伪造。

    本地 fixture 之所以一直能过，是因为 127.0.0.1 恰好在 host_permissions 里，
    那条路径**掩盖了真实网站的权限问题**。

    所以：用放宽权限的副本验证"真实网站上的整条处理链路"，
    至于"点图标能否授予 activeTab"这件事，README 里写了人工验证步骤 ——
    那是 Chrome 的标准行为，但必须由人亲点一次确认。
    """
    import json as _json

    shutil.rmtree(TEST_EXTENSION_DIR, ignore_errors=True)
    shutil.copytree(EXTENSION_DIR, TEST_EXTENSION_DIR,
                    ignore=shutil.ignore_patterns("tools", "__pycache__"))
    manifest_path = TEST_EXTENSION_DIR / "manifest.json"
    manifest = _json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["host_permissions"] = ["<all_urls>"]
    manifest_path.write_text(_json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return TEST_EXTENSION_DIR

SITES = {
    "gov": ("中国政府网", "https://www.gov.cn/"),
    "12306": ("中国铁路12306", "https://www.12306.cn/"),
    "bjbus": ("北京公交", "https://www.bjbus.com/"),
    "pumch": ("北京协和医院", "https://www.pumch.cn/"),
    "rjh": ("上海瑞金医院", "https://www.rjh.com.cn/"),
}

# 从内容脚本所在的隔离世界读结果。page.evaluate 在主页世界读不到内容脚本的全局变量。
CAPTURE = """async () => {
    const t = await chrome.tabs.query({ active: true, currentWindow: true });
    const r = await chrome.scripting.executeScript({
        target: { tabId: t[0].id },
        func: () => globalThis.__easyviewLastRun || null
    });
    return r && r[0] ? r[0].result : null;
}"""

OVERLAY_STATE = """() => {
  const h = document.getElementById('easyview-ai-root');
  const s = h && h.shadowRoot;
  if (!s) return { present: false };
  const text = (sel) => { const n = s.querySelector(sel); return n ? n.textContent.trim() : null; };
  return {
    present: true,
    error: text('.ev-error'),
    consent: !!s.querySelector('.ev-ai-consent'),
    cards: s.querySelectorAll('.ev-card').length,
    banner: text('.ev-ai-banner'),
  };
}"""

CLICK = """(label) => {
  const h = document.getElementById('easyview-ai-root'); const s = h && h.shadowRoot;
  if (!s) return false;
  const b = [...s.querySelectorAll('button')].find(x => x.textContent.trim() === label);
  if (b) { b.click(); return true; }
  return false;
}"""


def load_validator():
    spec = importlib.util.spec_from_file_location("draft_validator", VALIDATOR_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def wait_for_worker(context, timeout_s: float = 15.0):
    for _ in range(int(timeout_s / 0.2)):
        if context.service_workers:
            return context.service_workers[0]
        await asyncio.sleep(0.2)
    return None


async def check_site(page, worker, validator, label, url, timeout_s: float) -> dict:
    result = {"label": label, "url": url, "ok": False, "stage": "打开页面", "notes": []}

    started = time.monotonic()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=45000)
    except Exception as exc:
        result["notes"].append(f"打不开: {str(exc)[:100]}")
        return result
    # 给异步渲染留时间；真实站点首屏常是 JS 拼出来的
    await page.wait_for_timeout(4000)

    files = await worker.evaluate("() => globalThis.__easyviewContentFiles")
    result["stage"] = "注入"
    try:
        injected = await worker.evaluate(
            """async (files) => {
                const t = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!t.length) return '没有活动标签页';
                await chrome.scripting.executeScript({ target: { tabId: t[0].id }, files });
                return null;
            }""",
            files,
        )
        if injected:
            result["notes"].append(injected)
            return result
    except Exception as exc:
        result["notes"].append(f"注入失败: {str(exc)[:160]}")
        return result

    # 首次会弹同意；同意状态存在 profile 里，后续站点不再问
    for _ in range(20):
        await asyncio.sleep(0.5)
        state = await page.evaluate(OVERLAY_STATE)
        if state.get("consent"):
            await page.evaluate(CLICK, "同意并继续")
            break
        if state.get("cards") or state.get("error"):
            break

    result["stage"] = "分析"
    deadline = started + timeout_s
    while time.monotonic() < deadline:
        await asyncio.sleep(1.0)
        captured = await worker.evaluate(CAPTURE)
        if captured and captured.get("ui"):
            state = await page.evaluate(OVERLAY_STATE)
            if state.get("cards") or state.get("error"):
                break
    else:
        result["notes"].append(f"超过 {int(timeout_s)} 秒仍无结果")
        return result

    if not captured or not captured.get("ui"):
        state = await page.evaluate(OVERLAY_STATE)
        result["notes"].append(state.get("error") or "没有拿到输出")
        return result

    ui = captured["ui"]
    elements = captured["elements"]
    payload = captured.get("payload") or ""

    result.update(
        ok=True,
        stage="完成",
        elapsed=round(time.monotonic() - started, 1),
        elements=elements.get("stats", {}),
        payload_chars=len(payload),
        cards=len(ui.get("cards") or []),
        state=ui.get("state"),
        dropped=len(captured.get("dropped") or []),
        meta=captured.get("meta") or {},
    )

    # 用扩展自己哈希的那个序列化去校验，否则 sha256 对不上
    raw = (captured.get("elementsJson") or "").encode("utf-8")
    result["validation_errors"] = validator.validate(ui, elements, raw) if raw else ["没有 elementsJson"]

    result["card_list"] = [
        {
            "title": c.get("title"),
            "subtitle": c.get("subtitle"),
            "risk": (c.get("risk") or {}).get("level"),
            "kind": (c.get("action") or {}).get("kind"),
            "note": "有确认" if (c.get("action") or {}).get("confirmation") else None,
        }
        for c in ui.get("cards") or []
    ]
    return result


def report(result: dict) -> None:
    print(f"{'=' * 66}")
    print(f"【{result['label']}】{result['url']}")
    if not result["ok"]:
        print(f"  ❌ 停在「{result['stage']}」")
        for note in result["notes"]:
            print(f"     {note}")
        print()
        return

    stats = result["elements"]
    trunc = "（触顶截断）" if stats.get("truncated") else ""
    print(f"  提取:  {stats.get('total')} 个元素，可见 {stats.get('visible')}{trunc}")
    print(f"  载荷:  说明书 {result['payload_chars']} 字符"
          f"（原来要发 {len(json.dumps({'x': 0})) and ''}整页结构）")
    meta = result.get("meta") or {}
    usage = meta.get("usage") or {}
    print(f"  模型:  延迟 {meta.get('latency_ms', '?')}ms  "
          f"输出 {usage.get('completion_tokens', '?')} token"
          f"（推理 {(usage.get('completion_tokens_details') or {}).get('reasoning_tokens', '?')}）")
    print(f"  耗时:  {result['elapsed']}s（含页面加载）")
    print(f"  绑定:  丢弃 {result['dropped']} 张  "
          f"0.3 校验 {'通过' if not result['validation_errors'] else str(len(result['validation_errors'])) + ' 项错误'}")
    for err in result["validation_errors"][:4]:
        print(f"         {err}")
    if result.get("banner"):
        print(f"  横幅:  {result['banner']}")
    print(f"  卡片 {result['cards']} 张:")
    for card in result["card_list"]:
        risk = card["risk"] or "?"
        note = f"  ({card['note']})" if card["note"] else ""
        print(f"    [{risk:<9}] {card['title']}｜{card['subtitle'] or ''}{note}")
    print()


async def main() -> int:
    parser = argparse.ArgumentParser(description="真实网站端到端检查")
    parser.add_argument("--url", action="append", default=[], help="直接指定网址，可重复")
    parser.add_argument("--sites", help="从默认列表里选，逗号分隔：" + ",".join(SITES))
    parser.add_argument("--timeout", type=float, default=180.0, help="每个站点的分析超时")
    args = parser.parse_args()

    targets: list[tuple[str, str]] = []
    if args.sites:
        for key in args.sites.split(","):
            key = key.strip()
            if key in SITES:
                targets.append(SITES[key])
            else:
                print(f"未知站点: {key}", file=sys.stderr)
    targets += [(u, u) for u in args.url]
    if not targets:
        targets = [SITES[k] for k in ("gov", "12306", "bjbus", "pumch")]

    validator = load_validator()
    shutil.rmtree(PROFILE_DIR, ignore_errors=True)
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    load_dir = build_test_extension()
    print(f"用测试副本加载扩展（host_permissions 放宽到 <all_urls>）：{load_dir}")
    print("  正式 manifest 用 activeTab，真实网站的注入必须由用户点击图标触发；")
    print("  自动化无法伪造该授权，所以这里放宽权限，只验证处理链路本身。\n")

    results: list[dict] = []
    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            # 无头模式下 Chrome 不启动扩展的 service worker，必须开窗口
            headless=False,
            args=[
                f"--disable-extensions-except={load_dir}",
                f"--load-extension={load_dir}",
            ],
        )
        try:
            worker = await wait_for_worker(context)
            if worker is None:
                print("扩展没加载成功，拿不到 service worker")
                return 1
            page = await context.new_page()
            for label, url in targets:
                print(f"→ 正在检查 {label} …", flush=True)
                try:
                    outcome = await check_site(page, worker, validator, label, url, args.timeout)
                except Exception as exc:  # noqa: BLE001
                    # 真实网站什么都可能发生（弹窗、跳转、页面被替换、证书问题）。
                    # 一个站点炸掉不能拖垮整轮，如实记下继续下一个。
                    outcome = {
                        "label": label, "url": url, "ok": False, "stage": "异常",
                        "notes": [f"{type(exc).__name__}: {str(exc)[:220]}"],
                    }
                    # 页面可能已经被弹窗/跳转弄坏，换一个干净的
                    try:
                        await page.close()
                    except Exception:  # noqa: BLE001
                        pass
                    page = await context.new_page()
                results.append(outcome)
                report(outcome)
        finally:
            await context.close()

    ok = [r for r in results if r["ok"]]
    print("=" * 66)
    print(f"总结: {len(ok)}/{len(results)} 个站点跑通")
    if ok:
        truncated = [r["label"] for r in ok if (r["elements"] or {}).get("truncated")]
        bad = [r["label"] for r in ok if r["validation_errors"]]
        print(f"  触顶截断: {truncated or '无'}")
        print(f"  0.3 校验失败: {bad or '无'}")
        print(f"  平均载荷: {round(sum(r['payload_chars'] for r in ok) / len(ok))} 字符")
        print(f"  平均卡片: {round(sum(r['cards'] for r in ok) / len(ok), 1)} 张")
    return 0 if len(ok) == len(results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
