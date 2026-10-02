# EasyView 简界

> **给全网的网站，加一个敬老版。**
>
> 不是重新开发老人专用 App，而是在用户和现有网页之间加一层智能适配。

国内主流网站的「长辈版 / 无障碍浏览 / 敬老版」入口**必须由网站自己开发**，
所以大量网站根本没有 —— 越不重视体验的越没有。

EasyView 是一个 Chrome 扩展，**不依赖网站配合**。用户在任意网页点一下「适老」，
扩展当场读懂这个页面，把它重构成老人能用的样子。

```
原网页：新闻、公告、广告、复杂入口混杂，一屏 40 个链接
EasyView：我要挂号 / 查看报告 / 就医缴费 / 联系医院
```

---

## 一、架构

产品形态是**浏览器扩展**，所以整条链路都在用户浏览器这一侧：

```
用户在 Chrome 打开一个复杂网页（医院 / 政务 / 交通 / 银行…）
   │
   ├─ content script 已注入，页面角落显示「适老」入口
   │
   ▼ 用户点击
   │
   ├─ ① 提取：在【当前页面内】读 DOM → elements.json
   │        （用户就在这个页面上，不需要服务端再抓一遍）
   │
   ├─ ② 理解：发给 AI 服务 → ui_schema.json
   │        （判断这页上老人最需要办哪几件事，翻译成人话）
   │
   └─ ③ 渲染：Shadow DOM 覆盖层，老人看到少数几个大按钮任务卡
            点卡片 → 操作页面上的真实元素
```

**没有服务端网页抓取。** 用户在哪个页面，就提取哪个页面。

> 这条是踩过坑才定下来的：原先的方案是「输入 URL → 服务端 Playwright 抓取」。
> 它抓到的**可能不是用户眼前的那个页面** —— 登录态不同、AB 测试、个性化推荐、
> 懒加载时机不同都会导致 DOM 不同，而点击卡片要操作的恰恰是用户眼前那个元素。
> 详见 [`backend/README.md`](backend/README.md)。

---

## 二、目录

| 目录 | 内容 | 状态 |
|---|---|---|
| [`easyview-extension/`](easyview-extension/) | Chrome 扩展（MV3）—— **产品本体** | 可加载运行，自包含 |
| [`ai-service/`](ai-service/) | 页面理解服务（规则引擎 + AI 增强） | 规则可用；AI 未接通 |
| [`docs/`](docs/) | 公共协议、样例、评审草案 | 见第四节 |
| [`backend/`](backend/) | 提取逻辑参考实现 + 协议校验工具 | 提取逻辑待移植 |

---

## 三、当前状态（诚实版）

### 已经能跑

- **通用网页全链路已打通**：在任意网页点扩展图标 → 页面内提取 → 分析服务理解 → 渲染大字卡片
  - 三个 fixture 端到端实测通过：医院 102 元素 → 7 卡 / 政务 80 → 7 卡 / 交通 81 → 7 卡
  - 风险分级一路生效到界面：`ETC充值 → blocked`（「这项需要您自己在原网页办理」）、
    `查违章 → sensitive`（「打开前会先跟您确认」）
- **四个站点的专用敬老版**：中国铁路 12306 / 中国移动 / 中国天气网 / 中国邮政
  - 12306 能真正设置出发地、到达地、日期并**触发官方查询按钮**
  - 中国天气网能读原页面的实况气温、七天预报和生活指数
- **AI 服务**：模型提出任务 → 绑定器回填定位与证据 → 0.3 校验 → 一次重试 → 退回规则
- **规则引擎**作为兜底（22 项测试通过），服务不可用时扩展可一键退回本地规则版
- **协议校验**：`selfcheck` 52 项、`check_ui` 16 项、`check_docs` 20 项、0.3 草案 3 份样例全绿

### 还不能跑 / 还没做

- ⚠️ **只接了 localhost**：分析服务地址写死在本机。部署到服务器需要把域名加进
  `host_permissions`，目前没有配置界面
- ⚠️ **没有同意界面**：通用网页会把**当前页面的结构**（元素文字、链接地址、表单标签）
  发到分析服务，但还没做用户授权确认这一步
- ⚠️ **语义质量仍需人工评审**：机器只判「必留任务覆盖」，`golden_cases` 明确要求
  按任务含义评审、接受同义标题
- ⚠️ 扩展的专用站点模式（12306 等）**仍是手工适配**，与 AI 通用链路是两套实现
- ⚠️ 旧版通用候选版（`generic-content.js`，让用户自己勾选）保留为兜底，尚未删除

### 协议版本状况

| 文件 | 版本 | 状态 |
|---|---|---|
| `docs/elements.schema.json` | **1.1.0** | 提取 → AI 的契约，在用 |
| `docs/drafts/ui-schema-0.3/ui.schema.json` | **0.3.0-draft** | **已接入运行代码** |
| `docs/ui.schema.json` | 0.2.0-draft | 历史中间版本，已被 0.3 取代 |
| 规则引擎与模型的实际产出 | **0.3.0-draft** | 两条路径都经过绑定器，已统一 |

0.3 是当前唯一的产出契约：规则草稿和模型草稿同构，都经过 `binder.py`。
此前「规则引擎输出 0.1.0-draft、仓库声明 0.2.0-draft」的漂移已经消除。

---

## 四、协议

