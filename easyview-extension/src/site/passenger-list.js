/* EasyView · 12306 乘车人列表解析
 *
 * 为什么单独一个文件：乘车人页需要登录态才能看到，自动化测试进不去，
 * 所以这里写得【尽量防御】—— 候选选择器多列几个，读不到就返回空数组，
 * 由上层如实告诉用户"这一页没找到乘车人"，而不是假装成功。
 *
 * 12306 的乘车人列表历来是这种形状（不同版本 class/id 有出入）：
 *   <ul id="normal_passenger_id">
 *     <li><input type="checkbox" id="normal_passenger_id_0" value="...">
 *         <label for="normal_passenger_id_0">张爷爷</label></li>
 *   </ul>
 * 所以按"勾选框 + 紧邻的名字"来找，不依赖具体 id。
 */
(function () {
  "use strict";

  const LIST_SELECTORS = [
    "#normal_passenger_id",
    "#content_passengerList",
    "#passenger_list",
    "ul[id*='passenger']",
    ".passenger-list",
    "#normal_passenger"
  ];

  function textOf(node) {
    return node ? (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  /** 找一个乘车人的名字：优先 label，其次 li 的短文本。 */
  function nameOf(item) {
    const label = item.querySelector("label");
    const fromLabel = textOf(label);
    if (fromLabel) return fromLabel.replace(/^[\d\s.、]+/, "").slice(0, 12);
    const raw = textOf(item);
    // li 里常带"成人票""学生票"之类后缀，取最前一段当名字
    const first = raw.split(/[\s（(]/)[0];
    return first && first.length <= 12 ? first : raw.slice(0, 12);
  }

  function read() {
    let list = null;
    for (const sel of LIST_SELECTORS) {
      try {
        const found = document.querySelector(sel);
        if (found) { list = found; break; }
      } catch (_) { /* 选择器不合法就跳过 */ }
    }
    if (!list) return [];

    const items = [...list.querySelectorAll("li")].filter((li) => {
      const box = li.querySelector("input[type='checkbox'], input[type='radio']");
      return Boolean(box);
    });

    const out = [];
    for (const li of items) {
      const box = li.querySelector("input[type='checkbox'], input[type='radio']");
      const name = nameOf(li);
      if (!box || !name) continue;
      out.push({
        id: box.id || null,
        value: box.value || null,
        name,
        checked: Boolean(box.checked),
        node: box,
        item: li
      });
    }
    return out;
  }

  /** 切换原网页的乘车人勾选状态；不提交订单。 */
  function toggle(passenger) {
    const box = passenger && passenger.node;
    if (!box || !box.isConnected) return { ok: false, reason: "gone" };
    if (box.disabled) return { ok: false, reason: "disabled" };
    const before = Boolean(box.checked);
    box.click();
    const checked = Boolean(box.checked);
    return { ok: checked !== before, checked,
      reason: checked === before ? "unchanged" : undefined };
  }

  globalThis.EasyViewPassengers = { read, toggle };
})();
