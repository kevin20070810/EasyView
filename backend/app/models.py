"""elements.json 的数据模型（严格对应 docs/elements.schema.json）。

用 Pydantic 建模的好处：字段拼错、类型不符、漏字段会在服务端直接报错，
而不是等到 B 组联调时才发现 —— 这是 48 小时内最值得的防御。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ElementType = Literal[
    "button", "link", "input", "textarea", "select", "checkbox", "radio",
    "submit", "form", "heading", "text", "image", "nav", "table", "iframe", "other",
]

GroupType = Literal[
    "form", "nav", "header", "footer", "aside", "main", "section", "list", "table",
]

SourceKind = Literal["live", "fallback"]


class BBox(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: float
    y: float
    width: float
    height: float


class ElementOption(BaseModel):
    """一个选项。

    - select：对应一个 <option>，A 按 value 匹配，selector 为 null。
    - radio / checkbox：对应组内的一个独立控件，selector 必填 ——
      A 靠它逐项勾选并触发 input/change。element_id 仅作跨模块追溯：
      A 不持有 elements.json，不能靠它定位。
    """

    model_config = ConfigDict(extra="forbid")

    label: str
    value: str
    selected: bool = False
    selector: str | None = None
    element_id: str | None = None


class Element(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^el_[0-9a-f]{8}$")
    type: ElementType
    text: str
    label: str | None = None
    aria_label: str | None = None
    placeholder: str | None = None
    name: str | None = None
    value: str | None = None
    href: str | None = None
    selector: str
    xpath: str
    visible: bool
    bbox: BBox | None = None
    group_id: str | None = None
    in_form: bool = False
    form_id: str | None = None
    required: bool | None = None
    disabled: bool = False
    level: int | None = None
    options: list[ElementOption] | None = None
    order: int = Field(ge=0)


class Group(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^(grp|form)_[0-9a-f]{8}$")
    type: GroupType
    label: str
    element_ids: list[str]


class Stats(BaseModel):
    model_config = ConfigDict(extra="forbid")
    total: int = Field(ge=0)
    visible: int = Field(ge=0)
    by_type: dict[str, int]
    truncated: bool = False


class ElementsDocument(BaseModel):
    """C → B 的完整契约。"""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1.1.0"] = "1.1.0"
    page_url: str
    final_url: str
    page_title: str
    lang: str | None = None
    source: SourceKind = "live"
    fallback_reason: str | None = None
    extracted_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    )
    stats: Stats
    elements: list[Element]
    groups: list[Group]


class ExtractRequest(BaseModel):
    """POST /extract 请求体。"""

    model_config = ConfigDict(extra="forbid")
    url: str = Field(description="要解析的网页地址，必须以 http:// 或 https:// 开头")
    demo: str | None = Field(
        default=None,
        description="可选：直接指定本地快照（hospital / gov / traffic），跳过真实抓取，用于离线演示。",
    )
