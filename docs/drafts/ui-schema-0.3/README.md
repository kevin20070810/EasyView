# ui_schema 0.3.0-draft：评审草案与人工标准样例

状态：**供 A/B/C 评审，尚未接入运行中的 Chrome 扩展**。本目录不会自动替换 `docs/ui.schema.json`（0.2.0-draft）或改变现有执行器。

本次交付包括可校验的 JSON Schema、三份人工编排参考样例、人工评审标准和独立的离线校验脚本。样例由助手根据现有快照起草，尚未经过团队确认或老人使用测试。“标准”表示拟采用的质量目标，不表示已证明适用于所有网站。

## 1. 文件与使用

| 文件 | 用途 |
|---|---|
| [ui.schema.json](ui.schema.json) | 0.3 草案的字段、枚举及条件约束 |
| [人工评审标准](golden_cases.json) | 每个场景的任务假设、必须保留项、排除项和禁止承诺 |
| [医院样例](examples/ui_schema.hospital.json) | 102 个采集元素 → 6 张任务卡 |
| [政务样例](examples/ui_schema.gov.json) | 80 个采集元素 → 7 张任务卡 |
| [交通样例](examples/ui_schema.traffic.json) | 81 个采集元素 → 7 张任务卡 |
| [validate.py](validate.py) | 草案结构、来源、动作约束的离线校验和负向自检 |

在项目根目录执行（使用 backend 已有的 jsonschema 依赖）：

```powershell
python -X utf8 -B docs/drafts/ui-schema-0.3/validate.py
python -X utf8 -B docs/drafts/ui-schema-0.3/validate.py --self-test
```

配对输入仍为 `docs/examples/elements.hospital.json`、`elements.gov.json`、`elements.traffic.json`，没有重新抓取网页。三者都是 `source=fallback`，地址属于 `demo.easyview.local`，数据、价格、排班和时间均是演示快照内容。**这些样例只供展示和验证，不能操作真实网站。**

## 2. 本版要交付的产品结果

用户进入敬老版后直接看见少量任务入口，能理解每张卡的用途和下一步。主界面不显示候选元素复选框、URL、CSS 选择器、模型参数或排序理由。

主卡最多 7 张；可以少于 5 张，找不到可靠任务时返回空状态。任务来自当前快照，不得按网站类别猜出原页面没有提供的服务。

流程：

```text
C：当前网页快照与分组
  → B：规则或模型提出任务、文案、意图、排序及证据引用
  → B 的绑定/策略程序：复制真实定位信息、计算风险和统计
  → 结构检查 + 来源交叉检查 + 文案初筛
  → 通过检查的 ui_schema
  → A：渲染；用户点击时执行器再次检查当前页面与目标
```

本版定义展示与原站引导的边界；不定义自动登录、代填、业务提交或支付能力。之后若增加这些能力，需要新的明确动作契约及验收。

## 3. 字段由谁负责

| 内容 | 权威来源 / 责任方 |
|---|---|
| 元素 ID、原文、URL、选择器、分组、可见性 | C 的本次快照 |
| title / subtitle / intent / icon、候选排序 | B 的规则或模型；须经过来源约束与质检 |
| priority | B 在最终筛选后编为连续 1…N；A 不自行重排 |
| input_snapshot、source、stats、generator | 实际处理程序计算或记录，不能相信模型自报 |
| provenance.quote、动作定位字段 | B 的绑定器从所引用元素回填，禁止模型编造 |
| risk、confirmation | 策略程序判定；模型只能提示，不得降低策略要求 |
| 文案展示、返回、展开原文、焦点管理 | A |
| 操作是否允许、目标是否仍有效 | 原页面执行器；schema 或用户确认不能绕过禁止动作 |

网页文本是待处理数据，不能当作系统指令。模型只应接收完成任务所需的脱敏标签、分组和上下文；账号密码、已填写的身份/付款数据、会话参数不进入模型或审计样例。

## 4. 顶层字段

保留 `schema_version / source_elements_schema_version / page_url / page_title / source / generated_at / page / cards`，新增：

| 字段 | 约定 |
|---|---|
| artifact_kind | `reference` 人工参考草案，或 `runtime` 实际生成结果 |
| final_url | 从 elements 原样复制实际落地地址；与请求 page_url 区分 |
| input_snapshot.sha256 | 对收到并保留的原始 elements JSON 字节计算 SHA-256；含原文件换行/BOM，不重新序列化再算 |
| input_snapshot.extracted_at | 原样复制输入的提取时间 |
| generator | reference 必须为 null；runtime 必须包含实际 mode、policy_version、prompt_version、fallback_reason |
| user_goal | 用户明确输入的目的；没有输入就是 null，不能把年龄或网站类别推断成用户陈述 |
| state / empty_reason | `ready` 至少一张卡、reason=null；`empty` 必须零张卡并说明原因 |
| stats | 输入元素数、可见数、截断标志、被引用的不同元素数、最终任务卡数 |

