# EasyView 页面理解服务

Chrome 扩展当前使用 `POST /draft`：发送压缩后的页面说明书，服务调用模型并返回任务草稿。元素绑定、风险判定和 0.3 协议生成在扩展本地完成。服务还保留 `POST /analyze`，供离线元素数据分析与校验使用。

## 本地启动

在仓库根目录：

```powershell
python -m pip install -r ai-service/requirements.txt
$env:EASYVIEW_API_KEY = "模型服务密钥"
python ai-service/app.py --host 127.0.0.1 --port 8787
```

`GET /health` 可查看服务是否运行及模型是否配置。没有 `EASYVIEW_API_KEY` 时，`/draft` 返回 503；扩展会提供本地规则版入口。命令行 `--file` 分析可直接使用规则版。

| 环境变量 | 作用 | 默认值 |
|---|---|---|
| `EASYVIEW_API_KEY` | 模型服务密钥；启用 `/draft` 必需 | 无 |
| `EASYVIEW_BASE_URL` | OpenAI 兼容接口地址 | `https://api.deepseek.com/v1` |
| `EASYVIEW_MODEL` | 模型 ID | `deepseek-flash` |
| `EASYVIEW_TIMEOUT` | 模型请求超时，秒 | `60` |
| `EASYVIEW_REASONING` | `off/low/high/max` | `off` |
| `EASYVIEW_JSON_MODE` | 是否发送 JSON 模式参数 | `0` |
| `EASYVIEW_ACCESS_TOKEN` | 非空时，要求所有 POST 请求携带 `Authorization: Bearer <token>` | 无 |

公开部署必须配置访问令牌，并在反向代理设置 HTTPS 和请求限流。部署步骤见 [DEPLOY.md](DEPLOY.md)，接口说明见 [docs/api.md](docs/api.md)。访问令牌只适合内部演示或受控团队，不是面向公众的用户账户体系。

`/analyze` 使用 [0.3 协议校验器](../docs/drafts/ui-schema-0.3/validate.py)，所以需要安装 `jsonschema`。浏览器插件的主要请求链是 `/draft`。
