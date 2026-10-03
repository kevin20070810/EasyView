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
| `EASYVIEW_ACCESS_TOKEN` | 保护内部 `/analyze` 接口；公开 `/draft` 不使用此令牌 | 无 |

公开 `/draft` 限制为每份说明书最多 4 万字符、每进程最多 4 个并发调用、每小时最多 120 次、24 小时内最多 500 次；计数在进程重启后清空。公开部署仍应在反向代理设置 HTTPS 和按来源限流，并为内部 `/analyze` 配置访问令牌。部署步骤见 [DEPLOY.md](DEPLOY.md)，接口说明见 [docs/api.md](docs/api.md)。

`/analyze` 使用 [0.3 协议校验器](../docs/drafts/ui-schema-0.3/validate.py)，所以需要安装 `jsonschema`。浏览器插件的主要请求链是 `/draft`。
