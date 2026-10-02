(function () {
  "use strict";

  // Only public pages operated by China Mobile are used here. Authentication,
  // account data and payment remain on the original website.
  const officialPages = Object.freeze({
    balance: "https://www.10086.cn/barrierFree/",
    rechargeHome: "https://shop.10086.cn/",
    data: "https://shop.10086.cn/i/?f=packremainqry",
    services: "https://shop.10086.cn/i/?f=busiqrydeal",
    stores: "https://www.10086.cn/support/service/channel/entity/"
  });

  const rechargeAmounts = ["50", "100", "300", "500"];

  function openOfficialPage(page) {
    const url = officialPages[page];
    if (!url) return { ok: false, reason: "暂时无法打开中国移动服务页面。" };
    window.location.assign(url);
    return { ok: true };
  }

  function openRechargeForm() {
    if (findRechargeControls()) return { ok: true, onPage: true };
    window.location.assign(`${officialPages.rechargeHome}#easyview-recharge`);
    return { ok: true, onPage: false };
  }

  function findRechargeControls() {
    const form = [...document.querySelectorAll(".con_hfcz.cz")]
      .find((node) => node.getClientRects().length > 0);
    if (!form) return null;
    const phone = form.querySelector('input[name="phonenum"]');
    const amount = form.querySelector('input[name="amount"]');
    const options = [...form.querySelectorAll(".select_yuan a")];
    if (!(phone instanceof HTMLInputElement) || !(amount instanceof HTMLInputElement) || !options.length) return null;
    return { form, phone, amount, options };
  }

  function canSyncRecharge() {
    return Boolean(findRechargeControls());
  }

  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function syncRecharge(phoneNumber, amountValue) {
    const phone = String(phoneNumber).trim();
    const amount = String(amountValue).trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return { ok: false, reason: "请输入11位手机号，并核对是否为要充值的中国移动号码。" };
    }
    if (!rechargeAmounts.includes(amount)) {
      return { ok: false, reason: "当前官方首页支持50、100、300或500元，请选择其中一个金额。" };
    }
    const controls = findRechargeControls();
    if (!controls) {
      return { ok: false, reason: "暂时找不到中国移动官方充值表单，请在原页面填写。" };
    }
    const option = controls.options.find((node) => node.textContent.trim() === `${amount} 元`);
    if (!option) {
      return { ok: false, reason: "官方页面暂时没有这个充值金额，请在原页面选择。" };
    }
    setNativeValue(controls.phone, phone);
    option.click();
    if (controls.phone.value.trim() !== phone || controls.amount.value.trim() !== amount) {
      return { ok: false, reason: "中国移动页面未确认手机号或金额，请在原页面核对。" };
    }
    return { ok: true, target: controls.phone };
  }

  window.EasyView10086 = {
    openOfficialPage,
    openRechargeForm,
    canSyncRecharge,
    syncRecharge
  };
})();
