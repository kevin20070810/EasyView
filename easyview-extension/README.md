# EasyView Chrome 扩展

Manifest V3 扩展。每次更新扩展代码或资源，都递增 [manifest.json](manifest.json) 中的 `version`。

## 加载

在 Chrome 打开 `chrome://extensions`，开启开发者模式，选择“加载未打包的扩展程序”，指向本目录。修改代码后需要在扩展管理页刷新扩展，并刷新目标网页。

普通 HTTP(S) 页面显示「敬老版 / 放大」快捷入口；也可点击浏览器工具栏图标。浏览器内部页面和禁止扩展注入的页面无法使用。

## 工作方式

- 点击「敬老版」后，扩展在当前页面提取入口、生成压缩说明书，向分析服务的 `/draft` 请求任务草稿。
- 扩展本地的 `binder.js` 绑定真实元素并检查风险，`ai-content.js` 渲染最多 7 张任务卡。
- 服务不可用时，可在错误页选择本地规则版；`generic-content.js` 是这条兜底路径，仍在使用。
- 点击卡片回到原站定位对应入口。涉钱、身份、医疗等事项由用户在原站核对和办理。
- 12306 查询、车次筛选与乘车人核对有额外页面辅助。服务端不保存原站登录状态。
- 原网页可放大并还原；事项卡可单独朗读，也可朗读整页。朗读由 Chrome 本地语音服务执行。

扩展不会读取已填写的密码、验证码或身份证号，也不会代用户付款、提交订单或登录。

## 分析服务设置

默认地址是 `https://ev.jvda.online`。该服务的 `/draft` 接口需要访问令牌；服务根路径返回 404 是正常的，`/health` 才是状态接口。云端配置见 [部署说明](../ai-service/DEPLOY.md)。在扩展的 Service Worker DevTools 控制台设置令牌：

```js
await chrome.storage.local.set({
  "easyview.accessToken": "云端设置的访问令牌"
});
```

若曾手动设置旧地址，还需执行 `await chrome.storage.local.remove("easyview.aiEndpoint")`，让新默认地址生效。本地调试时可将 `easyview.aiEndpoint` 设为 `http://127.0.0.1:8787`。设置后刷新目标网页；若刚更新扩展代码，还需在 `chrome://extensions` 刷新扩展。不要把访问令牌写进扩展源码或上传到 GitHub。

## 目录

- `src/background.js`：分析请求、朗读、缩放状态。
- `src/quick-launcher.js`：网页快捷入口。
- `src/extract.js` / `digest.js` / `binder.js`：提取、压缩与本地绑定。
- `src/ai-content.js`：任务卡和确认页。
- `src/generic-content.js`：服务故障时的本地规则版。
- `src/site/12306.js`、`train-list.js`、`passenger-list.js`：铁路页面辅助。
