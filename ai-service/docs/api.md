# HTTP 接口

服务默认监听 `127.0.0.1:8787`。公开部署时由 HTTPS 反向代理转发，不直接开放 8787。若设置 `EASYVIEW_ACCESS_TOKEN`，所有 POST 请求须带 `Authorization: Bearer <token>`；令牌错误返回 401。

## `GET /health`

返回 `ok`、`service`、`schema_version`、`ai_configured`、`model` 和 `reasoning`。不调用模型。

## `POST /draft`

扩展当前使用的接口。请求体：

```json
{"digest": "[page] ..."}
```

成功返回 `{"ok": true, "draft": {...}, "prompt_version": "..."}`。加 `?debug=1` 时额外返回耗时、用量和说明书字数。此接口需要配置模型密钥；它只返回语义草稿，不包含原站定位字段。扩展在本地绑定元素并校验后才渲染卡片。

## `POST /analyze`

离线分析接口。请求体直接为 `elements.json`，或 `{"elements_data": {...}, "_easyview_ai": true}`。默认走规则生成；加 `?ai=1` 或设置 `_easyview_ai` 才调用模型。成功返回 `{"ok": true, "data": <ui_schema 0.3>}`。加 `?debug=1` 时返回诊断摘要。

`/analyze` 调用 [0.3 校验器](../../docs/drafts/ui-schema-0.3/validate.py)，需要安装 `jsonschema`。当前扩展主路径使用 `/draft`。

## 错误与数据边界

错误统一为 `{"ok": false, "error": {"code": "...", "message": "..."}}`。常见状态：400 请求错误、401 令牌无效、413 体积超限、422 元素不合规、503 模型不可用、500 服务内部错误。

服务不记录请求体，响应带 `Cache-Control: no-store`。日志只应包含请求路径与状态，不应放入页面正文。浏览器扩展生成的说明书不含已填写的表单值；网页原文仍可能包含个人信息，部署者需控制访问和模型服务的数据处理设置。
