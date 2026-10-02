# EasyView B 组接口说明

协议版本：`ui_schema.json v0.1.0-draft`

## HTTP 服务

启动：

```powershell
python .\ai-service\app.py --host 127.0.0.1 --port 8787
```

### GET /health

```json
{
  "ok": true,
  "service": "easyview-ai",
  "schema_version": "0.1.0-draft",
  "ai_configured": false
}
```

### POST /analyze

请求体直接传 C 组的 `elements.json`。默认只使用规则引擎。

```powershell
$body = Get-Content -Raw .\docs\examples\elements.hospital.json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/analyze -ContentType application/json -Body $body
```

成功响应：

```json
{
  "ok": true,
  "data": {
    "schema_version": "0.1.0-draft",
    "source_elements_schema_version": "1.0.0",
    "page_url": "https://example.com/",
    "page_title": "页面标题",
    "source": "fallback",
    "generated_at": "2026-10-02T10:35:00+08:00",
    "page": {
      "greeting": "您好，这里是页面标题",
      "summary": "这里可以我要挂号、查看报告、缴费"
    },
    "cards": []
  }
}
```

启用模型增强时加查询参数：

```text
POST /analyze?ai=1
```

模型不可用会返回 `503 ai_unavailable`，不自动静默调用。命令行和单元测试中的降级路径仍保证基础功能可用。

### 错误格式

```json
{
  "ok": false,
  "error": {
    "code": "invalid_elements",
    "message": "缺少必填字段: page_url"
  }
}
```

| HTTP | code | 说明 |
|---|---|---|
| 400 | `bad_request` | 请求体不是合法 JSON |
| 413 | `bad_request` | 请求体为空或超过 8MB |
| 422 | `invalid_elements` | elements 数据不满足最小构造条件 |
| 503 | `ai_unavailable` | 请求了 AI，但配置或连接失败 |
| 500 | `internal_error` | 未预期错误 |

## 命令行

```powershell
python .\ai-service\app.py --file .\docs\examples\elements.hospital.json
python .\ai-service\app.py --file .\docs\examples\elements.hospital.json --output .\out.json
python .\ai-service\app.py --file .\docs\examples\elements.hospital.json --ai
```

## AI 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `EASYVIEW_API_KEY` | 启用 AI 时必填 | 无 | API 密钥 |
| `EASYVIEW_BASE_URL` | 否 | `https://api.openai.com/v1` | OpenAI 兼容接口地址 |
| `EASYVIEW_MODEL` | 否 | `gpt-4.1-mini` | 模型名 |
| `EASYVIEW_TIMEOUT` | 否 | `20` | 超时秒数 |
| `EASYVIEW_JSON_MODE` | 否 | `0` | 设为 `1` 时发送 JSON 模式参数 |

## 安全边界

- 模型永远不能构造新的元素 ID。
- AI 返回值由 `pipeline.apply_ai_hints()` 做白名单校验。
- 最终 JSON 始终由 `builder.py` 组装。
- 不生成 HTML/CSS，不控制浏览器，不修改原网页。