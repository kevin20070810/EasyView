# -*- coding: utf-8 -*-
"""起一个能加载未打包扩展的 Chrome —— 端到端脚本共用的启动器。

为什么不用 playwright 自带的 chromium
------------------------------------
1. 本机没有装 playwright 的浏览器（`playwright install` 没跑过），
   但装了 Chrome，所以走 channel="chrome" / 直接起 chrome.exe。
2. Chrome 137 起 `--load-extension` 命令行开关被关掉了，
   即使加上 `--disable-features=DisableLoadExtensionCommandLineSwitch`
   也不生效（实测 Chrome 154）。现在唯一稳的路子是：
       开着 --enable-unsafe-extension-debugging 启动 Chrome
       → connect_over_cdp
       → CDP 命令 Extensions.loadUnpacked
   这也是 Chrome 官方给自动化的替代方案。

用 Playwright 的 launch_persistent_context 传 --load-extension 在这版本上
会静默失败（扩展不加载、service_workers 为空），排查起来很费时间，所以单独抽出来。
"""

from __future__ import annotations

import asyncio
import pathlib
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def fix_console_encoding() -> None:
    """Windows 控制台默认 GBK，卡片标签里有 emoji，直接 print 会 UnicodeEncodeError。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass


def find_chrome() -> str | None:
    for path in CHROME_CANDIDATES:
        if pathlib.Path(path).exists():
            return path
    return None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def launch_chrome(profile_dir: pathlib.Path, window_size: str = "1440,960", headless: bool = False):
    """返回 (进程, 调试端口)；找不到 Chrome 时返回 None。"""
    exe = find_chrome()
    if not exe:
        return None
    shutil.rmtree(profile_dir, ignore_errors=True)
    profile_dir.mkdir(parents=True, exist_ok=True)
    port = _free_port()
    args = [
        exe,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile_dir}",
        "--enable-unsafe-extension-debugging",
        "--no-first-run",
        "--no-default-browser-check",
        f"--window-size={window_size}",
    ]
    if headless:
        args.append("--headless=new")
    args.append("about:blank")
    proc = subprocess.Popen(args)
    return proc, port


async def wait_for_cdp(port: int, timeout_s: float = 30.0) -> None:
    deadline = time.time() + timeout_s
    url = f"http://127.0.0.1:{port}/json/version"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:  # noqa: BLE001
            await asyncio.sleep(0.4)
    raise RuntimeError(f"Chrome 调试端口 {port} 一直没起来")


async def load_unpacked(browser, extension_dir: pathlib.Path) -> str | None:
    """CDP 加载未打包扩展，返回扩展 id。"""
    session = await browser.new_browser_cdp_session()
    result = await session.send("Extensions.loadUnpacked", {"path": str(extension_dir)})
    return (result or {}).get("id")


async def wait_for_worker(context, extension_id: str | None = None, timeout_s: float = 20.0):
    """等**我们自己那个**扩展的 service worker 起来。

    Chrome 里本来就有别的内置扩展（比如 fignfif…），它们的 worker 也会出现在
    context.service_workers 里；按扩展 id 过滤，否则会拿到别人的 worker，
    一调用 chrome.scripting 就是 undefined。
    CDP 连接下 service_workers 还可能是 None，统一用 `or []` 兜住。
    """
    prefix = f"chrome-extension://{extension_id}/" if extension_id else None
    for _ in range(int(timeout_s / 0.25)):
        workers = context.service_workers or []
        if prefix:
            for worker in workers:
                if worker.url.startswith(prefix):
                    return worker
        elif workers:
            return workers[0]
        await asyncio.sleep(0.25)
    return None


def stop_chrome(proc) -> None:
    if proc is None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
