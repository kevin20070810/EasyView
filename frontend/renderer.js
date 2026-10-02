(function () {
  "use strict";

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildHeader(schema) {
    var header = el("header", "page-header");
    if (schema.title) header.appendChild(el("h1", "page-title", schema.title));
    if (schema.subtitle) header.appendChild(el("p", "page-subtitle", schema.subtitle));
    if (schema.intro) header.appendChild(el("p", "page-subtitle", schema.intro));
    return header;
  }

  function labelForStep(step) {
    var labels = {
      dept: "科室",
      symptom: "症状",
      doctor: "医生",
      time: "时间"
    };
    return (step && labels[step.id]) || (step && step.title) || "";
  }

  function renderSummary(schema, state) {
    var steps = EasyViewAgent.getFlow(schema);
    var list = el("ul", "summary-list");
    steps.forEach(function (step) {
      if (step.isFinal || !state.answers[step.id]) return;
      var item = el("li", "summary-item");
      item.appendChild(el("span", "summary-label", labelForStep(step)));
      item.appendChild(el("span", "summary-value", state.answers[step.id]));
      list.appendChild(item);
    });
    return list;
  }

  function renderOperation(schema, state, hooks) {
    hooks = hooks || {};
    var section = el("section", "operation-page");
    section.appendChild(buildHeader(schema));

    if (state.done) {
      var success = el("section", "comp success-card");
      success.appendChild(el("h2", "success-title", "挂号成功"));
      success.appendChild(el("p", "comp-title", "您的预约信息如下："));
      success.appendChild(renderSummary(schema, state));
      success.appendChild(el("p", "step-description", "请按预约时间到院就诊。"));
      var restart = el("button", "primary-btn restart-btn", "重新挂号");
      restart.type = "button";
      restart.addEventListener("click", hooks.onRestart || function () {});
      success.appendChild(restart);
      section.appendChild(success);
      return section;
    }

    var steps = EasyViewAgent.getFlow(schema);
    var index = Math.max(0, Math.min(state.currentStep || 0, steps.length - 1));
    var step = steps[index];

    section.appendChild(el("div", "step-track", "第 " + (index + 1) + " 步 / 共 " + steps.length + " 步"));

    var card = el("section", "comp step-card");
    card.appendChild(el("h2", "comp-title", step.title));
    card.appendChild(el("p", "step-prompt", step.prompt));
    if (step.description) card.appendChild(el("p", "step-description", step.description));

    if (step.isFinal) {
      card.appendChild(renderSummary(schema, state));
      var finish = el("button", "finish-btn", "确认并完成挂号");
      finish.type = "button";
      finish.addEventListener("click", hooks.onFinish || function () {});
      card.appendChild(finish);
    } else {
      var grid = el("div", "option-grid");
      (step.options || []).forEach(function (option) {
        var btn = el("button", "option-btn", option.label);
        btn.type = "button";
        btn.dataset.stepId = step.id;
        btn.dataset.value = option.value || option.label;
        btn.addEventListener("click", function () {
          if (hooks.onSelect) hooks.onSelect(step, option);
        });
        grid.appendChild(btn);
      });
      var rec = EasyViewAgent.recommendedOption(step);
      if (rec && grid.firstChild) {
        grid.firstChild.classList.add("recommended");
      }
      card.appendChild(grid);

      var tip = el("div", "next-tip");
      tip.appendChild(el("span", null, "下一步："));
      tip.appendChild(el("strong", null, rec ? rec.label : step.title));
      card.appendChild(tip);
    }
    section.appendChild(card);

    var actions = el("div", "flow-actions");
    if (index > 0) {
      var back = el("button", "ghost-btn back-btn", "上一步");
      back.type = "button";
      back.addEventListener("click", hooks.onBack || function () {});
      actions.appendChild(back);
    }
    var replay = el("button", "replay-btn replay-btn", "重听提示");
    replay.type = "button";
    replay.addEventListener("click", function () {
      if (hooks.onReplay) hooks.onReplay(step);
    });
    actions.appendChild(replay);
    section.appendChild(actions);

    return section;
  }

  function renderArticle(schema, state, hooks) {
    hooks = hooks || {};
    var section = el("section", "article-page");
    section.appendChild(buildHeader(schema));

    var toolbar = el("div", "reading-toolbar");
    var smaller = el("button", null, "A-");
    smaller.type = "button";
    smaller.setAttribute("aria-label", "减小字号");
    smaller.addEventListener("click", function () {
      if (hooks.changeFont) hooks.changeFont(-2);
    });
    var larger = el("button", null, "A+");
    larger.type = "button";
    larger.setAttribute("aria-label", "增大字号");
    larger.addEventListener("click", function () {
      if (hooks.changeFont) hooks.changeFont(2);
    });
    var contrast = el("button", null, "高对比");
    contrast.type = "button";
    contrast.setAttribute("aria-pressed", state.highContrast ? "true" : "false");
    contrast.addEventListener("click", function () {
      if (hooks.toggleContrast) hooks.toggleContrast(contrast);
    });
    var read = el("button", null, state.reading ? "暂停" : "朗读");
    read.type = "button";
    read.setAttribute("aria-label", "朗读");
    read.setAttribute("aria-pressed", state.reading ? "true" : "false");
    read.addEventListener("click", function () {
      if (hooks.toggleRead) hooks.toggleRead(read);
    });
    var stop = el("button", null, "停止");
    stop.type = "button";
    stop.addEventListener("click", function () {
      if (hooks.stopRead) hooks.stopRead();
    });
    toolbar.appendChild(smaller);
    toolbar.appendChild(larger);
    toolbar.appendChild(contrast);
    toolbar.appendChild(read);
    toolbar.appendChild(stop);
    section.appendChild(toolbar);

    var article = el("article", "reading-content");
    if (schema.source || schema.publishedAt) {
      var meta = el("p", "reading-meta", (schema.source || "") + (schema.publishedAt ? " · " + schema.publishedAt : ""));
      article.appendChild(meta);
    }
    (schema.content || []).forEach(function (block) {
      if (!block) return;
      if (block.type === "heading") article.appendChild(el("h3", null, block.text));
      else article.appendChild(el("p", null, block.text));
    });
    section.appendChild(article);

    if (schema.keyPoints && schema.keyPoints.length) {
      var points = el("aside", "key-points");
      points.appendChild(el("h2", null, "重点提示"));
      var list = el("ul", "key-point-list");
      schema.keyPoints.forEach(function (point) {
        list.appendChild(el("li", null, point));
      });
      points.appendChild(list);
      section.appendChild(points);
    }

    return section;
  }

  function renderLegacy(schema, target) {
    var header = buildHeader(schema);
    target.appendChild(header);
    var list = schema.components || (schema.type ? [schema] : []);
    list.forEach(function (comp) {
      target.appendChild(renderLegacyComponent(comp || {}));
    });
  }

  function renderActionGroup(data) {
    var section = el("section", "comp action-group");
    if (data.title) section.appendChild(el("h2", "comp-title", data.title));
    var grid = el("div", "action-grid");
    (data.items || []).forEach(function (label) {
      var btn = el("button", "action-btn", label);
      btn.type = "button";
      grid.appendChild(btn);
    });
    section.appendChild(grid);
    return section;
  }

  function renderInfoCard(data) {
    var section = el("section", "comp info-card");
    if (data.title) section.appendChild(el("h2", "comp-title", data.title));
    if (data.content) section.appendChild(el("p", "info-content", data.content));
    return section;
  }

  function renderFormStep(data) {
    var section = el("section", "comp form-step");
    if (data.title) section.appendChild(el("h2", "comp-title", data.title));
    var ol = el("ol", "step-list");
    (data.steps || []).forEach(function (step) {
      var isObject = typeof step === "object" && step !== null;
      var li = el("li", "step-item");
      li.appendChild(el("span", "step-label", isObject ? step.label : step));
      if (isObject && step.desc) li.appendChild(el("span", "step-desc", step.desc));
      ol.appendChild(li);
    });
    section.appendChild(ol);
    return section;
  }

  function renderContactCard(data) {
    var section = el("section", "comp contact-card");
    if (data.title) section.appendChild(el("h2", "comp-title", data.title));
    if (data.phone) {
      var phone = el("a", "contact-phone", data.phone);
      phone.href = "tel:" + String(data.phone).replace(/[^0-9+]/g, "");
      section.appendChild(phone);
    }
    if (data.hours) section.appendChild(el("p", "contact-hours", data.hours));
    return section;
  }

  function renderCollapse(data) {
    var details = el("details", "comp collapse");
    details.appendChild(el("summary", "collapse-summary", data.title || "展开更多"));
    var list = el("ul", "collapse-list");
    (data.items || []).forEach(function (item) {
      var label = typeof item === "string" ? item : item.label;
      list.appendChild(el("li", "collapse-item", label));
    });
    details.appendChild(list);
    return details;
  }

  function renderFallback(data) {
    var section = el("section", "comp fallback");
    section.appendChild(el("h2", "comp-title", "未识别内容"));
    section.appendChild(el("p", "fallback-type", "组件类型：" + (data && data.type ? data.type : "未知")));
    return section;
  }

  function renderLegacyComponent(comp) {
    var registry = {
      ActionGroup: renderActionGroup,
      InfoCard: renderInfoCard,
      FormStep: renderFormStep,
      ContactCard: renderContactCard,
      Collapse: renderCollapse
    };
    var render = registry[comp.type] || renderFallback;
    return render(comp);
  };

  window.EasyViewRenderer = {
    render: function (schema, target, state, hooks) {
      var root = typeof target === "string" ? document.getElementById(target) : target;
      if (!root || !schema) return root;

      root.innerHTML = "";

      var pageType = window.EasyViewAgent ? window.EasyViewAgent.classify(schema) : "operation";
      if (pageType === "article") {
        root.appendChild(renderArticle(schema, state || {}, hooks || {}));
      } else if (pageType === "operation") {
        root.appendChild(renderOperation(schema, state || { currentStep: 0, answers: {} }, hooks || {}));
      } else {
        renderLegacy(schema, root);
      }

      return root;
    }
  };
})();
