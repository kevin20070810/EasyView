// A 组 demo 数据源。真实联调时由 B 产出 ui_schema.json，这里的三份样例用于演示与自测。
// 字段严格遵循 docs/ui.schema.json v0.1.0-draft：cards + priority + action/form。
(function (global) {
  "use strict";

  var hospital = {
    schema_version: "0.1.0-draft",
    source_elements_schema_version: "1.0.0",
    page_url: "https://demo.easyview.local/h",
    page_title: "市第一人民医院网上服务",
    source: "live",
    generated_at: "2026-10-02T02:35:00Z",
    page: {
      greeting: "您好，这里是市第一人民医院网上服务",
      summary: "可以预约挂号、查看报告、在线缴费，也可以联系人工客服"
    },
    cards: [
      {
        id: "grp_appointment",
        title: "我要挂号",
        subtitle: "门诊预约登记",
        icon: "calendar",
        priority: 1,
        action: { kind: "form", target_element_id: "el_appointment", href: null },
        form: {
          submit_element_id: "el_appointment_submit",
          fields: [
            { element_id: "el_patient_name", label: "就诊人姓名", input_type: "text", placeholder: "请输入姓名", required: true },
            { element_id: "el_patient_idcard", label: "身份证号", input_type: "idcard", placeholder: "18 位身份证号", required: true },
            { element_id: "el_patient_phone", label: "手机号", input_type: "tel", placeholder: "用于接收预约短信", required: true },
            { element_id: "el_visit_date", label: "就诊日期", input_type: "date", placeholder: null, required: false },
            { element_id: "el_department", label: "就诊科室", input_type: "select", placeholder: "请选择科室", required: false, options: ["内科", "外科", "儿科", "耳鼻喉科"] }
          ]
        }
      },
      {
        id: "el_report",
        title: "查看报告",
        subtitle: "查询检验检查结果",
        icon: "document",
        priority: 2,
        action: { kind: "navigate", target_element_id: "el_report", href: null },
        form: null
      },
      {
        id: "el_payment",
        title: "缴费",
        subtitle: "在线缴纳门诊费用",
        icon: "payment",
        priority: 3,
        action: { kind: "scroll", target_element_id: "el_payment", href: null },
        form: null
      },
      {
        id: "el_service_phone",
        title: "联系客服",
        subtitle: "工作时间 08:00 - 20:00",
        icon: "phone",
        priority: 4,
        action: { kind: "external", target_element_id: null, href: "tel:0755-12345678" },
        form: null
      },
      {
        id: "el_insurance",
        title: "医保查询",
        subtitle: null,
        icon: "info",
        priority: 5,
        action: { kind: "navigate", target_element_id: "el_insurance", href: null },
        form: null
      }
    ],
    extensions: {
      experimental_theme: "ignored",
      junk: [1, 2, 3],
      unknown_flag: true
    }
  };

  var gov = {
    schema_version: "0.1.0-draft",
    source_elements_schema_version: "1.0.0",
    page_url: "https://demo.easyview.local/g",
    page_title: "市医疗保障局 · 参保缴费通知",
    source: "live",
    generated_at: "2026-10-02T02:36:00Z",
    page: {
      greeting: "您好，这里是市医疗保障局网上服务",
      summary: "可以办理居民医保缴费、查看缴费时间和标准，也可以拨打咨询电话"
    },
    cards: [
      {
        id: "grp_pay",
        title: "我要参保缴费",
        subtitle: "居民医保集中缴费期办理",
        icon: "government",
        priority: 1,
        action: { kind: "form", target_element_id: "el_pay_form", href: null },
        form: {
          submit_element_id: "el_pay_submit",
          fields: [
            { element_id: "el_pay_name", label: "参保人姓名", input_type: "text", placeholder: "请输入姓名", required: true },
            { element_id: "el_pay_idcard", label: "身份证号", input_type: "idcard", placeholder: "18 位身份证号", required: true },
            { element_id: "el_pay_phone", label: "手机号", input_type: "tel", placeholder: "用于接收缴费结果", required: true },
            { element_id: "el_pay_amount", label: "缴费金额", input_type: "number", placeholder: "每人每年 380 元", required: true }
          ]
        }
      },
      {
        id: "el_pay_period",
        title: "缴费时间",
        subtitle: "2026年10月1日 至 12月31日",
        icon: "calendar",
        priority: 2,
        action: { kind: "scroll", target_element_id: "el_pay_period", href: null },
        form: null
      },
      {
        id: "el_pay_standard",
        title: "缴费标准",
        subtitle: "个人每人每年 380 元",
        icon: "payment",
        priority: 3,
        action: { kind: "scroll", target_element_id: "el_pay_standard", href: null },
        form: null
      },
      {
        id: "el_pay_channel",
        title: "办理方式",
        subtitle: "微信小程序或社区医保服务站",
        icon: "location",
        priority: 4,
        action: { kind: "scroll", target_element_id: "el_pay_channel", href: null },
        form: null
      },
      {
        id: "el_pay_hotline",
        title: "咨询电话",
        subtitle: "12393（工作日 8:30 - 17:30）",
        icon: "phone",
        priority: 5,
        action: { kind: "external", target_element_id: null, href: "tel:12393" },
        form: null
      }
    ],
    extensions: {}
  };

  // 用于验证自测清单：icon=null 走默认图标、subtitle=null 布局不塌陷、未登记图标退化、垃圾扩展字段不崩。
  var edge = {
    schema_version: "0.1.0-draft",
    source_elements_schema_version: "1.0.0",
    page_url: "https://demo.easyview.local/edge",
    page_title: "协议边界测试",
    source: "live",
    generated_at: "2026-10-02T02:37:00Z",
    page: {
      greeting: "这是一份协议边界样例",
      summary: "用来检查空图标、空副标题、未登记图标和未知字段"
    },
    cards: [
      {
        id: "el_no_icon",
        title: "图标为 null 的卡片",
        subtitle: "应当退化为默认图标",
        icon: null,
        priority: 1,
        action: { kind: "scroll", target_element_id: "el_insurance", href: null },
        form: null
      },
      {
        id: "el_unknown_icon",
        title: "未登记图标的卡片",
        subtitle: "icon 填了协议外名字，只能告警不报错",
        icon: "rocket",
        priority: 2,
        action: { kind: "scroll", target_element_id: "el_report", href: null },
        form: null
      },
      {
        id: "el_no_subtitle",
        title: "没有副标题的卡片",
        subtitle: null,
        icon: "info",
        priority: 3,
        action: { kind: "external", target_element_id: null, href: "https://example.com" },
        form: null
      }
    ],
    extensions: { junk: { nested: [null, true, 1] }, "unknown-field": "安全忽略" }
  };

  function withSource(schema, source) {
    var copy = JSON.parse(JSON.stringify(schema));
    copy.source = source;
    return copy;
  }

  global.EASYVIEW_SCHEMAS = {
    hospital: hospital,
    gov: gov,
    edge: edge,
    fallback: withSource(hospital, "fallback"),
    withSource: withSource
  };
})(window);
