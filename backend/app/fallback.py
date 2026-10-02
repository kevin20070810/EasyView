"""规范 §9 失败降级：真实抓取不可用时，用本地快照兜底，保证 Demo 永不翻车。

关键点：降级结果**必须如实标记** source="fallback" 与 fallback_reason，
让 B/A 知道拿到的不是实时数据。悄悄返回假数据是最糟糕的做法。
"""

from __future__ import annotations

from pathlib import Path

from .config import FIXTURES_DIR

# URL 关键字 -> 快照名。用于真实站点挂掉时自动挑一个语义相近的兜底页面。
_KEYWORD_MAP: list[tuple[tuple[str, ...], str]] = [
    (("hospital", "guahao", "yy.", "yiyuan", "医院", "挂号", "haodf", "卫生院"), "hospital"),
    (("gov", "zhengwu", "zwfw", "政务", "政府", "12345", "gov.cn"), "gov"),
    (("traffic", "jt.", "bus", "metro", "交通", "地铁", "公交", "12306", "航空"), "traffic"),
]

DEFAULT_SNAPSHOT = "generic"
# 每个快照对应的人类可读来源说明，写进 fallback_reason 便于现场排查。
SNAPSHOT_TITLES = {
    "hospital": "市第一人民医院 · 网上服务（本地快照）",
    "gov": "市政务服务中心 · 办事大厅（本地快照）",
    "traffic": "市交通运输局 · 出行服务（本地快照）",
    "generic": "本地演示快照",
}


def available_snapshots() -> list[str]:
    if not FIXTURES_DIR.exists():
        return []
    return sorted(p.stem for p in FIXTURES_DIR.glob("*.html"))


def guess_snapshot(url: str) -> str:
    """按 URL 关键字猜测最贴近的兜底快照。"""
    low = (url or "").lower()
    for keywords, name in _KEYWORD_MAP:
        if any(k in low for k in keywords):
            return name
    return DEFAULT_SNAPSHOT


def resolve_snapshot(name: str) -> Path | None:
    """返回快照文件路径；找不到时回落 generic，最后回落任意可用快照。"""
    if not FIXTURES_DIR.exists():
        return None
    candidate = FIXTURES_DIR / f"{name}.html"
    if candidate.exists():
        return candidate
    generic = FIXTURES_DIR / f"{DEFAULT_SNAPSHOT}.html"
    if generic.exists():
        return generic
    others = sorted(FIXTURES_DIR.glob("*.html"))
    return others[0] if others else None
