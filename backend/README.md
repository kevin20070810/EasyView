# EasyView 提取层

> ⚠️ **这不是一个服务。** 服务端抓取方案已经退役 —— 没有 HTTP 接口，没有 Playwright，没有浏览器池。

---

## 1. 为什么退役

原方案是「用户输入 URL → 服务端用 Playwright 打开该 URL → 提取 DOM → 输出 `elements.json`」。
这个方向和产品的真实形态冲突：

| 问题 | 说明 |
|---|---|
| **抓到的不是同一个页面** | 产品形态是 Chrome 扩展在**用户当前所在的页面**上工作。服务端再抓一遍，拿到的可能是另一个 DOM —— 登录态不同、AB 测试、个性化推荐、懒加载时机不同。而点击卡片要操作的是**用户眼前那个**元素。 |
| **登录墙** | 医院、政务、12306 的核心功能几乎都在登录之后。服务端没有用户的会话。 |
| **验证码 / 反爬** | 服务端抓取会触发人机验证。而扩展跑在用户自己的浏览器里，这些根本不存在。 |
| **慢** | 实测抓一个真实站点要 2–25 秒。扩展在页面上，DOM 是现成的。 |
| **多余的跨进程定位** | 服务端和前端不在一个进程，所以需要 `selector` / `xpath` / 哈希 ID 来跨进程定位元素，还因此踩过「`getElementById` 永远返回 null」的坑。提取在同一进程里时，直接持有元素引用即可。 |

**结论：提取应该在页面内完成，也就是浏览器扩展的 content script 里。**

---

## 2. 这里还剩什么

| 路径 | 用途 | 状态 |
|---|---|---|
| `app/extract_dom.js` | 【页面内】DOM 遍历与客观结构提取 | **待移植** → content script |
| `app/builder.py` | 原始结构 → `elements.json`（ID / 分组 / 截断 / 统计） | **待移植** → JS |
| `app/ids.py` | 稳定 ID 规则 | **待移植** → JS |
| `app/models.py` | 协议的可执行副本（Pydantic） | 参考，定义字段形状 |
| `app/config.py` | 路径与输出上限 | 保留 |
| `tools/` | 三个协议校验工具 | ✅ **仍在用** |
| `fixtures/` | 4 个本地测试页 | 用途变为**扩展的本地测试页** |

前四项是**提取逻辑的参考实现**。移植完成后它们就可以删除 —— 现在留着是因为
JS 版本还没写出来，删掉会丢失唯一的参考。

---

## 3. 已删除的文件

| 文件 | 原本做什么 |
|---|---|
| `app/main.py` | FastAPI 应用、`POST /extract`、CORS |
| `app/extractor.py` | Playwright 浏览器池、页面导航、超时、拦截检测、SSRF 防护 |
| `app/fallback.py` | URL 关键词路由到本地快照 |

git 历史里仍然可以找到它们。

---

## 4. 协议校验工具（仍在用）

```bash
cd backend

python -m tools.selfcheck      # elements.json vs docs/elements.schema.json
python -m tools.check_ui       # B 的 ui_schema 引用的 ID 是否真实存在
python -m tools.check_docs     # A/B 两份交接文档的契约表格是否逐字一致
```

| 工具 | 校验对象 | 当前状态 |
|---|---|---|
| `tools/selfcheck.py` | `docs/examples/elements.*.json` vs `docs/elements.schema.json` | 52 通过 / 0 失败 |
| `tools/check_ui.py` | `ui_schema.json` 与配对 `elements.json` 的交叉引用 | 16 通过 / 0 失败 |
| `tools/check_docs.py` | 两份交接文档的契约表格 | 20 通过 / 0 失败 |

`selfcheck.py` 做两件事：

1. **JSON Schema 校验** —— 用 `docs/elements.schema.json` 校验已固化的产出
2. **业务不变量校验** —— schema 拦不住的那些：
   - 元素 ID 无重复且全部合规
   - `order` 从 0 连续递增
   - `group_id` 无悬空引用
   - 分组的 `element_ids` 与元素归属**双向一致**
   - `stats` 与实际元素数一致
   - `source=fallback` 必须带 `fallback_reason`
   - 未越界输出 UI / 重要性字段（规范 §3）

> 原先 `selfcheck` 还能现场抓取真实站点，随抓取能力一起退役了。
> 校验对象改为 `docs/examples/` 下已固化的真实产出：
> hospital 102 元素 / gov 80 / traffic 81。

---

## 5. 关于 `elements.json`

协议本身没有变，仍然是 [`docs/elements.schema.json`](../docs/elements.schema.json) v1.1.0。
两处要点：

- 每个 `input` / `select` / `textarea` 都带 `label` 与 `form_id`；
  取字段中文名用 `label ?? placeholder ?? name`（页面没写 label 时 `label` 为 `null`，是如实反映）。
- 隐藏元素是**有意保留**的：弹窗 / 折叠面板里的表单常常才是核心功能
  （实测 12306 的购票表单就在 `display:none` 容器里）。
  过滤权交给下游，不要在这里丢。

---

## 6. 下一步

把 `extract_dom.js` 与 `builder.py` 的逻辑合并成**一个页面内模块**，供 content script 引入：

```js
const { elements, resolve } = EasyViewExtract.run()
// elements → 发给 AI 服务
// resolve  → 传给渲染层的 resolveElement，用来定位宿主页面元素
```

这样 `elements.json` 不再需要 `selector` 跨进程反查，ID 也不再需要哈希。
