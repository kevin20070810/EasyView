# EasyView 公共协议说明（C 组代拟 v1.0.0）

> **状态**：`elements.schema.json` 建议冻结；`ui.schema.json` 为 **草案**，待 A/B 确认。
> **依据**：《EasyView 统一协作开发规范 v2.0》§7 —— 核心协议文件任何修改必须三人确认。
> **起草**：C 组（Backend Engineer）

---

## 0. 为什么要先冻结协议

规范 §2 的架构是一条单向流水线，三个模块**并发开发、靠 JSON 解耦**：

```
URL ──[C]──> elements.json ──[B]──> ui_schema.json ──[A]──> 适老页面
```

三个模块的"禁止清单"意味着**谁都不能偷偷跨层补救**：C 不许调 AI，A 不许解析网页。
所以一旦 JSON 字段对不上，不存在"某个人顺手兼容一下"的选项，只能停下来改协议 —— 48 小时里这是最贵的返工。

**本文件的目的就是把这个返工提前消灭。**

---

## 1. `elements.schema.json` —— C → B 契约

### 1.1 相对任务书 §6 做了哪些扩展，以及为什么

任务书 §6 给出的骨架是：

```json
{ "page_url": "", "page_title": "", "elements": [ { "id": "", "type": "", "text": "", "xpath": "" } ] }
```

它**原样无法支撑 B 的核心任务**。逐条说明扩展理由：

| # | 缺口 | 后果 | 扩展方案 |
|---|---|---|---|
| 1 | `type` **没有取值枚举** | B 靠 type 判断功能、A 靠 type 选组件，各写各的必然炸 | 冻结 16 个枚举值（见 §1.2） |
| 2 | **没有分组信息**（最致命） | B 要产出「我要挂号 / 查看报告 / 缴费 / 联系客服」，但扁平列表里**看不出哪些元素同属一个表单或一块导航**，只能靠 text 硬猜 | 新增顶层 `groups[]` + 元素级 `group_id` / `form_id` |
| 3 | `text` 语义不明 | 图标按钮没有 innerText；B 拿到的可能是空串 | 冻结取值优先级：`aria-label > innerText > placeholder > value > alt > title` |
| 4 | **`id` 无生成规则** | ui_schema 要引用 element_id，id 每次解析都变 → A 渲染错乱 | 冻结为 `el_ + sha1(selector)[:8]`，**同页重复解析结果一致** |
| 5 | 缺表单控件属性 | B 无法把「身份证号输入框」和它的提交按钮关联，A 无法选输入组件 | 新增 `placeholder` / `name` / `value` / `required` / `in_form` / `form_id` |
| 6 | 缺链接目标 | B 判断"这个入口通向哪"没有依据 | 新增 `href`（已解析为绝对 URL） |
| 7 | 缺可见性 | 隐藏元素会污染 B 的判断，也会让 A 高亮错位置 | 新增 `visible` + `bbox` |
| 8 | 缺顺序 | JSON 数组顺序不保证等于视觉顺序 | 新增 `order`（DOM 文档序，从 0 开始） |
| 9 | **降级无法区分** | 规范 §9 要求解析失败用 Demo 数据，但 B/A 无从得知拿到的是真数据还是兜底数据 | 新增 `source: live \| fallback` + `fallback_reason` |
| 10 | 无版本号 | 联调时字段错位无法定位 | 新增 `schema_version`，并保留 `extensions` 逃生舱 |
| 11 | **输入框与中文标签无关联** | 如 `就诊日期` 这类 date input 的 `text` 为空串，B 只能靠文档序猜测字段含义 | 新增 `label`（按 `label[for]` > 包裹式 `label` > `aria-label` > `aria-labelledby` > 紧邻 `label` 客观查询） |
| 12 | **隐藏元素挤占预算** | 实测 12306 首页 400 个元素中仅 107 个可见；若不按可见性分级，截断后 B 拿到的多是页面上根本看不到的元素 | 截断优先级改为「可见交互 > 可见文本 > 隐藏交互 > 隐藏文本」 |

### 1.2 `type` 枚举（冻结）

```
button  link  input  textarea  select  checkbox  radio  submit
form    heading  text  image  nav  table  iframe  other
```

**判定原则：只看 DOM 客观结构，不看语义重要性。**
例如"挂号"按钮和页面角落的"版权声明"链接，type 分别是 `button` 和 `link` —— 哪个更重要是 **B 的判断**，C 绝不越界（任务书 §9）。

### 1.3 稳定 ID 规则（冻结）

```
element.id  = "el_"   + sha1(selector).hexdigest()[:8]
form group  = "form_" + sha1(selector).hexdigest()[:8]
其他 group  = "grp_"  + sha1(selector).hexdigest()[:8]
```

**保证**：同一页面无论解析多少次、无论谁解析，同一个 DOM 节点拿到的 id 恒定。
**因此** B 可以安全地把 `target_element_id` 写进 ui_schema，A 可以安全地拿它去原页面高亮。