| 文件 | 作用 |
|---|---|
| [`docs/elements.schema.json`](docs/elements.schema.json) | **提取 → AI** 的契约（v1.1.0） |
| [`docs/ui.schema.json`](docs/ui.schema.json) | **AI → 渲染** 的契约（v0.2.0-draft） |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | 协议的设计理由、ID 规则边界、截断策略 |
| [`docs/examples/`](docs/examples/) | 可直接使用的真实样例数据 |
| [`docs/drafts/ui-schema-0.3/`](docs/drafts/ui-schema-0.3/README.md) | 0.3 评审草案：风险分级、证据溯源、内容保真 |

0.3 草案相对 0.2 增加了几件关键能力，值得先读它的 README：

- **`risk`（normal / sensitive / blocked）+ `confirmation`** —— 涉钱、涉身份、
  涉医疗提交的动作要么先确认，要么禁止扩展代办
- **`provenance` + `evidence[].quote`** —— 每张卡片的文案必须能追到具体元素的原文，
  模型不得编造；定位字段由绑定器从 `elements.json` 回填
- **`content_meta.mode`（verbatim / rewritten / generated）** —— 区分「照抄原文」
  和「改写成人话」，改写不得新增功能、金额或资格承诺
- **`state` / `empty_reason`** —— 找不到可靠任务时明确返回空状态，而不是硬凑卡片

---

## 五、快速开始

### 加载扩展

1. Chrome 打开 `chrome://extensions`
2. 开启右上角「开发者模式」
3. 「加载未打包的扩展程序」→ 选择 `easyview-extension/`
4. 打开 12306 / 10086 / weather.com.cn / 11185 任一页面，右下角会出现「敬老版」；
   其他网页点浏览器工具栏的扩展图标即可生成候选版

> 修改文件后需回扩展管理页点刷新，再刷新目标页面。

### AI 服务

```bash
cd ai-service

# 只看规则引擎结果（不需要 key）
python app.py --host 127.0.0.1 --port 8787

# 分析单份 elements.json
python app.py --file ../docs/examples/elements.hospital.json
```

**接通模型需要同时做两件事**，缺一不可：

**① 配置环境变量**（OpenAI 兼容协议，国内可达的服务商均可）

| 服务商 | `EASYVIEW_BASE_URL` | `EASYVIEW_MODEL` 示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 阿里百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |

**② 显式开启 AI** —— 光有 key 不会自动启用：

- HTTP：`POST /analyze?ai=1`
- 命令行：`python app.py --file x.json --ai`

> `/health` 返回的 `ai_configured` 只说明 key 是否就位，
> **不代表**本次请求会走模型。此外注意当前 `pipeline.py` 只允许模型
> 修改已有卡片的标题、副标题和顺序（**不能新增或删除卡片**），
> 卡片本身仍由 `builder.py` 的关键词规则决定 —— 这是「AI 目前没有体现出价值」的直接原因，
> 属于待改造项。

`EASYVIEW_API_KEY` 只从环境变量读取，**不写入代码、不入库**（`.env` 已在 `.gitignore`）。

### 把 `elements.json` 压成给模型读的页面说明书

```bash
cd ai-service
python digest.py ../docs/examples/elements.hospital.json
```

直接把 `elements.json` 丢给模型有三个问题：token 浪费在模型用不到的定位字段上、
扁平列表丢掉了页面结构、同一内容重复出现（表格整体 + 逐个单元格、标签文字 + 输入框 label）。
`digest.py` 把它压成**分区的文本说明书**，实测降到原 JSON 的 **5%**：

| 快照 | 原始 JSON | 说明书 |
|---|---|---|
| 医院（102 元素） | 56,755 字符 | 2,726 字符 |
| 政务（80 元素） | 43,802 字符 | 2,236 字符 |
| 交通（81 元素） | 43,575 字符 | 2,089 字符 |

### 协议校验

```bash
cd backend
python -m tools.selfcheck    # elements.json vs docs/elements.schema.json
python -m tools.check_ui     # B 的 ui_schema 引用的 ID 是否真实存在
python -m tools.check_docs   # 两份交接文档的契约表格是否逐字一致

cd ../docs/drafts/ui-schema-0.3
python validate.py           # 0.3 草案结构、来源、动作约束
python validate.py --self-test
```

---

## 六、设计原则（踩坑总结）

1. **提取在页面内做，不在服务端。** 服务端抓到的不一定是用户眼前的页面。
2. **提取只描述客观结构，不做重要性判断。** 「哪个功能对老人重要」是理解层的活；
   两边都打分，冲突时无法裁决。
3. **不伪造。** 定位不到控件就报错，不猜；读不到实况气温就不显示温度；
   降级必须如实标记 `source="fallback"`。悄悄返回假数据是最糟的做法。
4. **隐藏元素不丢弃。** 弹窗 / 折叠面板里的表单常常才是核心功能
   （实测 12306 的购票表单就在 `display:none` 容器里），过滤权交给下游。
5. **模型不碰定位字段。** 它只引用元素 ID 和字段名，`selector` / `href` / `quote`
   由绑定器从 `elements.json` 回填 —— 模型没有机会编造它们。
6. **涉钱涉身份的动作不由扩展代办。** 只做「引导到原站 + 必要时先确认」。

---

## 七、Git 协作

仓库：`kevin20070810/EasyView`

| 分支 | 用途 |
|---|---|
| `main` | 最终稳定版本（尚未创建） |
| `frontend` | A 成员开发 |
| `ai` | B 成员开发 |
| `backend` | C 成员开发 |

> 项目早期按 A / B / C 三个模块分工，各自一个分支。
> 现在按**产品整体**推进，模块边界正在淡化，分支结构待统一。

**commit 格式**：`[A] add component` / `[B] update prompt` / `[C] fix parser`；
跨模块或整体改动用 `[ALL]`。
