# ui_schema.json 协议修订提案（C 组提出）

> 状态：**待 A / B 确认**。依据规范 §7，冻结协议的修改必须三人确认。
> 提出人：C 组（后端）　针对版本：`ui.schema.json v0.1.0-draft` / `elements.schema.json v1.0.0`
> 关联：A 组的 [`ui_schema.proposal.md`](ui_schema.proposal.md)（v0.1 早期结构提案）

---

## 背景：三方会合后实测出的两个断点

A / B / C 三个分支会合后，我做了完整的接口验证。**数据形状层面三方完全兼容**：

| 验证项 | 结果 |
|---|---|
| A 的校验器吃 B 的真实产出 | ✅ 三份全部 `ok`，**0 错误 0 警告** |
| 图标集 | ✅ A 的 16 个与协议冻结的 16 个**完全一致** |
| 字段名 / 类型 / 枚举 | ✅ 完全对齐（A 是照交接文件字段表实现的） |
| C → B | ✅ `check_ui` 14/14 × 3 |

**但运行时有两个断点，光看 JSON 形状发现不了。**

---

## 断点 1（严重）：`target_element_id` 无法映射回 DOM

### 现象

A 的 `extension/src/renderer.js`（L185-195）这样定位目标元素：

```js
function resolveTargetElement(id, options) {
  if (options && typeof options.resolveElement === "function") { ... }   // 无人注入
  var root = (options && options.searchRoot) || document;
  if (root.getElementById) return root.getElementById(id);               // ← 恒为 null
  ...
}
```

而 C 的 `properties.id` 是 **`el_` + `sha1(selector)[:8]` 派生哈希，不是 DOM 的 `id` 属性**。
`elements.json` 之所以带 `selector` / `xpath`，正是因为 ID 无法反查 DOM。

### 实测证据

用 C 的真实 `elements.json` 配 B 的真实产出：

```
B 产出的 target_element_id  ->  getElementById 能否找到？
  el_6f230879   -> DOM 无 id         ★ 找不到
  el_816c3fc2   -> DOM 无 id         ★ 找不到
  el_d4e15498   -> DOM 无 id         ★ 找不到
  el_20acb35b   -> DOM 无 id         ★ 找不到
  el_c8dc41cb   -> DOM 无 id         ★ 找不到
  el_e64c55d5   -> DOM 无 id         ★ 找不到
```

表单字段同理：

```
  el_1ccf3fbc  ->  DOM 实际 id = name      label=就诊人姓名
  el_3a19b50d  ->  DOM 实际 id = idcard    label=身份证号
  el_f2848cc3  ->  DOM 实际 id = phone     label=手机号码
```

**6/6 全部失败，成功率 0%。**

### 后果

A 点任何卡片都会走到兜底分支，弹出 A 自己写的提示：
「未找到页面元素：el_xxx（请检查 B 产出的 target_element_id）」

**但 B 没有错，A 也没有错 —— 是我（C）的协议漏了东西。**
`ui_schema.json` 要求 A「点击后操作元素 el_xxx」，却从头到尾没给 A 定位它的手段。
A 不持有 `elements.json`（B 的 `/analyze` 收 elements、只吐 ui_schema），所以拿不到 `selector`。

### 这是 C 的责任

C 无法在协议外补救：A 只能收到 `ui_schema.json` 这一份文档。

---

## 断点 2（中等）：`select` / `radio` / `checkbox` 没有选项数据

A 已在 `extension/README.md`「已知边界」第 2 条记录了这个问题：

> 协议未定义 `form.fields[].options`。`select` / `radio` / `checkbox` 在没有选项时退化为文本输入。

实测确认**两层都缺**：

```
C 的 elements.json：
  el_3ce58500  type=select  label=就诊科室
    text       = '请选择科室 内科 外科 儿科 妇科 骨科'
    有 options 字段? 否 ← 缺失

协议的 form.fields：
  field 的属性: element_id, label, input_type, placeholder, required
  含 options? 否 ← 缺失
```

C 把选项**当纯文本拼进了 `text`**，结构化信息在提取阶段就丢了。
所以这不是 B 能补的 —— 源头在 C。

---

## 提案

### 提案 1：在 `ui_schema.json` 中补上定位信息

**理由**：让 `ui_schema.json` 自给自足。A 不需要再持有 `elements.json`，数据流不变。

`$defs.action` 新增两个字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `target_selector` | string \| null | 条件必填 | `kind != "external"` 时必填。取自 `elements[].selector`。**A 必须优先用它定位** |
| `target_xpath` | string \| null | ❌ | 可选兜底。`selector` 失效时使用，取自 `elements[].xpath` |

`$defs.form` 新增：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `submit_selector` | string | ✅ | `submit_element_id` 对应的 CSS 选择器 |

`$defs.field` 新增：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `selector` | string | ✅ | 该字段元素在宿主页面上的 CSS 选择器 |

修订后示例：