> ⚠️ **重要边界：ID 只在「单份 elements.json 文档内」唯一。**
>
> ID 由结构路径派生，因此**两个结构相似的不同页面可能产生相同的 ID**
> （实测：hospital / gov / traffic 三个快照的登录表单都得到 `form_e15778ea`）。
> 这不是缺陷，但如果 B 缓存了 A 页的 `ui_schema.json` 又把它套用到 B 页，
> 这些 ID 会**静默匹配到错误元素**，且不报任何错。
>
> **联调约定**：`ui_schema.json` 必须与它对应的那一份 `elements.json` 成对使用。
> 建议 A 在渲染前校验 `ui_schema.source_elements_schema_version` 与
> `elements.schema_version` 一致，并始终以 B 当次响应的数据为准，不要跨页复用缓存。


### 1.4 关于 `groups` —— B 最需要的东西

这是本次扩展中**对 B 价值最高**的一项。举例，一个医院页面挂号表单会被解析为：

```json
{
  "groups": [
    { "id": "form_3a91c2de", "type": "form", "label": "预约挂号",
      "element_ids": ["el_11aa22bb", "el_33cc44dd", "el_55ee66ff"] }
  ],
  "elements": [
    { "id": "el_11aa22bb", "type": "input", "text": "身份证号", "form_id": "form_3a91c2de", "required": true, ... },
    { "id": "el_33cc44dd", "type": "input", "text": "手机号",   "form_id": "form_3a91c2de", "required": true, ... },
    { "id": "el_55ee66ff", "type": "submit", "text": "提交预约", "form_id": "form_3a91c2de", ... }
  ]
}
```

B 因此可以直接回答："这三个字段属于同一个动作，一起构成『我要挂号』这张卡片" —— 而不必猜。

### 1.5 截断策略与 `visible` 字段

超大页面的元素数会撑爆 B 的 token 预算，因此设上限 `EASYVIEW_MAX_ELEMENTS`（默认 400），
超出时按以下优先级保留：

```
可见的交互/结构元素  >  可见文本  >  隐藏的交互/结构元素  >  隐藏文本
```

**隐藏元素不会被丢弃，只是排在最后。** 这是刻意的设计：

- 弹窗、折叠面板、标签页里的表单往往才是核心功能 —— 实测 **12306 首页的购票表单就位于
  `display:none` 的容器中**，若按可见性直接过滤，整个购票链路就没了；
- 每个元素都带 `visible` 标记，**过滤权交给 B**，C 只提供客观事实。

> **给 B 的建议**：优先处理 `visible=true` 的元素；当 `stats.truncated=true` 时，
> 建议先只看可见元素，再按需取用隐藏元素。
> 实测 `https://www.12306.cn/` 的产出中可见元素仅 145/400（36%）——
> 该比例由页面自身决定，不是解析缺陷。

---

## 2. `ui.schema.json` —— B → A 契约（草案，待确认）

规范 §7 把 `docs/ui.schema.json` 列为冻结协议，但**两份原始文档中从未定义它的任何字段**。
A 没有这个契约就无法开工，因此 C 组代拟草案。

核心设计：B 输出**大按钮卡片列表**，A 做**纯渲染**。

```json
{
  "schema_version": "0.1.0-draft",
  "page": { "greeting": "您好，这里是 XX 医院网上服务", "summary": "可以挂号、查报告、缴费" },
  "cards": [
    { "id": "form_3a91c2de", "title": "我要挂号", "priority": 1,
      "icon": "calendar",
      "action": { "kind": "form", "target_element_id": "el_55ee66ff" },
      "form": { "submit_element_id": "el_55ee66ff",
                "fields": [ { "element_id": "el_11aa22bb", "label": "身份证号",
                              "input_type": "idcard", "required": true } ] } }
  ]
}
```

严格对应规范 §1 的示例界面：`我要挂号 / 查看报告 / 缴费 / 联系客服` 就是四张 `cards`。

**注意**：`priority` 由 **B** 填写 —— 这是规范明文划给 B 的"功能重要程度判断"。A 只按 `priority` 排序渲染，不重新判断。

---

## 3. 边界自查清单（提交前必查）

C 组代码**不得**出现以下行为（规范 §3、任务书 §9）：

- [ ] 调用任何 AI / LLM 接口
- [ ] 给元素打分、排序、判断"哪个功能对老人最重要"
- [ ] 生成 HTML / CSS / 页面结构
- [ ] 决定卡片标题措辞（例如把"预约挂号"改写成"我要挂号"—— 这是 B 的活）

C 组**只做**：访问网页 → 解析 DOM → 客观描述 → 输出 JSON。

---

## 4. 变更流程

`docs/elements.schema.json` 与 `docs/ui.schema.json` 属冻结协议。
任何字段增删改：**三人确认**后，由发起人提升 `schema_version` 并在此文件追加变更记录。

### 变更记录

| 版本 | 日期 | 变更 | 确认人 |
|---|---|---|---|
| 1.0.0 | 待定 | C 组起草 elements 协议扩展；ui 协议草案 | 待 A/B/C 确认 |
