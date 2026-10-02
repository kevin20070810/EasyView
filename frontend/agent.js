(function () {
  "use strict";

  function normalize(value) {
    return String(value || "").replace(/\s+/g, "").toLowerCase();
  }

  function classify(schema) {
    if (!schema) return "operation";
    if (schema.pageType === "article") return "article";
    if (schema.pageType === "operation") return "operation";
    if (schema.content && Array.isArray(schema.content)) return "article";
    if (schema.flow && schema.flow.steps) return "operation";
    var components = schema.components || [];
    var hasAction = components.some(function (item) {
      return item && (item.type === "ActionGroup" || item.type === "FormStep");
    });
    return hasAction ? "operation" : "article";
  }

  function getFlow(schema) {
    return (schema && schema.flow && schema.flow.steps) || [];
  }

  function getStep(schema, state) {
    var steps = getFlow(schema);
    var index = state && typeof state.currentStep === "number" ? state.currentStep : 0;
    return steps[Math.min(index, steps.length - 1)] || null;
  }

  function recommendedOption(step) {
    var options = (step && step.options) || [];
    var marked = options.find(function (option) {
      return option && option.recommend;
    });
    return marked || options[0] || null;
  }

  function extractArticleText(schema) {
    if (!schema) return "";
    var parts = [];
    (schema.content || []).forEach(function (block) {
      if (block && block.text) parts.push(block.text);
    });
    if (!parts.length && schema.summary) parts.push(schema.summary);
    return parts.join("\n");
  }

  function splitSentences(text) {
    return String(text || "")
      .split(/(?<=[。！？；])/)
      .map(function (part) {
        return part.trim();
      })
      .filter(Boolean);
  }

  function findSentence(text, keywords) {
    var sentences = splitSentences(text);
    for (var i = 0; i < sentences.length; i += 1) {
      for (var j = 0; j < keywords.length; j += 1) {
        if (sentences[i].indexOf(keywords[j]) !== -1) return sentences[i];
      }
    }
    return "";
  }

  function operationAnswer(question, schema, state) {
    var step = getStep(schema, state);
    if (!step) return "当前没有可操作的步骤。";
    var q = normalize(question);
    var rec = recommendedOption(step);
    var recText = rec ? rec.label : "下一步按钮";

    if (/下一步|怎么办|怎么操作|该选|点哪|点哪个|继续/.test(q)) {
      return "请点击页面中高亮显示的「" + recText + "」按钮，点击后还会再和您确认一次。";
    }
    if (/重说|再说|再读|提示/.test(q)) {
      return step.prompt + "。建议选择「" + recText + "」。";
    }
    if (/科室|挂什么|选什么科/.test(q)) {
      return "当前正在选择科室。如果不确定，可以先选择「内科」，也可以告诉我您的症状，我会帮您推荐。";
    }
    if (/完成|结束|退|取消/.test(q)) {
      return "您可以按页面上的「上一步」返回，也可以继续完成当前操作。";
    }
    return "现在是挂号流程第 " + (Math.min((state && state.currentStep) || 0, getFlow(schema).length - 1) + 1) + " 步：" + step.title + "。" + step.prompt + "。建议选择「" + recText + "」。";
  }

  function articleAnswer(question, schema) {
    var q = normalize(question);
    var text = extractArticleText(schema);
    var summary = schema && schema.summary ? schema.summary : "";

    if (/总结|讲了什么|说什么|是什么/.test(q)) {
      return summary || "这份通知介绍了居民医保的参保对象、缴费时间、缴费标准、办理方式和所需材料。";
    }
    if (/截止|期限|什么时候|何时|缴费时间|12月|逾期/.test(q)) {
      return findSentence(text, ["缴费期", "2026年10月1日", "12月31日", "逾期"]) || summary;
    }
    if (/多少钱|标准|费用|多少/.test(q)) {
      return findSentence(text, ["380元", "670元", "标准"]) || "2026年度个人缴费标准为每人每年380元。";
    }
    if (/材料|证件|带什么|需要什么|身份证|户口/.test(q)) {
      return findSentence(text, ["身份证", "户口簿", "材料", "携带"]) || "首次参保请携带本人身份证和户口簿。";
    }
    if (/怎么|如何|办理|缴费|支付|方式/.test(q)) {
      return findSentence(text, ["办理", "小程序", "缴费", "微信"]) || summary;
    }
    if (/哪里|地址|地点|去哪|社区|街道/.test(q)) {
      return findSentence(text, ["街道", "社区", "服务站", "便民"]) || "可到各街道便民服务中心或社区医保服务站办理。";
    }
    if (/电话|热线|咨询/.test(q)) {
      return findSentence(text, ["12393", "热线", "咨询"]) || "如有疑问，可拨打医保服务热线 12393。";
    }
    if (/对象|谁能|谁能参保|学生/.test(q)) {
      return findSentence(text, ["城乡居民", "在校学生", "参保对象"]) || "本市未参加职工医保的城乡居民和全日制在校学生均属于参保范围。";
    }
    return summary || "我已阅读这份通知。您可以问我缴费时间、缴费标准、所需材料、办理方式或咨询电话。";
  }

  function buildPrompt(question, schema, state) {
    var pageType = classify(schema);
    var context = pageType === "article" ? extractArticleText(schema) : JSON.stringify(getStep(schema, state) || {});
    return "你是面向老年人的页面助手。请用简洁、礼貌的中文回答。\n页面类型：" + pageType + "\n问题：" + question + "\n页面内容：" + context;
  }

  function ruleAnswer(question, schema, state) {
    return classify(schema) === "article"
      ? articleAnswer(question, schema)
      : operationAnswer(question, schema, state);
  }

  async function answer(question, schema, state) {
    var ai = window.ai;
    if (ai && ai.languageModel && typeof ai.languageModel.prompt === "function") {
      try {
        var result = await ai.languageModel.prompt(buildPrompt(question, schema, state));
        if (result) return { text: String(result), source: "本地模型" };
      } catch (error) {
        // 模型不可用时自动落到规则引擎。
      }
    }
    return { text: ruleAnswer(question, schema, state), source: "规则引擎" };
  }

  function currentInstruction(schema, state) {
    if (classify(schema) !== "operation") return "";
    var step = getStep(schema, state);
    if (!step) return "";
    var rec = recommendedOption(step);
    if (step.isFinal) return "请确认预约信息，确认无误后点击「确认并完成挂号」。";
    return step.prompt + "，建议选择「" + (rec ? rec.label : "下一步") + "」。";
  }

  window.EasyViewAgent = {
    classify: classify,
    answer: answer,
    currentInstruction: currentInstruction,
    extractArticleText: extractArticleText,
    recommendedOption: recommendedOption,
    getStep: getStep,
    getFlow: getFlow
  };
})();