```json
{
  "id": "form_6f230879",
  "title": "我要挂号",
  "priority": 1,
  "action": {
    "kind": "form",
    "target_element_id": "el_6f230879",
    "target_selector": "body > div:nth-of-type(3) > div:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(1) > form",
    "target_xpath": "/html[1]/body[1]/div[3]/div[1]/div[2]/div[1]/div[1]/form[1]",
    "href": null
  },
  "form": {
    "submit_element_id": "el_0a5dde7d",
    "submit_selector": "body > ... > button:nth-of-type(1)",
    "fields": [
      {
        "element_id": "el_1ccf3fbc",
        "selector": "#name",
        "label": "就诊人姓名",
        "input_type": "text",
        "placeholder": "请输入就诊人真实姓名",
        "required": true
      }
    ]
  }
}
```

**为什么保留 `target_element_id`**：它是跨模块追溯与去重的锚点（`card.id` 也引用它）。
但它的语义要写清楚：**只用于追溯，不得用于 `document.getElementById`**。

### 提案 2：在 `elements.json` 中补上选项提取

`$defs.element` 新增：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `options` | array \| null | ❌ | 仅 `select` / `radio` / `checkbox` 有值，其他类型为 null |

```json
"options": {
  "type": ["array", "null"],
  "items": {
    "type": "object",
    "required": ["label", "value"],
    "additionalProperties": false,
    "properties": {
      "label":  { "type": "string", "description": "给老人看的选项文字，如「内科」" },
      "value":  { "type": "string", "description": "选项提交值，取自 <option value>" },
      "selected": { "type": "boolean", "description": "解析时刻是否已选中" }
    }
  }
}
```

- `select`：遍历 `<option>`，`label` 取文本，`value` 取 `value` 属性（缺省回落为文本）
- `radio` / `checkbox`：按相同 `name` 分组，各 input 即为一个 option

**边界自查**：提取 `<option>` 是纯客观 DOM 事实读取，不含「哪个选项更重要」的判断，
不越 C 组边界（规范 §3 / 任务书 §9）。✅

同址 `ui_schema.json` 的 `$defs.field` 相应新增：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `options` | array \| null | 条件必填 | `input_type` 为 `select` / `radio` / `checkbox` 时必填，其他为 null。B 从元素的 `options` 透传 |

---

## 版本与影响面

| 文件 | 版本变化 | 说明 |
|---|---|---|
| `docs/elements.schema.json` | `1.0.0` → `1.1.0` | 新增可选字段 `options`，向后兼容 |
| `docs/ui.schema.json` | `0.1.0-draft` → `0.2.0-draft` | 新增定位与选项字段 |
| `backend/app/models.py` | — | `schema_version` 常量与 `Element.options` |
| `backend/app/extract_dom.js` | — | 提取 `<option>` / 同 name 分组 |
| `ai-service/builder.py` | — | 透传 `selector` / `xpath` / `options` |
| `extension/src/renderer.js` | — | `resolveTargetElement` 改用 `target_selector`；`ELEMENTS_VERSION` 改 `"1.1.0"` |

**三方改动都很小**，且 C 侧的 `selector` / `xpath` **本来就已经产出**，B 只需搬运。

---

## 三方确认清单

请 A / B 分别确认：

**给 A（前端）**

1. 同意用 `target_selector`（CSS 选择器 + `querySelector`）替代 `getElementById` 吗？
2. `target_xpath` 是否需要？还是只用 `selector` 就够？
3. `form.fields[].options` 的结构（`label` / `value` / `selected`）够用吗？
4. 同意把 `ELEMENTS_VERSION` 常量升到 `"1.1.0"` 吗？
5. `frontend/` 早期原型是你自行声明废弃的 —— 需要我协助清理，还是先保留？

**给 B（AI）**

1. 新增字段是从 `elements.json` **原样透传**，不涉及任何判断，确认工作量可接受吗？
2. `source_elements_schema_version` 将变为 `"1.1.0"`，确认同步更新？
3. 上一轮我提出的真实站点卡片标题退化问题（新闻/广告文案原样透出），是否一并处理？

**给 C（后端，即我）**

- [ ] 确认后实施 `extract_dom.js` 的 `<option>` 提取
- [ ] 提升两个 schema 版本号并在 `docs/PROTOCOL.md` 追加变更记录
- [ ] 给 `check_ui.py` 增加「`target_selector` 必须能在 elements.json 中找到对应元素」的校验项
- [ ] 回归全部自检（selfcheck / check_ui / check_docs）

---

## 附：不采纳的方案及理由

| 方案 | 不采纳理由 |
|---|---|
| A 同时接收 `elements.json`，自行按 ID 查 `selector` | 数据流变成两文档，A 需做 join；payload 翻倍；B 的 `/analyze` 契约要改 |
| 定义「ID → DOM」的标准算法，A 重算 sha1 匹配 | A 必须复刻 C 的选择器生成算法，两处实现必然漂移；且查找是 O(n) 全页扫描 |
| 让 C 把 ID 直接写成 DOM 的 `id` 属性（改页面） | 违反规范 §3「C 禁止修改网页」；且会污染宿主页面 |
