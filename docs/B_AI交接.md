# EasyView B 组交接文件 · AI 理解

> **角色**：AI Engineer
> **你负责**：读懂 `elements.json`，产出 `ui_schema.json`
> **交接人**：C 组（后端）　**交接时间**：项目启动阶段
> **本文件对应协议版本**：`elements.schema.json` v1.0.0 / `ui.schema.json` v0.1.0-draft

---

> ## 获取代码
>
> 代码已推送到 **https://github.com/kevin20070810/EasyView**
>
> ```bash
> git clone https://github.com/kevin20070810/EasyView.git
> cd EasyView
> git checkout backend        # 仓库当前只有这一个分支
> ```
>
> 本文件提到的 `docs/...` 与 `backend/...` 路径，clone 后都在。
> 仓库当前只有 C 组的 `backend` 分支，`main` 尚未创建。

---

## 一、当前进度

| 模块 | 状态 | 说明 |
|---|---|---|
| **C 后端** | ✅ **已完成并通过验证** | 网页解析服务，113 项协议自检通过，真实站点（gov.cn / 12306 / 协和医院）实测可用 |
| **协议** `docs/elements.schema.json` | 🟡 **待三人确认** | v1.0.0，C 已起草并实现。**你的输入格式已经稳定** |
| **协议** `docs/ui.schema.json` | 🟡 **待你和 A 确认** | v0.1.0-draft。**原两份项目文档里从未定义过这个文件**，C 代拟以保证 A 能开工 |
| **A 前端** | ⬜ **未开始** | 仓库暂无 `frontend/` 目录 |
| **B AI** | ⬜ **未开始** | 仓库暂无 `ai-service/` 目录 |

**你的输入已经就绪，你的输出格式也已定义。** C 模块跑通并有三份真实数据，你可以立刻开始写 prompt，
不需要等任何人 —— 见下方「四、立刻可用的测试数据」。

---

## 二、你的职责边界（规范 §3）

| ✅ 你负责 | ❌ 你禁止 |
|---|---|
| 网页语义理解 | 生成 HTML |
| **功能排序** | 修改网页 |
| UI 结构生成 | 编写 CSS |

**核心要点**：C 给你的数据里**刻意没有任何重要性判断** —— 没有打分、没有排序、没有"哪个对老人最重要"。
这是**留给你的活**。C 给你的是"页面上有什么"，你要产出的是"老人最需要什么"。

---

## 三、你收到的数据：`elements.json`

**唯一真源**：[`docs/elements.schema.json`](../docs/elements.schema.json)。下表与它保持一致，若有出入**以 schema 文件为准**。

### 输入：根对象

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema_version` | string | ✅ | 固定 `"1.0.0"` |
| `page_url` | string | ✅ | 调用方请求的原始 URL |
| `final_url` | string | ✅ | 浏览器实际落地 URL（可能因重定向不同）。`snapshot://xxx` 表示走的是本地快照 |
| `page_title` | string | ✅ | 网页标题 |
| `lang` | string \| null | ❌ | 取自 `<html lang>` |
| `source` | `"live"` \| `"fallback"` | ✅ | **必须原样透传进你的 `ui_schema.json`** |
| `fallback_reason` | string \| null | 条件必填 | `timeout` / `nav_error` / `blocked` / `empty` / `unsupported` / `requested` |
| `extracted_at` | string | ✅ | ISO-8601 时间戳 |
| `stats` | object | ✅ | 见下，**先用它判断页面复杂度** |
| `elements` | array | ✅ | 扁平元素列表，**按 DOM 文档序排列** |
| `groups` | array | ✅ | **元素归属分组 —— 你做功能聚类最关键的抓手**，详见 §3.3 |
| `extensions` | object | ❌ | 逃生舱，安全忽略 |

### 输入：`stats`

| 字段 | 类型 | 说明 |
|---|---|---|
| `total` | int | 元素总数 |
| `visible` | int | 可见元素数 |
| `by_type` | object | 各 `type` 的计数 |
| `truncated` | bool | 为 true 表示超过 400 上限被截断 |

