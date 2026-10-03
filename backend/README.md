# 本地校验资料

`backend/` 不运行线上服务。网页提取由 Chrome 扩展的 `src/extract.js` 完成。这里保留本地 HTML fixture 和开发校验工具，云服务器不用部署本目录的代码。

- `fixtures/`：医院、政务、交通和通用网页的本地页面；扩展的提取检查工具会读取。
- `app/config.py`：fixture 路径与元素上限。
- `tools/selfcheck.py`：检查 `docs/examples/elements.*.json` 与元素协议。
- `tools/check_extract_live.py`：通过浏览器检查页面内提取。
- `tools/check_port_fidelity.py` / `check_float_repr.py`：核对 Python 与 JS 的 digest、binder 行为。

如需运行浏览器校验，安装 [requirements.txt](requirements.txt) 并按 Playwright 文档安装浏览器。当前输出协议的服务端校验器在 `docs/drafts/ui-schema-0.3/validate.py`。