`generated_at` 是本份草案编排/实际结果生成的时间，不覆盖来源时间。演示快照的原有时间仍作为样例元数据保留，不作为当前信息有效性的证明。

`stats.input_elements = len(elements[])`；这不是原网页全部 DOM 节点数，也不是模型能力评分。若 C 截断过输入，必须透传 `input_truncated=true`，演示应说明是“已采集的 N 个元素 → M 项任务”，不能固定写成 400 → 7。

快照 SHA 用于配对一致性，**不证明网页真实性、权威性或数据仍然新鲜**。实际操作还需要当前页面身份与目标校验。

## 5. 卡片新增语义

### intent 与排序

固定意图：`query / apply / book / pay / contact / learn / help / warning`。它们是类别，不是全站固定排序。

`ranking` 保存有限的理由代码、简短说明和证据 ID，不保存模型内部推理：
- `user_goal_match`：用户明确目标，必须有非空 user_goal。
- `main_service`：所选场景的主要业务。
- `assistance`：联系、求助渠道。
- `source_warning`：来源确有提醒；这个标签本身不能证明当前有效。
- `supporting_information`：材料、地图、时间等辅助信息。

三份标准样例的场景假设写在 golden_cases.json；它们不声称系统知道某位老人真正想办什么。交通快照的施工通知缺乏已核实的有效期，因此不自动置顶，不写“当前预警”。

### provenance 与内容保真

每张卡包含：
- `source_element_ids`：所有支撑该卡的元素，必须含实际动作目标。
- `evidence[]`：本卡内唯一的证据 ID、元素 ID、字段名、完整 quote。
- `content_meta.title / subtitle`：分别记录 mode 和引用的证据。
- `facts[]`：需保留的原文事实，每项只能是 verbatim。

quote 必须等于同一快照元素的 `text / label / aria_label / placeholder` 对应字段全文。这里的“原文”是 C 已提取/规范化后的字段，不是原 HTML 字节。当前草案不支持任意截取片段或自行拼接片段冒充原文。

| mode | 含义 | 约束 |
|---|---|---|
| verbatim | 直接使用来源字段 | 一个证据、文字完全一致 |
| rewritten | 用易懂措辞表达已有意思 | 不新增功能、资格、金额、结果承诺；语义保真需人工/模型辅助评估 |
| generated | 新写的操作辅助说明 | 只能解释已允许的操作；不能新造价格、诊断、办理条件或实时状态 |

标题和副标题可采用不同模式。比如“查看报告”的标题可 verbatim；“请在原网页继续操作”属于 generated 的辅助说明。

facts 默认作为展开后的“查看原文”内容，不把长原文全部堆在主卡上。现有 C 将表格提成扁平文字，样例保留完整表格而不混拼不同列；它不等于已经实现可访问的结构化表格。后续若要逐行展示，必须补充表格行列来源契约。

### risk 与动作

风险描述的是该任务涉及的业务边界，不等于打开信息页面就会发生提交。domains 用于记录 healthcare / money / identity / external_handler。

| level | 本版允许范围 | confirmation |
|---|---|---|
| normal | 用户点击后执行允许的链接打开、滚动或原表单聚焦 | null |
| sensitive | 明确说明将打开/定位什么；用户确认后执行允许动作 | 必填对象，含说明、继续与取消文案 |
| blocked | 扩展不得代办；只显示原文、定位原内容或交还原站入口 | null，不提供解除阻止的确认按钮 |

所有级别都禁止程序点击未知业务按钮、原表单 submit、支付、退订、改变账号状态。normal 的“直接”指用户点击后可执行，不指生成时自动执行。确认界面必须有取消；取消没有原网页副作用。

风险代码的最小关系：
- normal：reason_codes 仅为 read_only。
- sensitive：personal_data 或 external_handler；不得同时出现 blocked 原因。
- blocked：至少包含 payment / medical_submission / identity_submission / unknown_effect 之一。
- intent=pay 必须 blocked，且包含 money 与 payment。
- medical_submission 必须 blocked + healthcare；identity_submission 必须 blocked + identity。
- 把风险字段写成 normal 不构成授权；运行时执行器必须使用自己的策略和允许列表复核。

### action 的明确语义（需要 A/B 确认的破坏性变更）

仍使用四个 kind，但本草案收紧并明确它们的行为：

| kind | 0.3 行为 | 定位信息 |
|---|---|---|
| navigate | 跟随同源的原始 HTTP(S) 链接 | 源 link 的 ID、selector、xpath、href 均回填 |
| external | 交还原始链接/电话处理程序；允许同源原站入口或经核验的跨站入口 | 同样必须有源 link 证据；href 原样绑定 |
| scroll | 仅滚动并聚焦原内容，不触发它的 click 事件 | href=null |
| form | 仅定位并聚焦原表单，让用户在原网页操作 | 目标 type=form，href=null；blocked 不允许此动作 |

