# EasyView C 组 · 网页解析服务

> **角色**：Backend Engineer
> **任务**：把网页转换成 AI 能够理解的数据。
> **不是**爬虫。输入 URL，输出 `elements.json`。

---

## 1. 边界（重要）

本模块严格遵守《统一协作开发规范 v2.0》§3 与《C 组任务书》§9：

| ✅ 做 | ❌ 不做 |
|---|---|
| Playwright 网页访问 | 调用任何 AI / LLM |
| DOM 解析 | 判断功能重要程度、给元素打分排序 |
| 数据清洗 | 设计 UI、生成 HTML / CSS / 页面结构 |
| 输出客观结构 JSON | 决定卡片标题措辞（如「预约挂号」→「我要挂号」是 B 的活） |

代码里有一条自检项专门检查输出中**不得出现** `importance` / `priority` / `score` /
`rank` / `html` / `css` 等越界字段，防止无意中把 B 的职责做进 C 里。

---

## 2. 技术方案

- **FastAPI** —— HTTP 接口（任务书 §4）
- **Playwright (Chromium)** —— 网页访问与 DOM 提取（任务书 §4）

提取在**页面内一次完成**：`app/extract_dom.js` 在浏览器上下文里同步跑完全部 DOM 遍历，
只往 Python 侧回传一个 JSON。相比 Python 端逐元素访问，少了几百次跨进程往返。

---

## 3. 安装与运行

```bash
cd backend

# 首次必需：下载 Chromium 内核（约 190MB）
python -m playwright install chromium

# 依赖（若尚未安装）
pip install -r requirements.txt

# 启动
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

打开 <http://127.0.0.1:8000/docs> 可看到交互式 API 文档。

### 没有网 / 内核装不上？

服务内置**浏览器自动回退**：依次尝试 Playwright 自带 Chromium → 系统 Chrome → 系统 Edge。
即使 `playwright install` 失败，只要有 Chrome 或 Edge，服务照样能起来。

也可以显式指定：

```bash
EASYVIEW_BROWSER_CHANNEL=msedge python -m uvicorn app.main:app --port 8000
```

---

## 4. 接口

### `POST /extract` —— 主接口

**请求**

```json
{ "url": "https://www.example-hospital.com/guahao" }
```

可选 `demo` 字段：直接指定本地快照（`hospital` / `gov` / `traffic` / `generic`），
跳过真实抓取，用于**离线演示**。

```json
{ "url": "https://any-url", "demo": "hospital" }
```

**响应**：符合 [`docs/elements.schema.json`](../docs/elements.schema.json) 的 `elements.json`（HTTP 200）。

```json
{
  "schema_version": "1.0.0",
  "page_url": "https://...",
  "final_url": "https://...",
  "page_title": "示例市第一人民医院 - 网上服务大厅",
  "lang": "zh-CN",
  "source": "live",
  "fallback_reason": null,
  "extracted_at": "2025-03-10T14:22:31+08:00",
  "stats": { "total": 93, "visible": 93, "by_type": {"link": 34, "input": 7}, "truncated": false },
  "elements": [
    {
      "id": "el_1ccf3fbc",
      "type": "input",
      "text": "请输入就诊人真实姓名",
      "label": "就诊人姓名",
      "placeholder": "请输入就诊人真实姓名",
      "name": "name",
      "value": null,
      "href": null,
      "selector": "#name",
      "xpath": "/html[1]/body[1]/div[3]/div[1]/div[2]/div[1]/div[1]/form[1]/fieldset[1]/input[1]",
      "visible": true,
      "bbox": { "x": 220, "y": 612, "width": 220, "height": 32 },
      "group_id": "form_6f230879",
      "in_form": true,
      "form_id": "form_6f230879",
      "required": true,
      "disabled": false,
      "level": null,
      "order": 41
    }
  ],
  "groups": [
    { "id": "form_6f230879", "type": "form", "label": "门诊预约登记",
      "element_ids": ["el_6f230879", "el_1ccf3fbc"] }
  ]
}
```

**关键点**：真实抓取失败时**不会**返回 5xx，而是自动降级到本地快照，
如实标记 `source="fallback"` + `fallback_reason`（规范 §9），
保证 A 组永远拿得到可渲染的数据。

**错误码**

| 状态码 | 场景 |
|---|---|
| 400 | `url` 为空、协议不是 http/https、指向内网地址（SSRF 防护） |
| 200 | 包括「真实抓取失败已降级」的情况 —— 用 `source` 字段区分 |
| 503 | 连本地降级快照都不可用（部署问题，必须让人看见） |

### 其他接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查，返回可用快照列表 |
| GET | `/snapshots` | 列出本地降级快照 |
| GET | `/schema/elements` | 返回冻结的协议原文，供 B/A 拉取对齐 |

> A 组的前端在浏览器里直连本服务，已全局开启 **CORS**（`allow_origins=["*"]`），
> 否则联调第一步就会卡在跨域上。

---

## 5. 降级链路（规范 §9）

```
POST /extract
   │
   ├─ 指定了 demo ？ ──是──> 直接用本地快照，source=fallback, reason=requested
   │
   └─ 否 ──> Playwright 真实抓取
                │
                ├─ 成功且有元素 ──> source=live
                │
                └─ 失败 ──> 按 URL 关键字猜一个语义相近的快照，source=fallback
                             reason ∈ {timeout, nav_error, blocked, empty, unsupported}
