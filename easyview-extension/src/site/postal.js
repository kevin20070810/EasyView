(function () {
  "use strict";

  const officialPages = Object.freeze({
    tracking: "https://dey.11185.cn/web/#/waybillno",
    send: "https://www.ems.com.cn/domestic_order",
    newspaper: "https://mall.11185.cn/web/newsPaper",
    stores: "https://dey.11185.cn/web/#/dotquery",
    postage: "https://dey.11185.cn/web/#/jdpostage",
    postcode: "https://dey.11185.cn/web/#/idtoolkitAddress"
  });

  function openOfficialPage(name) {
    const url = officialPages[name];
    if (!url) return { ok: false, reason: "暂时无法打开邮政官方业务页面。" };
    window.open(url, "_blank", "noopener,noreferrer");
    return { ok: true };
  }

  window.EasyViewPostal = { openOfficialPage };
})();
