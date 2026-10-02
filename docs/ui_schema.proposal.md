# ui_schema.json 协议草案 v0.1

> 状态：**草案，待 B / C 两位同学确认后再冻结**
> 本文档描述 A 模块（前端渲染引擎）读取的输入协议。正式冻结文件应为 `docs/ui.schema.json`。

## 1. 顶层结构

一份 `ui_schema.json` 描述一个「适老化页面」，由标题和组件列表组成：

```json
{
  "title": "页面标题",
  "subtitle": "可选副标题",
  "components": [ ... ]
}
```

渲染引擎按 `components` 数组顺序从上到下渲染。为了兼容任务书里的极简写法，也允许顶层直接是一个组件对象：

```json
{ "type": "ActionGroup", "items": ["我要挂号"] }
```

## 2. 组件字段

### ActionGroup 核心操作

大按钮组，用于挂号、缴费这类主操作。建议 `items` 不超过 5 个。

```json
{
  "type": "ActionGroup",
  "title": "常用服务",
  "items": ["我要挂号", "查看报告", "门诊缴费"]
}
```

### InfoCard 重要信息

展示一条重要信息，例如门诊时间、地址。

```json
{
  "type": "InfoCard",
  "title": "门诊时间",
  "content": "周一至周五 8:00 - 17:00"
}
```

### FormStep 流程步骤

展示办理流程。`steps` 每个元素可以是字符串，也可以是带说明的对象。

```json
{
  "type": "FormStep",
  "title": "预约挂号流程",
  "steps": ["选择科室", "选择医生", "确认预约"]
}
```

```json
{
  "type": "FormStep",
  "title": "预约挂号流程",
  "steps": [
    { "label": "选择科室", "desc": "内科 / 外科 / 儿科" },
    { "label": "选择医生", "desc": "查看排班" }
  ]
}
```

### ContactCard 联系方式

展示联系方式，`phone` 会渲染成可点击的 `tel:` 链接。

```json
{
  "type": "ContactCard",
  "title": "客服中心",
  "phone": "0755-12345678",
  "hours": "8:00 - 20:00"
}
```

### Collapse 折叠次要信息

隐藏次要信息，默认折叠，点击展开。

```json
{
  "type": "Collapse",
  "title": "更多服务",
  "items": ["报告查询", "住院办理", "医保咨询"]
}
```

## 3. 默认兜底

遇到未知的 `type` 时，渲染引擎会使用「默认组件」输出一个占位卡片，保证页面不崩溃。

## 4. 待确认事项

- 文件名是 `ui.schema.json` 还是 `ui_schema.json`。
- 各字段命名是否符合 B 模块的输出习惯。
- 是否需要 `theme`、`accentColor` 等额外页面级字段。