```

关键字路由：URL 含 `hospital/guahao/医院/挂号` → `hospital`；
`gov/政务/zwfw/12345` → `gov`；`traffic/bus/metro/交通/12306` → `traffic`；否则 `generic`。

实测：

| 请求 URL | 结果 |
|---|---|
| `https://www.notexist-hospital-xyz.invalid/guahao` | `fallback` / `nav_error` / 93 元素 / `snapshot://hospital` |
| `https://www.notexist-gov-xyz.invalid/bsfw` | `fallback` / `nav_error` / 80 元素 / `snapshot://gov` |
| `https://www.notexist-traffic-xyz.invalid/bus` | `fallback` / `nav_error` / 81 元素 / `snapshot://traffic` |
| `https://www.notexist-random-xyz.invalid/page` | `fallback` / `nav_error` / 28 元素 / `snapshot://generic` |

---

## 6. 自检

```bash
cd backend
python -m tools.selfcheck                      # 跑全部本地快照
python -m tools.selfcheck --url https://...     # 额外测真实站点
python -m tools.selfcheck --live-only --url https://...
```

三个工具构成一条完整的接口防线：

| 工具 | 校验对象 | 检查项 |
|---|---|---|
| `tools/selfcheck.py` | C 的产出 vs `elements.schema.json` | 113 项 |
| `tools/check_ui.py` | B 的 `ui_schema.json` vs 配对的 `elements.json` | 14 项 |
| `tools/check_docs.py` | A/B 两份交接文件的契约表格 | 19 项 |

`selfcheck.py` 做两件事：

1. **JSON Schema 校验** —— 用 `docs/elements.schema.json` 校验实际产出
2. **业务不变量校验** —— schema 拦不住的那些：
   - 元素 ID 无重复且全部合规
   - `order` 从 0 连续递增
   - 元素的 `group_id` 无悬空引用
   - 分组的 `element_ids` 与元素归属**双向一致**
   - `stats` 与实际元素数一致
   - `source=fallback` 必须带 `fallback_reason`
   - 未越界输出 UI / 重要性字段

当前状态：**61 项检查全部通过**（generic 28 元素 / gov 80 / hospital 93 / traffic 81）。

---

## 7. 配置项

全部通过环境变量覆盖，见 `app/config.py`：

| 变量 | 默认 | 说明 |
|---|---|---|
| `EASYVIEW_NAV_TIMEOUT_MS` | `25000` | 页面导航超时 |
| `EASYVIEW_SETTLE_MS` | `1500` | 等待 JS 渲染的时间 |
| `EASYVIEW_HEADLESS` | `1` | 置 `0` 可看到浏览器窗口，调试用 |
| `EASYVIEW_BROWSER_CHANNEL` | 空 | 指定 `chrome` / `msedge` 用系统浏览器 |
| `EASYVIEW_MAX_ELEMENTS` | `400` | 元素上限，超出截断并标记 `stats.truncated` |
| `EASYVIEW_ALLOW_PRIVATE_HOSTS` | `0` | 置 `1` 放开内网访问（本地联调） |

调试时打开可见浏览器，能直观看到服务到底打开了什么页面：

```bash
EASYVIEW_HEADLESS=0 python -m uvicorn app.main:app --port 8000
```

---

## 8. 代码结构

```
backend/
├── app/
│   ├── main.py          FastAPI 应用、路由、CORS、异常映射
│   ├── extractor.py     Playwright 访问 + 浏览器池 + 降级调度
│   ├── extract_dom.js   【页面内】DOM 遍历与客观结构提取
│   ├── builder.py       原始结构 -> 协议文档（ID/分组/截断/统计）
│   ├── ids.py           稳定 ID 规则
│   ├── models.py        Pydantic 模型 = 协议的可执行副本
│   ├── fallback.py      降级快照解析与关键字路由
│   └── config.py        全部可调参数
├── fixtures/            hospital / gov / traffic / generic 本地快照
├── tools/selfcheck.py   协议自检
└── requirements.txt
```

---

## 9. 给 B 组的一句话

> 每个 `input` / `select` / `textarea` 都带 `label` 字段和 `form_id`；
> 同一表单内的字段共享一个 `form_id`，提交按钮也在其中。
> 取字段中文名请用 `label ?? placeholder ?? name` 这个顺序 ——
> 页面本身没写 `label` 时（实测约 2 个登录框如此）`label` 会是 `null`，这是如实反映，不是解析失败。
> 你不需要靠文档序猜测哪个字段叫什么 —— 也不需要给元素打分，那是**你**的活，不是我的。

### 处理大页面的建议

真实站点元素很多（实测 `gov.cn` 378 个、`12306` 触顶 400 个），建议：

1. **优先处理 `visible=true` 的元素** —— `12306` 首页 400 个元素中只有 145 个可见。
2. 当 `stats.truncated=true` 时，隐藏元素是**有意保留**的：
   弹窗/折叠面板里的表单常常才是核心功能（`12306` 的购票表单就在 `display:none` 容器里）。
   需要时再按 `group_id` 取用它们，不要直接丢弃。
3. 用 `groups` 做功能聚类的抓手，比在扁平列表里按文本猜要可靠得多。

