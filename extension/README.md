# EasyView 浏览器插件前端（A 组 Demo）

把 `ui_schema.json`（v0.1.0-draft）渲染成老人能用的页面。Manifest V3 扩展，用 Shadow DOM 注入，宿主网站样式不会被污染。

## 目录

```
extension/
├── manifest.json           MV3 清单
├── background.js           service worker（默认偏好、打开 Demo）
├── src/
│   ├── icons.js            冻结图标集 16 个 + 默认图标兜底
│   ├── renderer.js         协议校验 + 渲染引擎（本模块的核心）
│   ├── styles.css          适老渲染层样式
│   └── shell.css           插件外壳（悬浮入口、全屏适老视图）
├── content/content.js      content script：Shadow DOM 注入、一键开关
├── popup/                  工具栏控制面板
├── data/
│   ├── schemas.js          三份 demo 数据（医院 / 政务 / 协议边界）
│   └── ui_schema.hospital.json  协议原始样例
└── demo/index.html         免服务器预览页
```

## 直接看效果

双击 `demo/index.html` 即可，不需要启动服务，也不需要安装扩展。
页面左侧是插件渲染出的适老界面，右侧是模拟的原网页，用来验证 `navigate` / `scroll` / `form` 真的能定位并回填宿主元素。

## 装成插件

1. 打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本目录 `extension/`。
3. 打开任意目标网站，页面右下角出现「适老」入口；点工具栏图标可一键进入 / 退出。

`content/content.js` 里的 `TARGET_SITES` 是自动出现入口的网站名单。名单外的站点不会自动打扰，可在 popup 里手动启用。

## 协议实现要点

- **严格按 `priority` 升序渲染**，不按「看起来重要」重排。
- **`source="fallback"` 必须显示降级提示**，文案明确说明不是刚才浏览的真实网页。
- **`title` / `label` 原样使用**，不改写。
- **`icon`** 支持冻结的 16 个名字；`null` 或未登记名字退化到默认图标，只告警不报错。
- **`action.kind`** 四种行为：`navigate` / `scroll` 定位宿主元素并高亮，`form` 展开填写界面，`external` 打开链接。
- **`target_element_id` 查不到时显式报错**，提示这是 B 侧数据问题，不做静默兜底。
- **表单** 支持 9 种 `input_type`，必填校验后把值写回宿主页面并触发 `submit_element_id`。
- **`extensions` 等未知字段安全忽略**，塞垃圾数据也不会崩。
- **偏好与隐私**：用户同意隐私提示前不写入本地偏好；同意后只保存在 `chrome.storage.local`。

## 两套 schema 的关系

仓库里原有的 `frontend/` 是早期原型，用的是 `pageType` / `flow` 结构，和任务书协议不一致。
本次新增的 `extension/` 以任务书 `ui.schema.json` 为准，是 A 组下一步联调的基线。

## 已知边界

- GitHub 仓库 `kevin20070810/EasyView` 当前不可访问（返回 404），`docs/ui.schema.json` 与 `docs/examples/*.json` 未能拉取，协议字段按交接任务书的字段表实现。
- 协议未定义 `form.fields[].options`。`select` / `radio` / `checkbox` 在没有选项时退化为文本输入，等 B 侧确定字段后再对齐。