本版只允许来源中的 HTTP(S) / tel 链接，禁止脚本协议、凭据 URL、下载或有未知副作用的入口。存在 href 只证明来源有这个链接；真实性、官方域名与导航是否改变业务状态仍需要执行策略核验。没有把任意跨站链接当成“官方”。

当前 v0.2 对 navigate 描述含糊，external 不要求引用 ID，form 带有回填和提交字段。本草案**不沿用自动提交语义**，也不携带 card.form / submit_selector 等字段；这是显式的能力收紧，不能在旧执行器上静默接受。后续如需表单重建，另行提案。

artifact_kind=reference 或 source=fallback 时，A 只能预览，不得把样例动作注入真实页面。用户点击 runtime/live 卡片时，执行器还须检查当前 URL/文档、源目标、链接和禁用状态；内容变化则重新生成，不跨页复用 selector。遇到匹配不唯一或不确定目标，停止操作。

## 6. 生成来源与兜底

generator.mode：
- model：任务组织和文案由实际模型输出，经程序绑定与检查。
- rules：实际规则生成；没有成功采用模型输出。
- hybrid：最终内容同时采用模型与规则的语义产出；普通 JSON 校验或回填 URL 不算 hybrid。

模型超时后全部退回规则应写 rules + timeout，不写 hybrid。source=live/fallback 描述输入来源，不能与 generator.mode 混为一谈。

人工标准样例用 reference + generator=null，避免声称模型或规则程序生成过它们。真实模型名称、延迟或成功率不得手填成演示成绩。

实际运行时建议设置一次有限修正机会；仍不通过则使用同一输入的规则结果，再执行同样的检查。规则结果也失败就呈现 empty。生成服务的重试、超时和密钥管理尚未实现，本目录没有模型调用。

## 7. 质检分工与失败处理

| 层 | 可以确定拒绝 | 不能据此声称 |
|---|---|---|
| JSON Schema | 超过 7 张卡、枚举错误、字段缺失、未知字段、风险确认形状不匹配 | 卡片有用、动作能在网页跑通 |
| 来源交叉检查 | 错快照、伪造 ID、改写原文、替换链接/selector、统计与输入不符 | 源页面本身真实可靠 |
| 文案初筛 | 标题过长、标题/副标题里的 URL、技术字段 | 一定符合中文动宾结构、一定被老人理解 |
| 语义与人工评审 | 功能夸大、关键任务遗漏、排序不合场景、歧义文案 | 任意长尾网站均能办成业务 |
| 原页执行器 | 目标已变化、动作被禁止、权限/状态不满足 | 仅凭协议文件就完成了执行保护 |

标题长度上限为 12 个 Unicode 字符，副标题 48 个；超限应重写，不能直接裁剪导致意思变化。术语初筛不能代替语义理解；“天气预警”等清楚表达可以作为评审允许的例外，不机械强改。

JSON Schema 失败时先停止处理，不能继续解引用字段导致异常。当前独立 validate.py 只验证本草案规定的可确定规则，并以明确错误返回。它没有实现模型语义判官或完整生产执行策略。

人工评审使用 golden_cases.json 中独立编排的 must_keep_card_ids、禁止承诺与排除理由。改写后的真实模型结果允许同义标题，不要求逐字复制样例；必须保留对应的任务和真实目标。语义评审未通过不得因为结构检查全绿而称为合格。

建议执行数据脱敏、原文完整性、提示注入和动作限制的负向评估。当前自检覆盖结构/引用/风险关系的变异，不证明模型抗提示注入或真实网站兼容性。

## 8. 迁移与验收顺序

1. A/B/C 评审本目录的字段、来源绑定、风险含义、form 能力收紧和参考样例。
2. B 建立同一绑定/质检入口，规则输出和模型输出都调用它；不要把现有 CLI 校验误当成运行时保护。
3. A 增加严格识别 0.3 的渲染/动作分发；未知版本必须拒绝，不能默默交给 0.2 执行器。
4. C 继续提供 1.1.0 的 elements；保留原始输入字节与快照配对。本次没有修改 elements 协议。
5. 用这些参考任务评估模型，再在真实网页验证布局、键盘操作、导航、确认取消与目标失效路径。
6. 三方确认后才提升现行协议、更新交接文件和运行代码；本目录保持评审历史，不作为另一套长期协议权威。

本轮完成条件：草案自洽；三份样例与各自真实快照配对；统计/原文/目标可核验；负向变异被拒绝；新旧版本边界明确。**本轮不宣称已经接入模型、替换扩展界面或完成老人可用性验证。**

