# EasyView 简界

> AI 驱动的网页适老化实时重构系统
>
> **不是**重新开发老人专用 App，而是在用户和现有网页之间增加一个智能适配层。

输入一个复杂网页地址（医院、政务、交通网站），系统自动理解内容、判断老人最需要的功能、
重新组织界面，生成大字体、大按钮、低认知负担的新界面。

```
原网页：新闻、公告、广告、复杂入口混杂
EasyView：我要挂号 / 查看报告 / 缴费 / 联系客服
```

---

> ## 获取代码
>
> 分支 `backend` 已推送到 **https://github.com/kevin20070810/EasyView**
> （7 个提交，30 个文件）。
>
> ```bash
> git clone https://github.com/kevin20070810/EasyView.git
> cd EasyView
> git checkout backend
> ```
>
> 仓库当前**只有 `backend` 这一个分支**，`main` 尚未创建 ——
> 按规范 §4，C 组只推 `backend`、不直接推 `main`，`main` 由谁创建属团队决定。

---

## 架构

一条单向数据流水线，三个模块靠两个 JSON 文件解耦：

```
用户 ──URL──> [C 后端] ──elements.json──> [B AI] ──ui_schema.json──> [A 前端] ──> 适老页面
              Playwright                 语义理解                   纯渲染
              DOM 解析                   功能排序
             数据清洗                    UI 结构生成
```

| 模块 | 目录 | 负责 | 严禁 |
|---|---|---|---|
| **A 前端** | `frontend/` | UI 组件、页面展示、JSON 渲染 | 写网页解析、调用浏览器、判断功能重要程度 |
| **B AI** | `ai-service/` | 网页语义理解、功能排序、UI 结构生成 | 生成 HTML、修改网页、编写 CSS |
| **C 后端** | `backend/` | Playwright 网页访问、DOM 解析、数据清洗 | 调用 AI、判断重要功能、设计 UI |

---

## 目录结构

```
EasyView/
├── docs/                       # 公共协议（三人确认才能改）
│   ├── elements.schema.json    #   C -> B 契约
│   ├── ui.schema.json          #   B -> A 契约
│   ├── PROTOCOL.md             #   协议说明与设计理由
│   ├── A_前端交接.md            #   → A 组：进度、职责、渲染规则
│   ├── B_AI交接.md              #   → B 组：进度、职责、生成规则
│   └── examples/               #   可直接使用的真实样例数据
│       ├── elements.hospital.json      C 的真实产出（93 元素）
│       ├── elements.gov.json           C 的真实产出（80 元素）
│       ├── elements.traffic.json       C 的真实产出（81 元素）
│       └── ui_schema.hospital.json     B 的输出格式模板（校验全通过）
├── backend/                    # C 组：网页解析服务
│   ├── app/
│   ├── fixtures/               #   降级用本地快照
│   └── tools/                  #   协议自检 / 接口交叉校验 / 文档一致性
├── frontend/                   # A 组
└── ai-service/                 # B 组
```

---

## 交接文件

| 文件 | 给谁 | 内容 |
|---|---|---|
| [`docs/A_前端交接.md`](docs/A_前端交接.md) | **A 组** | 当前进度、职责边界、`ui_schema.json` 完整字段表、渲染规则、联调自测清单 |
| [`docs/B_AI交接.md`](docs/B_AI交接.md) | **B 组** | 当前进度、职责边界、`elements.json` 完整字段表、`ui_schema.json` 生成规则、联调自测清单 |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | 全员 | 协议的设计理由、ID 规则边界、截断策略、变更记录 |

> 两份交接文件里的**契约表格逐字一致**，由 `backend/tools/check_docs.py` 程序化强制。
> 改了一边忘了另一边会被直接检出 —— 这是防止 A/B 接口漂移的机制，不是靠自觉。

---

## 接口一致性校验

三个工具，全部可执行、无外部依赖：

```bash
cd backend

python -m tools.selfcheck              # C 的产出是否符合 elements.schema.json（113 项）
python -m tools.check_ui --pair hospital   # B 的 ui_schema 引用的 ID 是否真实存在（14 项）
python -m tools.check_docs             # A/B 两份交接文件的契约表格是否一致（19 项）
```

**约定**：B 产出 `ui_schema.json` 后放进 `docs/examples/`，`check_ui` 全绿再叫 A 联调。

---

## Git 协作规则

**仓库**：`kevin20070810/EasyView`

| 分支 | 用途 |
|---|---|
| `main` | 最终稳定版本，**只允许合并**，禁止直接 push |
| `frontend` | A 成员开发 |
| `ai` | B 成员开发 |
| `backend` | C 成员开发 |

**禁止**：直接 push main / 修改其他成员目录 / 修改公共协议文件。

**commit 格式**：

```
[A] add component
[B] update prompt
[C] fix parser
```

---

## 快速开始（C 组后端）

```bash
cd backend
python -m playwright install chromium     # 首次必需
python -m uvicorn app.main:app --port 8000
```

详见 [`backend/README.md`](backend/README.md)。

---

## 联调流程

```
C 生成 elements.json  ->  B 读取并生成 ui_schema.json  ->  A 读取并渲染页面
```

**协议冻结**：`docs/elements.schema.json` 与 `docs/ui.schema.json` 属核心协议，
任何修改必须三人确认。字段含义、设计理由与变更记录见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

---

## 失败降级（规范 §9）

| 故障 | 降级策略 | 实现状态 |
|---|---|---|
| AI 失败 | 使用规则模型 | B 组 |
| 网页解析失败 | 使用 Demo 数据（本地快照） | ✅ C 组已实现 |
| 组件不存在 | 使用默认组件 | A 组 |

C 组的降级结果**如实标记** `source="fallback"` 与 `fallback_reason`，
B/A 据此决定是否向用户提示 —— 悄悄返回假数据是最糟糕的做法。
