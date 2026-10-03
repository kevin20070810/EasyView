# EasyView 简界

EasyView 是一个 Chrome 扩展：在当前网页提取可见入口，生成少量面向老人的任务卡，并将用户带回原网页办理。它不代替原站登录、付款或提交。

**评委入口：**[打开 EasyView 体验页](https://ev.jvda.online/)并下载插件体验包。安装 Chrome 扩展后，在普通网页点击「敬老版」即可直接使用模型版，无需体验码。浏览器安装步骤见[扩展说明](easyview-extension/README.md)。

## 当前架构

| 路径 | 作用 |
|---|---|
| [easyview-extension](easyview-extension/) | 浏览器入口、页面提取、任务卡渲染、原站定位、朗读与放大 |
| [ai-service](ai-service/) | 接收压缩的页面说明书，调用模型生成任务草稿；另提供离线 `/analyze` 路径 |
| [docs/drafts/ui-schema-0.3](docs/drafts/ui-schema-0.3/) | 当前 0.3 协议、校验器、人工样例 |
| [docs/elements.schema.json](docs/elements.schema.json) | 页面元素数据契约 |
| [backend](backend/) | 本地 fixture 与开发校验工具；不是线上服务 |

通用流程：点击「敬老版」→ 扩展读取当前页面并压缩成说明书 → `POST /draft` → 扩展在本地绑定真实元素、校验风险并渲染卡片。模型服务不可用时，扩展可切换本地规则版。12306 另有针对购票流程的页面辅助代码。

## 本地使用

1. 在 Chrome 的 `chrome://extensions` 开启开发者模式，加载 `easyview-extension/`。
2. 扩展默认连接 `https://ev.jvda.online`，公开的 `/draft` 接口无需体验码。如需改用本地模型服务，在仓库根目录安装依赖并启动：

   ```powershell
   python -m pip install -r ai-service/requirements.txt
   $env:EASYVIEW_API_KEY = "你的模型密钥"
   python ai-service/app.py --host 127.0.0.1 --port 8787
   ```

3. 打开普通 HTTP(S) 网页，点击页面快捷入口或扩展图标。服务不可用或繁忙时，可选择本地规则版。

模型默认使用 OpenAI 兼容接口；`EASYVIEW_BASE_URL` 和 `EASYVIEW_MODEL` 可按服务商配置。密钥仅放环境变量，不写入仓库。

## 云端部署

见 [云服务器配置](ai-service/DEPLOY.md)。云服务器运行的是 `ai-service/`，扩展仍安装在用户的 Chrome 中。服务端只接收压缩后的页面文字；绑定目标与风险策略在扩展本地执行。

## 边界

- 卡片入口来自当前页面；业务数据、登录态、价格和可办理条件以原网页为准。
- 扩展不自动登录、代填敏感信息、代付或代提交。
- 通用网页的语义质量依赖当前页面结构与模型输出；生成后仍应核对原站。
- 本地 `backend/` 是开发工具，云端无需部署。