### 3.1 输入：`elements[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 稳定 ID，形如 `el_1ccf3fbc`。**同一页面重复解析结果一致**，你可以安全引用 |
| `type` | enum | ✅ | 客观结构类型，16 个取值见 §3.2 |
| `text` | string | ✅ | 可读文本。取值优先级：`aria-label` > `innerText` > `placeholder` > `value` > `alt` > `title`。**纯图标按钮可能为空串** |
| `label` | string \| null | ❌ | **表单控件的关联标签中文名**，如「身份证号」。非表单控件为 null |
| `aria_label` / `placeholder` / `name` / `value` | string \| null | ❌ | 原始 DOM 属性。密码框的 `value` 一律为 null |
| `href` | string \| null | ❌ | 链接目标（**已解析为绝对 URL**） |
| `selector` | string | ✅ | CSS 选择器，可定位回原页面 |
| `xpath` | string | ✅ | 绝对 XPath，兜底定位方式 |
| `visible` | bool | ✅ | 解析时刻是否可见 |
| `bbox` | object \| null | ❌ | 视口坐标包围盒 `{x,y,width,height}`，供 A 做原页面对照高亮 |
| `group_id` | string \| null | ❌ | 所属分组 ID，对应 `groups[].id` |
| `in_form` | bool | ✅ | 是否在 `<form>` 内 |
| `form_id` | string \| null | ❌ | **所属表单的分组 ID —— 用它把输入框和提交按钮关联起来** |
| `required` | bool \| null | ❌ | 表单控件是否必填 |
| `disabled` | bool | ✅ | 是否被禁用 |
| `level` | int \| null | ❌ | 标题层级（h1=1 ... h6=6），仅 `type=heading` 有值 |
| `order` | int | ✅ | DOM 文档序索引，从 0 开始。**排序以它为准** |

### 3.2 `type` 枚举（16 个）

```
button  link  input  textarea  select  checkbox  radio  submit
form    heading  text  image  nav  table  iframe  other
```

**判定原则：只看 DOM 客观结构，不看语义重要性。**
"挂号"按钮和页脚"版权声明"链接的 `type` 分别是 `button` 和 `link` —— **哪个更重要是你的判断，C 不做**。

### 3.3 输入：`groups[]` —— 你最需要的东西

扁平列表**无法表达**「哪些元素同属一个表单或一块导航」。这正是 `groups` 存在的理由。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 分组 ID。表单固定 `form_` 前缀，其他为 `grp_` |
| `type` | enum | `form` / `nav` / `header` / `footer` / `aside` / `main` / `section` / `list` / `table` |
| `label` | string | 分组的人类可读标签（表单取 `legend`，导航取 `aria-label`）。可能为空串 |
| `element_ids` | array | 属于该分组的元素 ID，按 DOM 文档序 |

**实际例子**（医院快照里的挂号表单）：

```json
{
  "groups": [
    { "id": "form_6f230879", "type": "form", "label": "门诊预约登记",
      "element_ids": ["el_6f230879", "el_1ccf3fbc", "el_3a19b50d", "..."] }
  ],
  "elements": [
    { "id": "el_1ccf3fbc", "type": "input", "label": "就诊人姓名",
      "form_id": "form_6f230879", "required": true, "visible": true, "order": 41 },
    { "id": "el_3a19b50d", "type": "input", "label": "身份证号",
      "form_id": "form_6f230879", "required": true, "visible": true, "order": 43 },
    { "id": "el_0a5dde7d", "type": "submit", "text": "提交预约",
      "form_id": "form_6f230879", "visible": true, "order": 55 }
  ]
}
```

你可以直接得出结论："这三个字段属于同一个动作，加一个提交按钮，构成『我要挂号』这张卡片" —— **不必猜**。

### 3.4 取字段中文名的正确姿势

```
label  ??  placeholder  ??  name
```

`label` 是 C 通过 `label[for]` / 包裹式 `label` / `aria-labelledby` / 紧邻 `label` **客观查询**得到的。
但页面本身没写 `label` 时它会是 `null`（实测约 2 个登录框如此）—— **这是如实反映，不是解析失败**。

---

## 四、立刻可用的测试数据

C 已经在工程的 `docs/examples/` 目录下准备好三份**真实的 `elements.json`**，你现在就能拿来调试 prompt：

```
docs/examples/elements.hospital.json    93 个元素，8 个分组，2 个表单   ← 最适合入门
docs/examples/elements.gov.json         80 个元素，7 个分组，2 个表单
docs/examples/elements.traffic.json     81 个元素，7 个分组，2 个表单
```

