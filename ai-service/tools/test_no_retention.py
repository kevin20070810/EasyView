# -*- coding: utf-8 -*-
"""证明分析服务不留存页面内容。

做法：往请求体里塞一个独一无二的"秘密"，然后检查它有没有出现在
服务端日志、错误响应、或工作目录的新文件里。

用法： python tools/test_no_retention.py
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

SERVICE = pathlib.Path(__file__).resolve().parents[1]
REPO = SERVICE.parent
EXAMPLES = REPO / "docs" / "examples"
PORT = 8791
SECRET = "SECRET-110101199001011234-CANARY-9f3a"

failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"  [PASS] {label}")
    else:
        failures.append(label)
        print(f"  [FAIL] {label}{('  ' + detail) if detail else ''}")


def load_payload() -> bytes:
    data = json.loads((EXAMPLES / "elements.hospital.json").read_text(encoding="utf-8-sig"))
    # 把"秘密"塞进页面文字里 —— 模拟页面上显示的身份证号
    data["elements"][0]["text"] = f"就诊人 {SECRET}"
    return json.dumps(data, ensure_ascii=False).encode("utf-8")


def snapshot(directory: pathlib.Path) -> set[str]:
    return {str(p.relative_to(directory)) for p in directory.rglob("*") if p.is_file()}


def main() -> int:
    payload = load_payload()
    check("测试载荷里确实含有秘密", SECRET.encode() in payload)

    before = snapshot(SERVICE)
    log_path = SERVICE / "_test_stderr.log"

    print()
    print("=== 启动一个全新的服务实例，stderr 单独收走 ===")
    with log_path.open("wb") as log:
        process = subprocess.Popen(
            [sys.executable, "-X", "utf8", "-B", "app.py", "--host", "127.0.0.1", "--port", str(PORT)],
            cwd=str(SERVICE), stdout=subprocess.DEVNULL, stderr=log,
        )
        try:
            time.sleep(2.5)
            print("  服务已启动")

            print()
            print("=== 1. 正常请求：不回显、不缓存 ===")
            request = urllib.request.Request(
                f"http://127.0.0.1:{PORT}/analyze?debug=1",
                data=payload, method="POST",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=60) as response:
                body = response.read()
                headers = {k.lower(): v for k, v in response.headers.items()}
            check("响应里不含秘密", SECRET.encode() not in body)
            check("Cache-Control: no-store", headers.get("cache-control") == "no-store",
                  str(headers.get("cache-control")))
            check("声明了不留存", headers.get("x-easyview-retention") == "none",
                  str(headers.get("x-easyview-retention")))

            print()
            print("=== 2. 畸形请求：错误信息里也不回显输入 ===")
            bad = urllib.request.Request(
                f"http://127.0.0.1:{PORT}/analyze",
                data=('{"broken": "' + SECRET + '"').encode("utf-8"), method="POST",
                headers={"Content-Type": "application/json"},
            )
            try:
                urllib.request.urlopen(bad, timeout=30)
                check("畸形请求被拒", False, "居然返回了 200")
            except urllib.error.HTTPError as exc:
                detail = exc.read()
                check("畸形请求被拒（4xx）", 400 <= exc.code < 500, str(exc.code))
                check("错误响应里不含秘密", SECRET.encode() not in detail, detail[:200].decode("utf-8", "replace"))
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()

    print()
    print("=== 3. 服务端日志里不含秘密 ===")
    log_text = log_path.read_bytes()
    check("stderr 里不含秘密", SECRET.encode() not in log_text,
          log_text[-300:].decode("utf-8", "replace"))
    print(f"  日志内容（应只有请求行）：")
    for line in log_text.decode("utf-8", "replace").splitlines()[:12]:
        print(f"    {line}")

    print()
    print("=== 4. 没有产生任何新文件（除了我们自己的日志）===")
    after = snapshot(SERVICE)
    created = {p for p in after - before if not p.endswith("_test_stderr.log")}
    check("请求没有落盘", not created, str(sorted(created)))

    log_path.unlink(missing_ok=True)

    print()
    print("=" * 46)
    print(f"结果: {'全部通过' if not failures else str(len(failures)) + ' 项失败'}")
    print("=" * 46)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
