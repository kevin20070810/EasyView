# EasyView A 组交接文件 · 前端渲染

> **角色**：Frontend Engineer
> **你负责**：把 `ui_schema.json` 渲染成老人能用的页面
> **交接人**：C 组（后端）　**交接时间**：项目启动阶段
> **本文件对应协议版本**：`ui.schema.json` v0.1.0-draft / `elements.schema.json` v1.0.0

---

## 一、当前进度

| 模块 | 状态 | 说明 |
|---|---|---|
| **C 后端** | ✅ **已完成并通过验证** | 网页解析服务，113 项协议自检通过，真实站点（gov.cn / 12306 / 协和医院）实测可用 |
| **协议** `docs/elements.schema.json` | 🟡 **待三人确认** | v1.0.0，C 已起草并实现，等 A/B 确认后冻结 |
| **协议** `docs/ui.schema.json` | 🟡 **待你和 B 确认** | v0.1.0-draft。**原两份项目文档里从未定义过这个文件**，C 代拟以保证你能开工 |
| **A 前端** | ⬜ **未开始** | 仓库暂无 `frontend/` 目录 |
| **B AI** | ⬜ **未开始** | 仓库暂无 `ai-service/` 目录 |

**你现在缺的不是后端。** C 模块已经跑通，你随时可以拿到真实的 `ui_schema.json` 数据开始渲染 —— 见下方「四、立刻可用的测试数据」。

---

## 二、你的职责边界（规范 §3）

| ✅ 你负责 | ❌ 你禁止 |
|---|---|
| UI 组件开发 | 写网页解析 |
| 页面展示 | 调用浏览器 / Playwright |
| `ui_schema.json` 渲染 | **判断功能重要程度** |

第三条最关键：**卡片显示什么、按什么顺序显示，全部由 B 在 `priority` 里决定。**
你按 `priority` 升序渲染即可，不要自己调整顺序，也不要因为「这个看起来更重要」就往上提。

---

## 三、你收到的数据：`ui_schema.json`

**唯一真源**：[`docs/ui.schema.json`](ui.schema.json)。下表与它保持一致，若有出入**以 schema 文件为准**。

