(function () {
  "use strict";

  var schemas = window.EASYVIEW_SCHEMAS || {};
  var stage = document.getElementById("easyview-stage");
  var schemaSelect = document.getElementById("demo-schema");
  var sourceToggle = document.getElementById("demo-source-mode");
  var contrastToggle = document.getElementById("demo-contrast");
  var reportText = document.getElementById("demo-report-text");

  var state = { key: "hospital", fallback: false, contrast: false };
  var last = null;

  function currentSchema() {
    var base = schemas[state.key] || schemas.hospital;
    if (state.fallback) return schemas.withSource(base, "fallback");
    return schemas.withSource(base, "live");
  }

  function describeReport(report) {
    var lines = [];
    lines.push("schema_version: " + window.EasyViewRenderer.PROTOCOL_VERSION);
    lines.push("结果: " + (report.ok ? "通过" : "不通过"));
    lines.push("卡片数: " + report.cards.length);
    if (report.errors.length) {
      lines.push("错误:");
      report.errors.forEach(function (item) {
        lines.push("  - " + item.path + "：" + item.message);
      });
    }
    if (report.warnings.length) {
      lines.push("警告:");
      report.warnings.forEach(function (item) {
        lines.push("  - " + item.path + "：" + item.message);
      });
    }
    return lines.join("\n");
  }

  function render() {
    var schema = currentSchema();
    last = window.EasyViewRenderer.render(schema, stage, {
      searchRoot: document,
      onReport: function (report) {
        reportText.textContent = describeReport(report);
      },
      onAction: function (card, action) {
        if (action.kind === "external" && String(action.href || "").indexOf("tel:") === 0) {
          reportText.textContent += "\n外部动作: 呼叫 " + action.href.replace(/^tel:/, "");
          return true;
        }
        return false;
      },
      onFormSubmit: function (card, values, info) {
        var missing = info.writeBack.length ? info.writeBack.join("、") : "无";
        var lines = [reportText.textContent, "", "已提交表单：" + card.title, "回填字段：" + Object.keys(values).join("、")];
        lines.push("找不到的宿主元素：" + missing);
        lines.push("触发提交按钮：" + (info.submitElement ? "是" : "否"));
        reportText.textContent = lines.join("\n");
      }
    });
    applyContrast();
  }

  function applyContrast() {
    var root = stage.querySelector(".ev-root");
    if (!root) return;
    root.classList.toggle("ev-contrast", state.contrast);
    contrastToggle.setAttribute("aria-pressed", state.contrast ? "true" : "false");
  }

  schemaSelect.addEventListener("change", function () {
    state.key = schemaSelect.value;
    render();
  });

  sourceToggle.addEventListener("click", function () {
    state.fallback = !state.fallback;
    sourceToggle.setAttribute("aria-pressed", state.fallback ? "true" : "false");
    render();
  });

  contrastToggle.addEventListener("click", function () {
    state.contrast = !state.contrast;
    applyContrast();
  });

  render();
})();
