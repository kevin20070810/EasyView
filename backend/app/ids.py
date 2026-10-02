"""稳定 ID 生成（协议冻结规则，见 docs/PROTOCOL.md §1.3）。

    element.id      = "el_"   + sha1(selector)[:8]
    form group.id   = "form_" + sha1(selector)[:8]
    其他 group.id   = "grp_"  + sha1(selector)[:8]

保证同一 DOM 节点在任何一次解析中都得到同一个 ID，因此 B 可以把
target_element_id 安全地写进 ui_schema.json，A 可以安全地拿它回原页面高亮。
"""

from __future__ import annotations

import hashlib

ELEMENT_PREFIX = "el"
FORM_PREFIX = "form"
GROUP_PREFIX = "grp"


def _digest(selector: str) -> str:
    return hashlib.sha1(selector.encode("utf-8")).hexdigest()[:8]


def element_id(selector: str) -> str:
    return f"{ELEMENT_PREFIX}_{_digest(selector)}"


def form_id(selector: str) -> str:
    return f"{FORM_PREFIX}_{_digest(selector)}"


def group_id(selector: str) -> str:
    return f"{GROUP_PREFIX}_{_digest(selector)}"
