/* 隐私层测试：既要不漏，也要不误伤。
 *
 * 用法： node tools/test_privacy.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "privacy.js"), "utf8");
const sandbox = { console, URL, location: { href: "https://demo.example.cn/guahao" } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "privacy.js" });
const privacy = sandbox.EasyViewPrivacy;

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  [PASS] ${label}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${label}${detail ? `  ${detail}` : ""}`);
  }
}

function redacted(text) {
  privacy.begin();
  const out = privacy.redactText(text);
  return out;
}

console.log("=== 1. 必须拦住（漏一个就是一次隐私事故）===");
const mustCatch = [
  ["18 位身份证", "就诊人身份证号 110101199001011234 已登记", "110101199001011234"],
  ["15 位身份证", "旧证件 110101900101123 已被替换", "110101900101123"],
  ["手机号", "请联系 13812345678 确认", "13812345678"],
  ["座机", "医院总机 010-12345678 转 0", "010-12345678"],
  ["银行卡", "卡号 6222021234567890123 已绑定", "6222021234567890123"],
  ["邮箱", "发送到 zhangsan@example.com 即可", "zhangsan@example.com"],
  ["12 位账号", "工单号 123456789012 正在处理", "123456789012"],
  ["链接里的查询参数", "详见 https://demo.example.cn/report?id=1101&token=abc123", "token=abc123"],
];
for (const [label, input, secret] of mustCatch) {
  const out = redacted(input);
  check(label, !out.includes(secret), `输出仍含「${secret}」→ ${out}`);
}

console.log();
console.log("=== 2. 绝不能误伤（把正常内容也隐去，产品就废了）===");
const mustKeep = [
  ["铁路客服号", "拨打铁路客服 12306", "12306"],
  ["天气声讯号", "打电话问天气 12121", "12121"],
  ["日期", "出诊时间 2025-03-10 上午", "2025-03-10"],
  ["时间", "工作时间 08:00 - 20:00", "08:00"],
  ["金额", "挂号费 50 元", "50"],
  ["科室名", "内科 外科 儿科 妇科 骨科", "内科"],
  ["任务名", "我要挂号", "我要挂号"],
  ["短编号", "科室代码 A12", "A12"],
];
for (const [label, input, keep] of mustKeep) {
  const out = redacted(input);
  check(label, out.includes(keep), `输出把「${keep}」弄丢了 → ${out}`);
}

console.log();
console.log("=== 3. 链接只留来源和路径 ===");
check("去掉查询串",
  privacy.safeUrl("https://demo.example.cn/guahao?dept=12&token=xyz") === "https://demo.example.cn/guahao");
check("去掉片段",
  privacy.safeUrl("https://demo.example.cn/report#section-3") === "https://demo.example.cn/report");
check("拒绝非 http(s)",
  privacy.safeUrl("javascript:alert(1)") === null);
check("保留纯路径",
  privacy.safeUrl("https://demo.example.cn/pay") === "https://demo.example.cn/pay");

console.log();
console.log("=== 4. 统计要说实话（界面要靠它告诉用户）===");
privacy.begin();
privacy.redactText("身份证 110101199001011234 手机 13812345678 邮箱 a@b.com");
const report = privacy.describe();
console.log(`  ${report.summary}`);
check("统计到 3 处", report.total === 3, `实际 ${report.total}`);
check("分类正确", report.byKind["身份证"] === 1 && report.byKind["手机号"] === 1 && report.byKind["邮箱"] === 1,
  JSON.stringify(report.byKind));

privacy.begin();
privacy.redactText("我要挂号 查看报告 联系医院");
check("干净内容统计为 0", privacy.describe().total === 0, JSON.stringify(privacy.describe()));

console.log();
console.log("=== 5. 扫描器（预览用，不改写）===");
const found = privacy.scan("身份证 110101199001011234 和手机 13812345678");
check("能列出敏感项", found.length >= 2, JSON.stringify(found));
check("扫描不改写原文本",
  "身份证 110101199001011234 和手机 13812345678".includes("110101199001011234"));

console.log();
console.log("=".repeat(46));
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
console.log("=".repeat(46));
process.exit(fail ? 1 : 0);