以及一份 **`ui_schema.json` 参考样例**，是 C 按规范 §1 的目标界面（`我要挂号 / 查看报告 / 缴费 / 联系客服`）
手写的，**你可以直接把它当作输出格式的模板**：

```
docs/examples/ui_schema.hospital.json
```

它被 `backend/tools/check_ui.py` 校验为 14 项全通过 —— 也就是说**照着它写一定合规**。

### 真实站点的数据规模（供你估算 token 预算）

| 站点 | 元素数 | 可见数 | 分组数 |
|---|---|---|---|
| 北京协和医院 `pumch.cn` | 34 | 29 | 2 |
| 示例政务快照 | 80 | 80 | 7 |
| 示例交通快照 | 81 | 81 | 7 |
| 示例医院快照 | 93 | 93 | 8 |
| 中国政府网 `gov.cn` | 378 | 195 | 22 |
| 中国铁路 `12306.cn` | **400（触顶）** | **145** | 23 |

**大页面必须处理。** `12306` 首页 400 个元素中只有 145 个可见 ——
建议先按 `visible=true` 过滤，再用 `groups` 聚类，最后才逐元素理解。不要把 400 个元素直接塞进 prompt。

---

## 五、你要产出的数据：`ui_schema.json`

**唯一真源**：[`docs/ui.schema.json`](../docs/ui.schema.json)。下表与它保持一致，若有出入**以 schema 文件为准**。
（下表与 A 组交接文件中的同名表格**逐字一致**，任何一方改动都必须同步两处并知会对方。）

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

### 图标集（A 组维护，当前 16 个）

```
home  calendar  document  payment  phone  user  search  location  bus  train
hospital  government  warning  info  help  back
```

**只能从这 16 个里选，或用 `null`。** 需要新图标必须走 A 组，不能自己发明。

---

## 六、你必须遵守的接口约定

**对 C（上游）**

1. **`source` / `page_url` 必须原样透传**，不得改写。A 靠它们判断是否显示降级提示。
2. **不要在 C 的输出里找"重要性"字段。** 没有，这是刻意的 —— 那是你的职责。
3. **`source="fallback"` 时你拿到的不是用户请求的真实网页**，而是演示快照。你仍应正常产出 `ui_schema`，但 `source` 要如实透传，让 A 提示用户。

**对 A（下游）**

4. **`action.target_element_id` 只能用 `el_` 开头的元素 ID**，且必须真实存在于 `elements[]`。
5. **`priority` 在同一份文档内不得重复**，否则 A 的渲染顺序不确定。
6. **`action.kind="form"` 时必须给 `form` 字段**，其他 kind 时必须给 `null`。
7. **`title` 是给老人看的**：动宾短语、无术语。把「预约挂号」写成「我要挂号」，把「门诊缴费」写成「缴费」。

**关于 ID 的一个关键边界**

> ⚠️ **`id` 只在「单份 elements.json 文档内」唯一。**
> ID 由结构路径派生，**两个结构相似的不同页面会产生相同的 ID**
> （实测：医院 / 政务 / 交通三个快照的登录表单都得到 `form_e15778ea`）。
> 这不是缺陷 —— 但如果你跨页面缓存了某份 `elements.json` 又去处理另一个页面，
> 这些 ID 会**静默指向错误元素，且不报任何错**。
> **每次处理都必须用当次拿到的那份 `elements.json`，不要跨页复用。**

---

## 七、常见陷阱

| 陷阱 | 后果 | 正确做法 |
|---|---|---|
| 把 `groups[].id` 当 `target_element_id` | A 在 `elements[]` 里查不到，交互失效 | `target_element_id` 只填 `el_` 开头的元素 ID |
| 把 400 个元素直接塞进 prompt | token 爆掉 / 关键元素被淹没 | 先按 `visible` 过滤，再用 `groups` 聚类 |
| 忽略 `groups`，只在扁平列表里按 `text` 猜 | 无法可靠识别「哪些字段属于同一表单」 | `groups` + `form_id` 是可靠抓手 |
| `priority` 重复 | A 渲染顺序不确定，同一数据两次跑结果不同 | 保证 1..N 互不重复 |
| 自己发明图标名 | 那批卡片全部退化为默认图标 | 只用冻结的 16 个，或用 `null` |
| 改写 `source` | A 静默展示演示数据，欺骗用户 | 原样透传 |
| 给 `subtitle` 填空串 `""` | A 会渲染出一个空的副标题行 | 无内容填 `null` |
| 用 `text` 而不用 `label` 取字段名 | 拿到「请输入18位身份证号」这种提示语当标签 | 用 `label ?? placeholder ?? name` |

