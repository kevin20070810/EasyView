# EasyView B 组 · AI 理解模块

把 C 组输出的 `elements.json` 转为 A 组可直接渲染的 `ui_schema.json`。

## 设计原则

- **规则引擎保底**：不联网、没有 API Key 也能生成合规结果。
- **AI 只做语义增强**：模型只能修改已有卡片的标题、副标题和顺序，不能改 ID、动作和表单结构。
- **失败即降级**：模型超时、返回脏 JSON 时自动回到规则结果。
- **适老化优先**：挂号、报告、缴费、医保、办事、公交等常用功能优先；新闻、公告、介绍和推广降级或过滤。
- **一屏最多 6 张卡片**：`priority` 从 1 连续编号，A 无需重新判断。

## 快速开始

```powershell
# 无模型，纯规则运行
python .\ai-service\app.py --file .\docs\examples\elements.hospital.json --output .\out.json

# 启动 HTTP 服务
python .\ai-service\app.py --host 127.0.0.1 --port 8787

# 可选：启用模型增强
$env:EASYVIEW_API_KEY = "你的密钥"
$env:EASYVIEW_BASE_URL = "https://api.openai.com/v1"
$env:EASYVIEW_MODEL = "gpt-4.1-mini"
python .\ai-service\app.py --file .\docs\examples\elements.hospital.json --ai
```

接口与字段说明见 [docs/api.md](docs/api.md)。

## 验证

```powershell
python -m unittest discover -s .\ai-service\tests -v
python .\ai-service\tools\generate_examples.py

cd backend
python -m tools.check_ui --elements ..\docs\examples\elements.hospital.json --ui ..\ai-service\examples\ui_schema.hospital.json
python -m tools.check_ui --elements ..\docs\examples\elements.gov.json --ui ..\ai-service\examples\ui_schema.gov.json
python -m tools.check_ui --elements ..\docs\examples\elements.traffic.json --ui ..\ai-service\examples\ui_schema.traffic.json
```

当前结果：

| 样例 | 卡片顺序 | 官方校验 |
|---|---|---|
| 医院 | 我要挂号 → 查看报告 → 缴费 → 医保查询 → 联系客服 → 就医指南 | 14/14 |
| 政务 | 查办事指南 → 社保医保 → 办医保 → 查公积金 → 查社保缴费 → 养老助残 | 14/14 |
| 交通 | 查违章 → 办证件 → 联系客服 → 查公交 → 坐地铁 → 打车 | 14/14 |

## 目录

```text
ai-service/
├── app.py                       # HTTP 服务 + CLI
├── builder.py                   # 确定性卡片规则引擎
├── pipeline.py                  # AI 增强 + 失败降级
├── llm_client.py                # OpenAI 兼容接口客户端
├── prompts/analyze.prompt.md    # 模型提示词
├── examples/                    # 三组 ui_schema 联调结果
├── tests/test_pipeline.py       # 自动化测试
└── docs/api.md                  # HTTP / CLI 接口说明
```