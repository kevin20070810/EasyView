(function (global) {
  "use strict";

  var PROTOCOL_VERSION = "0.1.0-draft";
  var ELEMENTS_VERSION = "1.0.0";
  var ACTION_KINDS = ["navigate", "form", "scroll", "external"];
  var INPUT_TYPES = ["text", "number", "date", "tel", "idcard", "password", "select", "radio", "checkbox"];
  var INPUT_HINTS = {
    text: { type: "text", inputmode: "text" },
    number: { type: "text", inputmode: "numeric" },
    date: { type: "date", inputmode: null },
    tel: { type: "tel", inputmode: "tel" },
    idcard: { type: "text", inputmode: "text" },
    password: { type: "password", inputmode: null },
    select: { type: "text", inputmode: null },
    radio: { type: "text", inputmode: null },
    checkbox: { type: "text", inputmode: null }
  };

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
  }

  function isNullish(value) {
    return value === null || value === undefined;
  }

  function knownIcons() {
    return (global.EasyViewIcons && global.EasyViewIcons.names) || [];
  }

  function validate(schema) {
    var errors = [];
    var warnings = [];
    var cards = [];

    function err(path, message) {
      errors.push({ path: path, message: message });
    }

    function warn(path, message) {
      warnings.push({ path: path, message: message });
    }

    if (!isObject(schema)) {
      err("$", "schema 必须是 JSON 对象");
      return { ok: false, errors: errors, warnings: warnings, cards: cards };
    }

    if (schema.schema_version !== PROTOCOL_VERSION) {
      warn("schema_version", "期望 \"" + PROTOCOL_VERSION + "\"，实际 " + JSON.stringify(schema.schema_version));
    }
    if (schema.source_elements_schema_version !== ELEMENTS_VERSION) {
      warn("source_elements_schema_version", "期望 \"" + ELEMENTS_VERSION + "\"，实际 " + JSON.stringify(schema.source_elements_schema_version));
    }
    ["page_url", "page_title", "generated_at"].forEach(function (key) {
      if (!isNonEmptyString(schema[key])) err(key, "必填字段缺失或不是非空字符串");
    });
    if (schema.source !== "live" && schema.source !== "fallback") {
      err("source", "必须是 \"live\" 或 \"fallback\"");
    }

    if (!isObject(schema.page)) {
      err("page", "必填对象缺失");
    } else {
      if (!isNonEmptyString(schema.page.greeting)) err("page.greeting", "必填字段缺失");
      if (!isNonEmptyString(schema.page.summary)) err("page.summary", "必填字段缺失");
    }

    if (!Array.isArray(schema.cards) || schema.cards.length < 1) {
      err("cards", "至少需要 1 张卡片");
      return { ok: errors.length === 0, errors: errors, warnings: warnings, cards: cards };
    }

    var seenIds = {};
    var seenPriorities = {};

    schema.cards.forEach(function (card, index) {
      var base = "cards[" + index + "]";
      if (!isObject(card)) {
        err(base, "卡片必须是对象");
        return;
      }

      if (!isNonEmptyString(card.id)) err(base + ".id", "必填字段缺失");
      else if (seenIds[card.id]) err(base + ".id", "卡片 id 重复：" + card.id);
      else seenIds[card.id] = true;

      if (!isNonEmptyString(card.title)) err(base + ".title", "必填字段缺失");
      if (!isNullish(card.subtitle) && typeof card.subtitle !== "string") {
        err(base + ".subtitle", "只能是字符串或 null");
      }

      if (typeof card.priority !== "number" || !Number.isInteger(card.priority) || card.priority < 1) {
        err(base + ".priority", "必须是 >=1 的整数");
      } else if (seenPriorities[card.priority]) {
        err(base + ".priority", "同一份文档内 priority 不得重复：" + card.priority);
      } else {
        seenPriorities[card.priority] = true;
      }

      if (!isNullish(card.icon) && typeof card.icon !== "string") {
        err(base + ".icon", "只能是图标名或 null");
      } else if (isNonEmptyString(card.icon) && knownIcons().indexOf(card.icon) === -1) {
        warn(base + ".icon", "未登记图标 \"" + card.icon + "\"，已退化为默认图标");
      }

      if (!isObject(card.action)) {
        err(base + ".action", "必填对象缺失");
      } else {
        var action = card.action;
        if (ACTION_KINDS.indexOf(action.kind) === -1) {
          err(base + ".action.kind", "取值必须是 " + ACTION_KINDS.join(" / "));
        }
        if (action.kind === "external") {
          if (!isNonEmptyString(action.href)) err(base + ".action.href", "kind=external 时必填");
        } else if (ACTION_KINDS.indexOf(action.kind) !== -1) {
          if (!isNonEmptyString(action.target_element_id)) {
            err(base + ".action.target_element_id", "kind=" + action.kind + " 时必填");
          }
        }

        if (action.kind === "form") {
          if (!isObject(card.form)) {
            err(base + ".form", "kind=form 时必填");
          } else {
            if (!isNonEmptyString(card.form.submit_element_id)) err(base + ".form.submit_element_id", "必填字段缺失");
            if (!Array.isArray(card.form.fields) || card.form.fields.length < 1) {
              err(base + ".form.fields", "至少需要 1 个字段");
            } else {
              card.form.fields.forEach(function (field, fieldIndex) {
                var fieldBase = base + ".form.fields[" + fieldIndex + "]";
                if (!isObject(field)) {
                  err(fieldBase, "字段必须是对象");
                  return;
                }
                if (!isNonEmptyString(field.element_id)) err(fieldBase + ".element_id", "必填字段缺失");
                if (!isNonEmptyString(field.label)) err(fieldBase + ".label", "必填字段缺失");
                if (INPUT_TYPES.indexOf(field.input_type) === -1) {
                  err(fieldBase + ".input_type", "取值必须是 " + INPUT_TYPES.join(" / "));
                }
                if (typeof field.required !== "boolean") err(fieldBase + ".required", "必须是布尔值");
              });
            }
          }
        } else if (!isNullish(card.form)) {
          warn(base + ".form", "kind=" + action.kind + " 时 form 必须为 null，已忽略");
        }
      }

      cards.push(card);
    });

    return { ok: errors.length === 0, errors: errors, warnings: warnings, cards: cards };
  }

  // 严格按 priority 升序渲染。priority 相同（数据有问题）时保持原顺序，保证结果稳定。
  function sortCards(cards) {
    return (cards || [])
      .map(function (card, index) {
        return { card: card, index: index };
      })
      .sort(function (a, b) {
        var pa = isObject(a.card) && typeof a.card.priority === "number" ? a.card.priority : Number.MAX_SAFE_INTEGER;
        var pb = isObject(b.card) && typeof b.card.priority === "number" ? b.card.priority : Number.MAX_SAFE_INTEGER;
        if (pa !== pb) return pa - pb;
        return a.index - b.index;
      })
      .map(function (entry) {
        return entry.card;
      });
  }

  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (!isNullish(text)) node.textContent = text;
    return node;
  }

  function resolveTargetElement(id, options) {
    if (!id) return null;
    if (options && typeof options.resolveElement === "function") {
      var resolved = options.resolveElement(id);
      if (resolved) return resolved;
    }
    var root = (options && options.searchRoot) || document;
    if (root && typeof root.getElementById === "function") return root.getElementById(id);
    if (root && typeof root.querySelector === "function") return root.querySelector("#" + CSS.escape(id));
    return null;
  }

  function highlight(element) {
    if (!element || !element.style) return;
    var previous = element.style.outline;
    var previousOffset = element.style.outlineOffset;
    element.style.outline = "4px solid #b45309";
    element.style.outlineOffset = "3px";
    global.setTimeout(function () {
      element.style.outline = previous;
      element.style.outlineOffset = previousOffset;
    }, 1800);
  }

  function createForm(card, api) {
    var form = h("form", "ev-form");
    form.noValidate = true;
    var fields = (card.form && card.form.fields) || [];

    fields.forEach(function (field) {
      var wrap = h("label", "ev-field");
      wrap.htmlFor = "ev-" + field.element_id;

      var head = h("span", "ev-field-head");
      head.appendChild(h("span", "ev-field-label", field.label));
      if (field.required) head.appendChild(h("span", "ev-field-required", "必填"));
      wrap.appendChild(head);

      var hint = INPUT_HINTS[field.input_type] || INPUT_HINTS.text;
      var control;

      if (field.input_type === "select" || field.input_type === "radio" || field.input_type === "checkbox") {
        var options = Array.isArray(field.options) ? field.options : [];
        if (options.length) {
          control = h("span", "ev-choice-group");
          options.forEach(function (option, optionIndex) {
            var choice = h("label", "ev-choice");
            var input = h("input");
            input.type = field.input_type === "checkbox" ? "checkbox" : field.input_type === "radio" ? "radio" : "radio";
            input.name = "ev-" + field.element_id;
            input.id = "ev-" + field.element_id + "-" + optionIndex;
            input.value = typeof option === "string" ? option : option.value;
            input.dataset.elementId = field.element_id;
            choice.appendChild(input);
            choice.appendChild(h("span", "ev-choice-label", typeof option === "string" ? option : option.label));
            control.appendChild(choice);
          });
        } else {
          // 协议未定义 options 字段。缺省时退化为文本输入，并给出可读提示。
          control = h("input", "ev-input");
          control.type = "text";
          control.id = "ev-" + field.element_id;
          control.dataset.elementId = field.element_id;
          control.placeholder = field.placeholder || "请填写" + field.label;
        }
      } else {
        control = h("input", "ev-input");
        control.type = hint.type;
        if (hint.inputmode) control.setAttribute("inputmode", hint.inputmode);
        control.id = "ev-" + field.element_id;
        control.dataset.elementId = field.element_id;
        control.placeholder = field.placeholder || "请填写" + field.label;
        if (field.input_type === "idcard") {
          control.maxLength = 18;
          control.setAttribute("pattern", "[0-9]{17}[0-9Xx]");
        }
        if (field.input_type === "password") control.autocomplete = "off";
      }

      control.required = !!field.required;
      wrap.appendChild(control);
      form.appendChild(wrap);
    });

    var actions = h("div", "ev-form-actions");
    var submit = h("button", "ev-submit", "提交");
    submit.type = "submit";
    var cancel = h("button", "ev-cancel", "收起");
    cancel.type = "button";
    cancel.addEventListener("click", function () {
      api.closeForm();
    });
    actions.appendChild(submit);
    actions.appendChild(cancel);
    form.appendChild(actions);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      api.submitForm(form);
    });

    return form;
  }

  function readFormValues(form) {
    var values = {};
    form.querySelectorAll("[data-element-id]").forEach(function (control) {
      var id = control.dataset.elementId;
      if (control.type === "checkbox") {
        if (!values[id]) values[id] = [];
        if (control.checked) values[id].push(control.value);
      } else if (control.type === "radio") {
        if (control.checked) values[id] = control.value;
      } else {
        values[id] = control.value;
      }
    });
    return values;
  }

  function firstMissingField(form) {
    var missing = null;
    form.querySelectorAll("[data-element-id][required]").forEach(function (control) {
      if (missing) return;
      if (control.type === "radio" || control.type === "checkbox") {
        var group = form.querySelectorAll('[data-element-id="' + control.dataset.elementId + '"]');
        var checked = Array.prototype.some.call(group, function (item) {
          return item.checked;
        });
        if (!checked) missing = control;
      } else if (!String(control.value || "").trim()) {
        missing = control;
      }
    });
    return missing;
  }

  function createToast(host) {
    var toast = h("div", "ev-toast");
    toast.setAttribute("role", "status");
    toast.hidden = true;
    host.appendChild(toast);
    var timer = null;
    return {
      show: function (message) {
        toast.textContent = message;
        toast.hidden = false;
        global.clearTimeout(timer);
        timer = global.setTimeout(function () {
          toast.hidden = true;
        }, 2600);
      }
    };
  }

  function render(schema, target, options) {
    options = options || {};
    var root = typeof target === "string" ? document.querySelector(target) : target;
    if (!root) throw new Error("EasyViewRenderer: 找不到渲染目标");

    var report = validate(schema);
    root.innerHTML = "";

    var wrap = h("div", "ev-root");
    wrap.setAttribute("data-schema-version", isObject(schema) ? String(schema.schema_version || "") : "");
    root.appendChild(wrap);

    var toast = createToast(wrap);
    var state = {
      openCardId: null,
      submitted: {},
      report: report,
      cards: sortCards(report.cards)
    };

    if (options.onReport) options.onReport(report);

    if (!report.ok) {
      var errorPanel = h("section", "ev-error");
      errorPanel.appendChild(h("h2", "ev-error-title", "数据格式有误，无法渲染"));
      var errorList = h("ul", "ev-error-list");
      report.errors.forEach(function (item) {
        errorList.appendChild(h("li", null, item.path + "：" + item.message));
      });
      errorPanel.appendChild(errorList);
      wrap.appendChild(errorPanel);
      return { root: wrap, report: report, getState: function () { return state; } };
    }

    if (schema.source === "fallback") {
      var banner = h("div", "ev-banner");
      banner.setAttribute("role", "alert");
      banner.appendChild(h("strong", "ev-banner-title", "当前为演示数据"));
      banner.appendChild(h("span", null, "这不是您刚才浏览的真实网页，页面内容来自降级快照。"));
      wrap.appendChild(banner);
    }

    var header = h("header", "ev-header");
    if (isNonEmptyString(schema.page_title)) {
      header.appendChild(h("p", "ev-kicker", schema.page_title));
    }
    header.appendChild(h("h1", "ev-greeting", schema.page.greeting));
    header.appendChild(h("p", "ev-summary", schema.page.summary));
    wrap.appendChild(header);

    var list = h("div", "ev-cards");
    wrap.appendChild(list);

    function openForm(card) {
      state.openCardId = card.id;
      renderCards();
      var form = list.querySelector('[data-card-id="' + CSS.escape(card.id) + '"] .ev-form');
      if (form) {
        var input = form.querySelector("input");
        if (input) input.focus();
      }
      if (card.action && card.action.target_element_id) {
        var element = resolveTargetElement(card.action.target_element_id, options);
        if (element && element.scrollIntoView) element.scrollIntoView({ block: "center", behavior: "smooth" });
        highlight(element);
      }
    }

    function closeForm() {
      state.openCardId = null;
      renderCards();
    }

    function handleAction(card) {
      var action = card.action || {};
      if (action.kind === "form") {
        if (state.openCardId === card.id) closeForm();
        else openForm(card);
        return;
      }
      if (action.kind === "external") {
        if (typeof options.onAction === "function") {
          var handled = options.onAction(card, action);
          if (handled) return;
        }
        if (isNonEmptyString(action.href)) {
          global.open(action.href, "_blank", "noopener,noreferrer");
          toast.show("已打开：" + action.href);
        }
        return;
      }

      var element = resolveTargetElement(action.target_element_id, options);
      if (!element) {
        // 任务书约定：target_element_id 一定能在 elements[] 里查到。查不到是 B 的数据 bug，不能静默兜底。
        toast.show("未找到页面元素：" + action.target_element_id + "（请检查 B 产出的 target_element_id）");
        if (global.console && console.warn) {
          console.warn("[EasyView] target_element_id 不存在于宿主页面：", action.target_element_id, card);
        }
        return;
      }
      if (element.scrollIntoView) element.scrollIntoView({ block: "center", behavior: "smooth" });
      highlight(element);
      if (typeof options.onAction === "function") options.onAction(card, action, element);
    }

    function submitForm(card, form) {
      var missing = firstMissingField(form);
      if (missing) {
        toast.show("请先填写：" + (missing.closest(".ev-field").querySelector(".ev-field-label").textContent));
        if (missing.focus) missing.focus();
        return;
      }
      var values = readFormValues(form);
      state.submitted[card.id] = values;

      // 把值写回原网页对应元素，并触发提交按钮，这是 A 对 action.kind=form 的落地动作。
      var writeBack = [];
      Object.keys(values).forEach(function (id) {
        var element = resolveTargetElement(id, options);
        if (!element) {
          writeBack.push(id);
          return;
        }
        var value = values[id];
        if (Array.isArray(value)) {
          if (element.type === "checkbox" || element.type === "radio") element.checked = value.indexOf(element.value) !== -1;
          else element.value = value.join(",");
        } else {
          element.value = value;
        }
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      });

      var submitElement = resolveTargetElement(card.form.submit_element_id, options);
      if (submitElement && typeof submitElement.click === "function") submitElement.click();
      if (writeBack.length && global.console && console.warn) {
        console.warn("[EasyView] 以下字段在宿主页面找不到对应元素：", writeBack);
      }

      if (typeof options.onFormSubmit === "function") options.onFormSubmit(card, values, { writeBack: writeBack, submitElement: submitElement });
      else toast.show("已提交：" + card.title);
      renderCards();
    }

    function renderCards() {
      list.innerHTML = "";
      state.cards.forEach(function (card) {
        if (!isObject(card)) return;

        var item = h("section", "ev-card");
        item.dataset.cardId = card.id;
        item.dataset.priority = String(card.priority);

        var trigger = h("button", "ev-card-trigger");
        trigger.type = "button";
        trigger.setAttribute("aria-expanded", state.openCardId === card.id ? "true" : "false");

        var iconWrap = h("span", "ev-card-icon");
        if (global.EasyViewIcons && typeof global.EasyViewIcons.create === "function") {
          iconWrap.appendChild(global.EasyViewIcons.create(card.icon || global.EasyViewIcons.defaultName));
        }
        trigger.appendChild(iconWrap);

        var body = h("span", "ev-card-body");
        body.appendChild(h("span", "ev-card-title", card.title));
        if (isNonEmptyString(card.subtitle)) {
          body.appendChild(h("span", "ev-card-subtitle", card.subtitle));
        }
        trigger.appendChild(body);

        var marker = h("span", "ev-card-marker");
        marker.appendChild(h("span", "ev-card-seq", String(card.priority)));
        trigger.appendChild(marker);

        trigger.addEventListener("click", function () {
          handleAction(card);
        });
        item.appendChild(trigger);

        if (card.action && card.action.kind === "form" && state.openCardId === card.id) {
          var api = {
            closeForm: closeForm,
            submitForm: function (form) {
              submitForm(card, form);
            }
          };
          item.appendChild(createForm(card, api));
        }

        if (state.submitted[card.id]) {
          var done = h("p", "ev-card-done", "已提交");
          item.appendChild(done);
        }

        list.appendChild(item);
      });
    }

    renderCards();

    if (report.warnings.length && global.console && console.warn) {
      report.warnings.forEach(function (item) {
        console.warn("[EasyView] " + item.path + "：" + item.message);
      });
    }

    return {
      root: wrap,
      report: report,
      getState: function () {
        return state;
      }
    };
  }

  global.EasyViewRenderer = {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    ELEMENTS_VERSION: ELEMENTS_VERSION,
    ACTION_KINDS: ACTION_KINDS,
    INPUT_TYPES: INPUT_TYPES,
    validate: validate,
    sortCards: sortCards,
    render: render
  };
})(window);