---

## 八、联调前的自测清单

- [ ] 用 `docs/examples/elements.hospital.json` 能产出合规的 `ui_schema.json`
- [ ] 产出的 `cards` 覆盖了 `groups` 中的全部表单（医院快照应有 2 个表单：挂号 + 登录）
- [ ] 每个 `field.label` 都是「身份证号」这类短标签，不是「请输入18位身份证号」这类提示语
- [ ] 每个 `action.target_element_id` 都是 `el_` 开头，且能在 `elements[].id` 里查到
- [ ] `priority` 无重复，`card.id` 无重复
- [ ] `kind="form"` 的卡片都带了 `form` 字段
- [ ] `source` / `page_url` 与输入的 `elements.json` 完全一致
- [ ] 大页面（`12306`）不会因元素过多而失败
- [ ] **跑通校验工具**：

  ```bash
  cd backend
  python -m tools.check_ui --pair hospital        # 14 项必须全绿
  ```

- [ ] 你产出的 `ui_schema.gov.json` / `ui_schema.traffic.json` 放进 `docs/examples/` 后，
      `python -m tools.check_ui --pair gov --pair traffic` 同样全绿

---

## 九、我和 A 之间如何保证不冲突

`ui_schema.json` 是 A 和 B 唯一的接触面，任何一方私自改字段都会让对方返工。因此：

- **唯一真源**：`docs/ui.schema.json`。两份交接文件的字段表都从它抄录，若有出入以它为准。
- **可执行校验**：`backend/tools/check_ui.py` 会真的去 `elements.json` 里逐个查证你引用的每个 ID：

  ```bash
  python -m tools.check_ui --pair hospital
  ```

  它检查 14 项：`target_element_id` / `submit_element_id` / `field.element_id` 是否存在、类型是否正确、
  `priority` 是否重复、`card.id` 是否可追溯、`page_url` 与 `source` 是否一致、`kind` 与 `form` 是否配套。

- **流程约定**：你产出 `ui_schema.json` 后，在 `docs/examples/` 里配一份同名的
  `elements.{name}.json`，跑一遍工具。**14 项全绿再叫 A 联调。**

  > 实践验证：这个工具在 C 自己手写的样例上就抓到过一次真实冲突 ——
  > 把分组 ID `form_xxx` 误当成 `target_element_id` 填了。这种错误肉眼极难发现。

---

## 十、待你和 A 确认的事项（规范 §7 要求三人确认）

`docs/ui.schema.json` 是 C 代拟的，**它需要你和 A 真正认可才能冻结**：

1. `cards` + `priority` 这个结构，够不够表达"老人最需要的几个功能"？
2. `action.kind` 的四个取值够用吗？
3. `input_type` 的 9 个取值覆盖了你需要标注的表单类型吗？
4. `page.greeting` / `page.summary` 这两段文案，作为你的生成目标合适吗？
5. 是否同意把 `schema_version` 从 `0.1.0-draft` 升为 `1.0.0` 并冻结？

确认后由发起人改 `docs/ui.schema.json` 的 `const` 值并在 `docs/PROTOCOL.md` 追加变更记录。

---

## 十一、你现在就能用的东西

```bash
# 1. 直接读现成的 elements.json，不用启动任何服务
cat docs/examples/elements.hospital.json

# 2. 或者启动 C 的后端拿实时数据
cd backend
python -m uvicorn app.main:app --port 8000
curl -X POST http://127.0.0.1:8000/extract \
     -H "Content-Type: application/json" \
     -d '{"url":"https://demo.easyview.local/h","demo":"hospital"}'

# 3. 校验你的产出
python -m tools.check_ui --pair hospital
```

**降级兜底（规范 §9）**：如果 AI 调用失败，你应当退化为**规则模型**（例如直接按 `groups` 生成卡片、
按 `group.type=form` 优先排序）。C 的降级链路已经就位，你的降级由你实现。
