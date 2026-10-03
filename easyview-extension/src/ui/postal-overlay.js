(function () {
  "use strict";

  const rootId = "easyview-postal-root";

  /** 读一次原站品牌令牌写进 Shadow DOM；与 12306 覆盖层共用同一套接口。 */
  function themeShadow(shadow) {
    const api = window.EasyViewBrand;
    if (!api || typeof api.extract !== "function") return null;
    const theme = api.extract();
    api.apply(theme, shadow);
    return theme;
  }

  function create() {
    if (document.getElementById(rootId)) return;
    const host = document.createElement("div");
    host.id = rootId;
    document.documentElement.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = chrome.runtime.getURL("src/styles.css");
    shadow.append(stylesheet);
    themeShadow(shadow);

    const launcher = document.createElement("button");
    launcher.className = "ev-launcher ev-postal-launcher";
    launcher.type = "button";
    launcher.textContent = "👴 敬老版";
    launcher.setAttribute("aria-label", "打开中国邮政敬老版");
    launcher.addEventListener("click", () => show(shadow));
    shadow.append(launcher);
  }

  function show(shadow) {
    if (shadow.querySelector(".ev-overlay")) return;
    const theme = themeShadow(shadow);
    const launcher = shadow.querySelector(".ev-launcher");
    launcher.hidden = true;
    const overlay = document.createElement("section");
    overlay.className = "ev-overlay ev-postal";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "中国邮政敬老版");

    const panel = document.createElement("div");
    panel.className = "ev-panel";
    const header = document.createElement("header");
    header.className = "ev-header";
    const brand = document.createElement("div");
    brand.className = "ev-brandline";
    if (theme && theme.logoUrl && window.EasyViewBrand) {
      const logoSlot = document.createElement("div");
      logoSlot.className = "ev-logoslot";
      window.EasyViewBrand.mountLogo(logoSlot, theme, { textFallback: false });
      if (logoSlot.childNodes.length) brand.append(logoSlot);
    }
    const brandCopy = document.createElement("div");
    brandCopy.className = "ev-brandcopy";
    const title = document.createElement("h1");
    title.textContent = "中国邮政敬老版";
    if (theme && window.EasyViewBrand
        && window.EasyViewBrand.logoRepeatsHeading(theme, title.textContent)) {
      title.className = "ev-sr-only";
    }
    const summary = document.createElement("p");
    summary.textContent = "查邮件、寄包裹、订报刊、找邮局。请在邮政官方页面核对并办理。";
    brandCopy.append(title, summary);
    brand.append(brandCopy);
    const exit = makeButton("退出敬老版", () => {
      overlay.remove();
      launcher.hidden = false;
      launcher.focus();
    }, true);
    exit.className = "ev-exit";
    header.append(brand, exit);
    const content = document.createElement("main");
    content.className = "ev-content";
    panel.append(header, content);
    overlay.append(panel);
    shadow.append(overlay);

    function openPage(name) {
      try {
        const result = window.EasyViewPostal.openOfficialPage(name);
        if (!result.ok) notice(result.reason);
      } catch (_) {
        notice("暂时无法打开邮政官方页面，请退出敬老版后在原页面办理。");
      }
    }

    function notice(message) {
      content.querySelector(".ev-notice")?.remove();
      const node = document.createElement("p");
      node.className = "ev-message ev-error ev-notice";
      node.setAttribute("role", "alert");
      node.textContent = message;
      content.prepend(node);
    }

    function renderHome() {
      content.replaceChildren();
      const cards = document.createElement("div");
      cards.className = "ev-actions";
      const tracking = makeCard("search", "⌕", "查我的邮件到哪了", "输入邮件编号，查包裹、挂号信和通知书", renderTracking);
      tracking.classList.add("ev-buy");
      cards.append(
        tracking,
        makeCard("home", "⌂", "寄东西给子女", "预约快递员上门取件", renderSend),
        makeCard("document", "▤", "订报纸、订杂志", "《参考消息》《读者》等报刊", () => renderSubscription()),
        makeCard("location", "⌖", "附近邮局和营业时间", "查地址、电话和营业时间，出门前先确认", () => renderStores()),
        makeCard("payment", "¥", "寄件要多少钱", "按寄达地区和重量查询官方资费", renderPostage),
        makeCard("warning", "!", "防诈骗提醒", "“快递异常”“包裹理赔”来电要当心", renderSafety),
        makeCard("search", "▦", "邮编速查", "按地址查邮政编码", () => openPage("postcode")),
        makeCard("phone", "☎", "打电话找人工", "邮政 11185 · EMS 11183 · 邮储 95580", renderPhone),
        makeCard("help", "?", "常见问题", "查挂号信、汇款时效和包裹问题", renderFaq)
      );
      content.append(cards);
      overlay.scrollTop = 0;
    }

    function renderTracking() {
      content.replaceChildren();
      const heading = makeHeading("查我的邮件到哪了");
      const intro = paragraph("请输入邮件编号。为保护隐私，敬老版不会保存单号；打开邮政官方查询页后，请把单号填入“邮件号查询”。");
      const form = document.createElement("form");
      form.className = "ev-flow-body";
      const code = field("邮件编号", "text", "请按邮件面单或短信填写");
      code.input.autocomplete = "off";
      code.input.maxLength = 30;
      code.input.minLength = 6;
      const submit = makeButton("下一步", () => {
        if (!form.reportValidity()) return;
        renderPrepared("单号已准备", "打开邮政官方邮件查询页后，请选择“邮件号查询”并填入以下单号。", [
          ["邮件编号", code.input.value.trim()]
        ], "tracking", "打开官方邮件查询");
      });
      form.addEventListener("submit", (event) => { event.preventDefault(); submit.click(); });
      form.append(code.wrapper, submit);
      content.append(heading, intro, form,
        makeButton("返回业务选择", renderHome, true));
      heading.focus();
      code.input.focus();
    }

    function renderSend() {
      content.replaceChildren();
      const heading = makeHeading("预约快递员上门取件");
      const intro = paragraph("先整理寄件资料，再到 EMS 官方页面填写并确认。敬老版不会保存或提交姓名、电话和地址。");
      const form = document.createElement("form");
      form.className = "ev-flow-body";
      const name = field("寄件人姓名", "text", "请输入姓名");
      name.input.autocomplete = "name";
      const phone = field("联系电话", "tel", "请输入手机号码");
      phone.input.autocomplete = "tel";
      phone.input.inputMode = "tel";
      phone.input.pattern = "1[3-9][0-9]{9}";
      const address = field("上门取件地址", "text", "请填写省、市、区和详细地址");
      address.input.autocomplete = "street-address";
      const date = field("希望取件日期", "date", "");
      date.input.min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      const submit = makeButton("下一步，核对寄件资料", () => {
        if (!form.reportValidity()) return;
        renderPrepared("请核对寄件资料", "请在 EMS 官方预约页面重新填写以下信息，并以 EMS 页面最终确认结果为准。", [
          ["寄件人", name.input.value.trim()],
          ["联系电话", phone.input.value.trim()],
          ["取件地址", address.input.value.trim()],
          ["希望取件日期", date.input.value]
        ], "send", "继续到 EMS 官方预约");
      });
      form.addEventListener("submit", (event) => { event.preventDefault(); submit.click(); });
      form.append(name.wrapper, phone.wrapper, address.wrapper, date.wrapper, submit);
      content.append(heading, intro, form,
        paragraph("官方预约页面需要重新填写资料，并以页面可选服务和最终确认结果为准。"),
        makeButton("返回业务选择", renderHome, true));
      heading.focus();
    }

    function renderSubscription() {
      content.replaceChildren();
      const heading = makeHeading("订报纸、订杂志");
      content.append(heading,
        paragraph("在中国邮政报刊商城搜索报纸或杂志名称，例如《参考消息》《读者》。订阅品种、期数、价格和配送范围以商城页面为准。"),
        makeButton("打开中国邮政报刊商城", () => openPage("newspaper")),
        makeButton("返回业务选择", renderHome, true));
      heading.focus();
    }

    function renderStores() {
      content.replaceChildren();
      const heading = makeHeading("附近邮局和营业时间");
      content.append(heading,
        paragraph("在邮政官方网点查询页选择省、市和区县，查看网点地址与电话。网点业务和营业时间可能有变化，出门前请先打电话确认。"),
        makeButton("打开全国网点查询", () => openPage("stores")),
        makeButton("返回业务选择", renderHome, true));
      heading.focus();
    }

    function renderPostage() {
      content.replaceChildren();
      const heading = makeHeading("查询邮件资费");
      const intro = paragraph("先填写预计寄达范围和重量，打开邮政官方页面后还需选择具体地址和邮件类型。最终资费以官网查询结果和网点实际收寄为准。");
      const form = document.createElement("form");
      form.className = "ev-flow-body";
      const destination = document.createElement("label");
      destination.className = "ev-field";
      const caption = document.createElement("span");
      caption.textContent = "寄达范围";
      const select = document.createElement("select");
      select.className = "ev-filter-select";
      select.required = true;
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "请选择寄达范围";
      placeholder.disabled = true;
      placeholder.selected = true;
      select.append(placeholder);
      for (const value of ["国内（不含港澳台）", "中国港澳台", "国际"] ) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.append(option);
      }
      destination.append(caption, select);
      const weight = field("邮件重量（千克）", "number", "例如：1");
      weight.input.min = "0.01";
      weight.input.step = "0.01";
      weight.input.max = "100";
      weight.input.inputMode = "decimal";
      const submit = makeButton("下一步，核对查询条件", () => {
        if (!form.reportValidity()) return;
        renderPrepared("请核对资费查询条件", "打开邮政官方资费页后，还需选择详细寄达地址和邮件类型。费用以官网结果为准。", [
          ["寄达范围", select.value],
          ["重量", `${weight.input.value} 千克`]
        ], "postage", "打开官方资费查询");
      });
      form.addEventListener("submit", (event) => { event.preventDefault(); submit.click(); });
      form.append(destination, weight.wrapper, submit);
      content.append(heading, intro, form,
        makeButton("返回业务选择", renderHome, true));
      heading.focus();
    }

    function renderPrepared(titleText, introText, rows, page, buttonText) {
      content.replaceChildren();
      const heading = makeHeading(titleText);
      const list = document.createElement("dl");
      list.className = "ev-postal-summary";
      for (const [label, value] of rows) {
        const term = document.createElement("dt");
        term.textContent = label;
        const detail = document.createElement("dd");
        detail.textContent = value;
        list.append(term, detail);
      }
      content.append(heading, paragraph(introText), list,
        makeButton(buttonText, () => openPage(page)),
        makeButton("返回修改", page === "tracking" ? renderTracking : page === "send" ? renderSend : renderPostage, true),
        makeButton("返回业务选择", renderHome, true));
      heading.focus();
      overlay.scrollTop = 0;
    }

    function renderSafety() {
      content.replaceChildren();
      const heading = makeHeading("防诈骗提醒");
      const list = document.createElement("ul");
      list.className = "ev-guide-steps";
      for (const text of [
        "接到“快递异常、包裹丢失、理赔退款”电话，先挂断，再通过官方客服电话核实。",
        "不要向陌生人提供短信验证码、银行卡密码，也不要按对方要求转账。",
        "需要查询邮件时，请自己打开中国邮政或 EMS 官方页面。"
      ]) {
        const item = document.createElement("li");
        item.textContent = text;
        list.append(item);
      }
      content.append(heading, list,
        makeButton("拨打邮政官方客服 11185", () => { window.location.href = "tel:11185"; }),
        makeButton("返回业务选择", renderHome, true));
      heading.focus();
    }

    function renderPhone() {
      content.replaceChildren();
      const heading = makeHeading("打电话找人工");
      const list = document.createElement("div");
      list.className = "ev-guide-actions";
      list.append(
        makeLink("中国邮政业务：11185", "tel:11185"),
        makeLink("中国邮政 EMS：11183", "tel:11183"),
        makeLink("中国邮政储蓄银行：95580", "tel:95580")
      );
      content.append(heading, paragraph("手机可点号码拨打；桌面电脑请用电话联系。"), list,
        makeButton("返回业务选择", renderHome, true));
      heading.focus();
    }

    function renderFaq() {
      content.replaceChildren();
      const heading = makeHeading("常见问题");
      const questions = [
        ["挂号信或包裹怎么查？", "准备邮件编号，打开“邮件查询”，选择邮件号查询并按页面提示操作。"],
        ["汇款多久能到？", "时效因汇款方式和办理网点而异，请拨打邮政 11185 或邮储银行 95580 核实。"],
        ["包裹丢了怎么办？", "保留邮件编号和寄件凭证，通过 11185 或 EMS 11183 联系官方客服查询处理。"],
        ["网点今天营业吗？", "先查网点电话，再致电确认营业时间和可办理业务。"]
      ];
      const list = document.createElement("div");
      list.className = "ev-postal-faq";
      for (const [question, answer] of questions) {
        const section = document.createElement("section");
        const title = document.createElement("h3");
        title.textContent = question;
        section.append(title, paragraph(answer));
        list.append(section);
      }
      content.append(heading, list, makeButton("返回业务选择", renderHome, true));
      heading.focus();
    }

    renderHome();
  }

  function field(label, type, placeholder) {
    const wrapper = document.createElement("label");
    wrapper.className = "ev-field";
    const caption = document.createElement("span");
    caption.textContent = label;
    const input = document.createElement("input");
    input.type = type;
    input.placeholder = placeholder;
    input.required = true;
    wrapper.append(caption, input);
    return { wrapper, input };
  }

  function makeHeading(text) {
    const heading = document.createElement("h2");
    heading.textContent = text;
    heading.tabIndex = -1;
    return heading;
  }

  function paragraph(text) {
    const node = document.createElement("p");
    node.className = "ev-message";
    node.textContent = text;
    return node;
  }

  function makeButton(text, onClick, secondary = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = secondary ? "ev-button ev-button-secondary" : "ev-button ev-button-primary";
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  function makeLink(text, href) {
    const link = document.createElement("a");
    link.className = "ev-button ev-button-secondary ev-postal-link";
    link.href = href;
    link.textContent = text;
    return link;
  }

  function makeCard(iconName, symbol, title, subtitle, onClick) {
    const card = document.createElement("button");
    card.type = "button";
    card.addEventListener("click", onClick);
    card.className = "ev-card";
    card.dataset.icon = iconName;
    const icon = document.createElement("span");
    icon.className = "ev-card-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = symbol;
    const copy = document.createElement("span");
    copy.className = "ev-card-copy";
    const heading = document.createElement("strong");
    heading.textContent = title;
    const description = document.createElement("span");
    description.textContent = subtitle;
    copy.append(heading, description);
    card.append(icon, copy);
    return card;
  }

  window.EasyViewPostalOverlay = { create };
})();