### 根对象

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema_version` | string | ✅ | 固定 `"0.1.0-draft"`。A/B 双方必须实现同一版本 |
| `source_elements_schema_version` | string | ✅ | 生成时消费的 `elements.schema_version`，应为 `"1.0.0"` |
| `page_url` | string | ✅ | 必须与对应 `elements.json` 的 `page_url` 完全一致 |
| `page_title` | string | ✅ | 原网页标题 |
| `source` | `"live"` \| `"fallback"` | ✅ | **必须原样透传自 `elements.json`**。为 `fallback` 时 A 必须显示降级提示 |
| `generated_at` | string | ✅ | ISO-8601 时间戳 |
| `page` | object | ✅ | 页面级文案，见下 |
| `cards` | array | ✅ | 卡片列表，至少 1 张 |
| `extensions` | object | ❌ | 逃生舱，安全忽略 |

### `page`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `greeting` | string | ✅ | 问候语，如「您好，这里是 XX 医院网上服务」 |
| `summary` | string | ✅ | 一句话说明能办什么事，如「可以挂号、查报告、缴费」 |

### `cards[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 卡片标识，同一份文档内不得重复。推荐复用 `groups[].id` 或 `element.id`；若以 `el_`/`grp_`/`form_` 开头则必须能追溯回 `elements.json` |
| `title` | string | ✅ | 大字号主标题，如「我要挂号」。老人一眼能懂的动宾短语，禁止专业术语 |
| `subtitle` | string \| null | ❌ | 补充说明，A 用小字号渲染。无内容填 `null`，不要填空串 |
| `icon` | string \| null | ❌ | 冻结图标集取值，见下。填未登记的名字会导致该卡片退化为默认图标 |
| `priority` | integer ≥1 | ✅ | 显示顺序，1 最靠前，**同一份文档内不得重复**。由 B 判断 |
| `action` | object | ✅ | 点击行为，见下 |
| `form` | object \| null | 条件必填 | `action.kind="form"` 时必填；其他情况必须为 `null` |

### `action`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `kind` | `navigate` \| `form` \| `scroll` \| `external` | ✅ | 行为类型 |
| `target_element_id` | string \| null | 条件必填 | `kind` 为 `navigate`/`form`/`scroll` 时必填。**必须是 `elements[].id`（`el_` 前缀）**，不能填 `groups[].id`（`grp_`/`form_` 前缀）—— 分组 ID 不在 `elements[]` 中，A 查不到 |
| `href` | string \| null | 条件必填 | `kind=external` 时必填，绝对 URL |

### 四种 kind 的渲染行为（A 专用）

| kind | 你的行为 |
|---|---|
| `navigate` | 点击后跳转到原网页对应元素处（可用 `elements[].selector` 定位） |
| `form` | 展开 `form` 描述的填写界面 |
| `scroll` | 滚动定位到 `target_element_id` 对应元素，不跳转 |
| `external` | 直接打开 `href` |

### `form`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `submit_element_id` | string | ✅ | 提交按钮元素 ID，该元素 `type` 应为 `submit` 或 `button` |
| `fields` | array | ✅ | 至少 1 个字段 |
| `fields[].element_id` | string | ✅ | 对应 `elements[].id`，该元素 `type` 应为 `input`/`select`/`textarea` |
| `fields[].label` | string | ✅ | 给老人看的大字标签，如「身份证号」。应优先取自元素的 `label`，取不到再用 `placeholder` |
| `fields[].input_type` | enum | ✅ | 见下 |
| `fields[].placeholder` | string \| null | ❌ | 占位提示 |
| `fields[].required` | boolean | ✅ | 应透传自元素的 `required`（为 null 时按 false） |

### `input_type` 取值

| 值 | 说明 |
|---|---|
| `text` | 普通文本（姓名、地址） |
| `number` | 纯数字 |
| `date` | 日期 |
| `tel` | 电话 / 手机号 |
| `idcard` | 身份证号（18 位，可含 X） |
| `password` | 密码 |
| `select` | 下拉单选（适老化建议改为大按钮平铺选项） |
| `radio` | 单选 |
| `checkbox` | 多选 |

### 图标集（你负责维护）

冻结的 16 个图标名，定义在 `docs/ui.schema.json` 的 `icon` 字段里：

```
home  calendar  document  payment  phone  user  search  location  bus  train
hospital  government  warning  info  help  back
```

**新增图标必须改 `docs/ui.schema.json` 并通知 B**，否则 B 填了你没有的名字，那批卡片会全部退化成默认图标。
未登记的图标名 → 用默认图标兜底，不要报错。

---

## 四、立刻可用的测试数据

C 已经把三份**真实的 `elements.json`** 放进仓库，你不需要等 B 就能开始：

```
docs/examples/elements.hospital.json    93 个元素，8 个分组，2 个表单
docs/examples/elements.gov.json         80 个元素，7 个分组
docs/examples/elements.traffic.json     81 个元素，7 个分组
```

以及一份 **`ui_schema.json` 参考样例**（格式见文件头注释，是 C 按目标 UI 手写的）：

```
docs/examples/ui_schema.hospital.json
```

它渲染出来应当长这样：

```
您好，这里是市第一人民医院网上服务
可以预约挂号、查看报告、在线缴费，也可以联系人工客服

┌──────────────────────────────────┐
│ 📅  我要挂号                       │  ← priority 1，点击展开表单
│     门诊预约登记                    │
├──────────────────────────────────┤
│ 📄  查看报告                       │
│     查询检验检查结果                │
├──────────────────────────────────┤
│ 💰  缴费                           │
│     在线缴纳门诊费用                │
├──────────────────────────────────┤
│ 📞  联系客服                       │
│     工作时间 08:00 - 20:00          │
├──────────────────────────────────┤
│ ℹ️  医保查询                        │
└──────────────────────────────────┘
```

**用这个样例先把渲染器写出来**，等 B 接上以后直接换成真实数据即可。

---

## 五、你必须遵守的接口约定（这是与 B 的边界，不是建议）

1. **只按 `priority` 升序渲染**，不要自行重排。功能重要性是 B 的判断，不是你的。
2. **`source="fallback"` 必须显示降级提示。** 此时展示的是演示快照数据，不是用户请求的真实网页 —— 静默展示等于欺骗用户。
3. **`title` / `label` 直接使用，不要改写。** 措辞是 B 精心为老人设计的（例如把「预约挂号」写成「我要挂号」），你改写会破坏这个设计。
4. **`id` 只当字符串用。** 它可能是 `form_xxx`（分组）或 `el_xxx`（元素），形态不同但语义对你是相同的。
5. **遇到未知字段不要崩。** `extensions` 里可能有实验性内容，安全忽略。
6. **`action.target_element_id` 一定是 `el_` 开头的元素 ID**，能在 `elements[].id` 里查到。若查不到，说明数据有问题 —— 这是 B 的 bug，请提出来，不要自己兜底。

---

## 六、常见陷阱

| 陷阱 | 后果 | 正确做法 |
|---|---|---|
| 把 `source="fallback"` 当正常数据显示 | 用户以为看到的是真实网页 | 显式提示「当前为演示数据」 |
| 自己按「看起来重要」重排卡片 | 与 B 的设计冲突，老人找不到重点 | 严格按 `priority` |
| 改写 `title` 措辞 | 破坏适老化文案设计 | 原样渲染 |
| 把 `target_element_id` 当分组 ID 去 `groups[]` 里查 | 查不到，交互失效 | 它一定在 `elements[]` 里 |
| 假设 `form` 一定存在 | `kind != "form"` 时它是 null，会崩 | 先判断 `action.kind` |
| 假设 `cards` 一定有多张 | 协议只保证至少 1 张 | 单张也要正常渲染 |

---

## 七、联调前的自测清单

- [ ] 用 `docs/examples/ui_schema.hospital.json` 能完整渲染出 5 张卡片
- [ ] 卡片顺序 = `priority` 升序（1 → 5），未自行重排
- [ ] `page.greeting` / `page.summary` 正常显示
- [ ] `icon` 为 null 时用默认图标，不报错
- [ ] `subtitle` 为 null 的卡片（如「医保查询」）布局不塌陷
- [ ] `source="fallback"` 时降级提示可见
- [ ] 「我要挂号」点开后，5 个字段按 `label` 显示中文名，`required=true` 的三个有必填标记
- [ ] `input_type="idcard"` 走身份证输入组件，`date` 走日期选择器
- [ ] `extensions` 塞入任意垃圾字段，渲染不崩
- [ ] 字号/按钮尺寸符合适老化要求（大字体、大按钮、低认知负担）

---

## 八、我和 B 之间如何保证不冲突

`ui_schema.json` 是 A 和 B 唯一的接触面，任何一方私自改字段都会让对方返工。因此：

- **唯一真源**：`docs/ui.schema.json`。两份交接文件的字段表都从它抄录，若有出入以它为准。
- **可执行校验**：C 提供了 `backend/tools/check_ui.py`，会真的去 `elements.json` 里逐个查证 `ui_schema` 引用的每个 ID：

  ```bash
  cd backend
  python -m tools.check_ui --pair hospital
  ```

  它检查 14 项，包括：所有 `target_element_id` / `submit_element_id` / `field.element_id` 是否真实存在、类型是否正确、`priority` 是否重复、`card.id` 是否可追溯、`page_url` 与 `source` 是否与 elements 一致。

- **你要做的一件事**：B 产出真实 `ui_schema.json` 后，让他在 `docs/examples/` 里配一份，跑一遍这个工具。**14 项全绿再联调**，能把绝大部分冲突消灭在写代码之前。

  > 实践验证：这个工具在 C 自己手写的样例上就抓到过一次真实冲突 ——
  > 把分组 ID `form_xxx` 误当成 `target_element_id` 填了。
  > 这种错误肉眼极难发现，但 A 拿到数据后会直接查不到元素。

---

## 九、待你和 B 确认的事项（规范 §7 要求三人确认）

`docs/ui.schema.json` 是 C 代拟的，**它需要你和 B 真正认可才能冻结**：

1. `cards` + `priority` 这个"大按钮卡片列表"结构，够不够表达你需要的界面？
2. `action.kind` 的四个取值够用吗？需要 `input`（就地填值）之类的吗？
3. `input_type` 的 9 个取值覆盖了你要做的输入组件吗？
4. 冻结图标集的 16 个图标，作为起步集合适吗？
5. `page.greeting` / `page.summary` 的文案形态符合你的视觉设计吗？
6. 是否同意把 `schema_version` 从 `0.1.0-draft` 升为 `1.0.0` 并冻结？

确认后由发起人改 `docs/ui.schema.json` 的 `const` 值并在 `docs/PROTOCOL.md` 追加变更记录。

---

## 十、你现在就能用的东西

```bash
# 1. 启动 C 的后端（已装好依赖，首次需 python -m playwright install chromium）
cd backend
python -m uvicorn app.main:app --port 8000

# 2. 拿一份真实数据看看
curl -X POST http://127.0.0.1:8000/extract \
     -H "Content-Type: application/json" \
     -d '{"url":"https://demo.easyview.local/h","demo":"hospital"}'

# 3. 交互式 API 文档
#    浏览器打开 http://127.0.0.1:8000/docs
```

后端已开全局 **CORS**（`allow_origins=["*"]`），你的前端在浏览器里直连不会遇到跨域问题。
