/* EasyView C 组 —— 页面内 DOM 提取脚本
 *
 * 职责边界（规范 §3 / 任务书 §9）：
 *   只做「客观描述」—— 读出网页有什么元素、什么类型、什么文本、在哪。
 *   不做「价值判断」—— 不给元素打分、不排序重要性、不决定哪个功能对老人最有用。
 *   不生成任何 HTML / CSS。
 *
 * 该脚本在浏览器上下文同步执行，返回原始结构；ID 生成与协议封装由 Python 侧完成
 * （见 ids.py / extractor.py），以保证 ID 规则可审计、可单测。
 */
() => {
  const MAX_TEXT = 200;
  const MAX_VALUE = 120;

  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  // 文档序索引：一次性建表，避免排序时对每个元素反复 querySelector。
  // 真实大页面（如 12306 首页）候选元素上千，原实现会产生上万次选择器查询。
  const DOC_ORDER = new Map();
  Array.prototype.forEach.call(document.querySelectorAll('*'), (n, i) => DOC_ORDER.set(n, i));

  /* ---------- 可见性 ---------- */
  function isVisible(el) {
    if (!el.isConnected) return false;
    const st = window.getComputedStyle(el);
    if (!st) return false;
    if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
    if (parseFloat(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /* ---------- 稳定 CSS 选择器 ---------- */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) {
      const sel = '#' + CSS.escape(el.id);
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) { /* ignore */ }
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(
          parent.children, (c) => c.tagName === node.tagName
        );
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      const sel = parts.join(' > ');
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) { /* ignore */ }
      node = parent;
    }
    return parts.join(' > ');
  }

  /* ---------- 绝对 XPath（任务书 §6 要求字段） ---------- */
  function xpathOf(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let idx = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) idx += 1;
        sib = sib.previousElementSibling;
      }
      parts.unshift(node.tagName.toLowerCase() + '[' + idx + ']');
      node = node.parentElement;
    }
    return '/' + parts.join('/');
  }

  /* ---------- 文本：取值优先级冻结见 docs/PROTOCOL.md §1.1 ---------- */
  function textOf(el) {
    // 表单容器若走通用路径，innerText 会把所有字段拼成一大段噪声，无助于理解。
    // 改为只取它的标题（legend / aria-label）——这是表单的客观名称。
    if (el.tagName === 'FORM') {
      const fa = norm(el.getAttribute('aria-label'));
      if (fa) return fa.slice(0, MAX_TEXT);
      const lg = el.querySelector('legend');
      if (lg) { const t = norm(lg.innerText); if (t) return t.slice(0, MAX_TEXT); }
    }
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria.slice(0, MAX_TEXT);
    const inner = norm(el.innerText || '');
    if (inner) return inner.slice(0, MAX_TEXT);
    const tc = norm(el.textContent || '');
    if (tc) return tc.slice(0, MAX_TEXT);
    const ph = norm(el.getAttribute('placeholder'));
    if (ph) return ph.slice(0, MAX_TEXT);
    const val = norm(el.value);
    if (val) return val.slice(0, MAX_TEXT);
    const alt = norm(el.getAttribute('alt'));
    if (alt) return alt.slice(0, MAX_TEXT);
    const title = norm(el.getAttribute('title'));
    if (title) return title.slice(0, MAX_TEXT);
    return '';
  }

  /* ---------- 表单控件的关联标签 ----------
   * 纯客观的 DOM 关联查询（label[for] / 包裹 label / aria-labelledby / 紧邻 label），
   * 不做任何语义猜测。B 拿到 input 时能直接知道它对应的中文名，
   * 不必靠「按文档序猜上一个文本节点」。
   */
  function labelOf(el) {
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') return null;
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) { const t = norm(l.innerText); if (t) return t.slice(0, MAX_TEXT); }
    }
    const wrap = el.closest('label');
    if (wrap) { const t = norm(wrap.innerText); if (t) return t.slice(0, MAX_TEXT); }
    const al = norm(el.getAttribute('aria-label'));
    if (al) return al.slice(0, MAX_TEXT);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const n = document.getElementById(lb);
      if (n) { const t = norm(n.innerText); if (t) return t.slice(0, MAX_TEXT); }
    }
    let prev = el.previousElementSibling;
    let hops = 0;
    while (prev && hops < 2) {
      if (prev.tagName === 'LABEL') { const t = norm(prev.innerText); if (t) return t.slice(0, MAX_TEXT); }
      prev = prev.previousElementSibling;
      hops += 1;
    }
    return null;
  }

  /* ---------- 客观结构类型（不看语义重要性） ---------- */
  function typeOf(el) {
    const tag = el.tagName.toLowerCase();
    const role = norm(el.getAttribute('role')).toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'form') return 'form';
    if (tag === 'iframe') return 'iframe';
    if (tag === 'table') return 'table';
    if (tag === 'nav') return 'nav';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'image';
    if (tag === 'input') {
      const t = norm(el.getAttribute('type')).toLowerCase() || 'text';
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'submit';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'input';
    }
    if (role === 'button') return 'button';
    if (role === 'link') return 'link';
    if (role === 'navigation') return 'nav';
    if (role === 'heading') return 'heading';
    return 'text';
  }

  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, ' +
    '[role="button"], [role="link"], [onclick]';
  const STRUCTURAL = 'form, nav, h1, h2, h3, h4, h5, h6, img[alt], iframe, table, ' +
    '[role="navigation"], [role="main"], [role="search"], [role="banner"], [role="contentinfo"]';
  const TEXTY = 'p, li, td, th, label, dt, dd, figcaption, blockquote';

  /* ---------- 分组：B 做功能聚类最需要的归属信息 ---------- */
  const GROUP_TAGS = {
    form: 'form', nav: 'nav', header: 'header', footer: 'footer',
    aside: 'aside', main: 'main', table: 'table'
  };

  function groupLabel(node, type) {
    const aria = norm(node.getAttribute('aria-label'));
    if (aria) return aria.slice(0, MAX_TEXT);
    if (type === 'form') {
      const lg = node.querySelector('legend');
      if (lg) { const t = norm(lg.innerText); if (t) return t.slice(0, MAX_TEXT); }
    }
    if (type === 'nav') {
      const t = norm(node.getAttribute('title'));
      if (t) return t.slice(0, MAX_TEXT);
    }
    let prev = node.previousElementSibling;
    let hops = 0;
    while (prev && hops < 3) {
      if (/^h[1-6]$/.test(prev.tagName)) { const t = norm(prev.innerText); if (t) return t.slice(0, MAX_TEXT); }
      prev = prev.previousElementSibling;
      hops += 1;
    }
    const head = node.querySelector('h1, h2, h3, h4, h5, h6');
    if (head) { const t = norm(head.innerText); if (t) return t.slice(0, MAX_TEXT); }
    return '';
  }

  // 收集分组节点：结构标签 + 链接数 >= 3 的列表（典型菜单）
  const groupNodes = [];
  const seenGroup = new Set();
  function addGroup(node, type) {
    if (seenGroup.has(node)) return;
    seenGroup.add(node);
    groupNodes.push({ node: node, type: type });
  }

  Object.keys(GROUP_TAGS).forEach((type) => {
    Array.prototype.forEach.call(document.querySelectorAll(GROUP_TAGS[type]), (n) => addGroup(n, type));
  });
  Array.prototype.forEach.call(document.querySelectorAll('ul, ol'), (n) => {
    if (n.querySelectorAll('a[href]').length >= 3) addGroup(n, 'list');
  });

  function groupOf(el) {
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      if (seenGroup.has(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /* ---------- select 的选项 ---------- */
  function selectOptionsOf(selectEl) {
    return Array.prototype.map.call(selectEl.options || [], (opt) => ({
      label: norm(opt.text) || norm(opt.value) || '',
      value: norm(opt.value) || norm(opt.text) || '',
      selected: !!opt.selected,
      // select 的选项由 A 按 value 匹配 <option>，不需要逐项 selector（A 组已确认）
      selector: null
    }));
  }

  /* ---------- radio / checkbox 分组 ----------
   * 一个 radio/checkbox 组在语义上是「一个问题 + N 个选项」，但在 DOM 上是 N 个独立元素。
   * 协议里一个 field 只能带一个 selector，所以必须在 C 侧就把它们合并成「一个元素」，
   * 再在 options[] 里给出每个选项各自的 selector —— 否则 A 无法逐项勾选。
   */
  function commonAncestor(nodes) {
    if (!nodes.length) return null;
    let anc = nodes[0].parentElement;
    while (anc && anc !== document.documentElement) {
      let covers = true;
      for (let i = 0; i < nodes.length; i += 1) {
        if (!anc.contains(nodes[i])) { covers = false; break; }
      }
      if (covers) return anc;
      anc = anc.parentElement;
    }
    return document.body;
  }

  function choiceGroupLabel(container) {
    if (!container) return '';
    const fs = container.closest ? container.closest('fieldset') : null;
    if (fs) {
      const lg = fs.querySelector('legend');
      if (lg) { const t = norm(lg.innerText); if (t) return t.slice(0, MAX_TEXT); }
    }
    const rg = container.closest
      ? container.closest('[role="radiogroup"], [role="group"]') : null;
    if (rg) {
      const t = norm(rg.getAttribute('aria-label'));
      if (t) return t.slice(0, MAX_TEXT);
    }
    let prev = container.previousElementSibling;
    let hops = 0;
    while (prev && hops < 2) {
      if (prev.tagName === 'LABEL' || /^h[1-6]$/.test(prev.tagName)) {
        const t = norm(prev.innerText); if (t) return t.slice(0, MAX_TEXT);
      }
      prev = prev.previousElementSibling;
      hops += 1;
    }
    return '';
  }

  function choiceOptionLabel(input) {
    const own = labelOf(input);
    if (own) return own;
    const v = norm(input.value);
    if (v) return v.slice(0, MAX_TEXT);
    const al = norm(input.getAttribute('aria-label'));
    return al ? al.slice(0, MAX_TEXT) : '';
  }

  function choiceGroups() {
    const inputs = Array.prototype.slice.call(
      document.querySelectorAll('input[type="radio"], input[type="checkbox"]')
    );
    const buckets = new Map();
    inputs.forEach((el) => {
      const form = el.form || (el.closest ? el.closest('form') : null);
      const formKey = form ? cssPath(form) : '__noform__';
      const nm = norm(el.getAttribute('name'));
      // 没有 name 的控件无法成组，按每个控件独立处理
      const key = nm
        ? (formKey + '::' + nm)
        : (formKey + '::__anon__' + (DOC_ORDER.has(el) ? DOC_ORDER.get(el) : 0));
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(el);
    });
    return buckets;
  }

  /* ---------- 采集候选元素 ---------- */
  // radio / checkbox 不按单元素采集，改为按 name 合并成「选项组」。
  // 组容器本身也一并排除：否则容器（常常是个 <label> 或 <fieldset>）会作为普通元素
  // 再次被采集，两者 selector 相同 -> ID 相同 -> 被 builder 的去重逻辑丢弃，
  // 结果就是「选项组整个消失」。由组元素代表容器是语义上更正确的选择。
  const choiceBuckets = choiceGroups();
  const choiceMember = new Set();
  const choiceContainers = new Set();
  choiceBuckets.forEach((list) => {
    list.forEach((el) => choiceMember.add(el));
    const c = commonAncestor(list);
    if (c) choiceContainers.add(c);
  });

  const candidates = [];
  const seenEl = new Set();
  function addCandidate(el, rank) {
    if (choiceContainers.has(el)) return;
    if (seenEl.has(el)) {
      const rec = candidates.find((c) => c.el === el);
      if (rec && rank < rec.rank) rec.rank = rank;
      return;
    }
    seenEl.add(el);
    candidates.push({ el: el, rank: rank });
  }

  Array.prototype.forEach.call(document.querySelectorAll(INTERACTIVE), (el) => {
    if (choiceMember.has(el)) return;
    addCandidate(el, 0);
  });
  Array.prototype.forEach.call(document.querySelectorAll(STRUCTURAL), (el) => addCandidate(el, 0));

  // 可见文本：跳过「文本已完全包含在祖先文本块里」的嵌套节点，避免同一句话重复出现
  const textNodes = Array.prototype.slice.call(document.querySelectorAll(TEXTY));
  const textNodeSet = new Set(textNodes);
  textNodes.forEach((el) => {
    let child = el.firstElementChild;
    let nested = false;
    while (child) {
      if (textNodeSet.has(child)) { nested = true; break; }
      child = child.nextElementSibling;
    }
    if (!nested) addCandidate(el, 1);
  });

  /* ---------- 组装 ---------- */
  const rawElements = [];
  candidates.forEach((c) => {
    const el = c.el;
    const type = typeOf(el);
    const selector = cssPath(el);
    if (!selector) return;

    const visible = isVisible(el);
    const rect = visible ? el.getBoundingClientRect() : null;
    const gNode = groupOf(el);
    const formNode = el.closest ? el.closest('form') : null;

    const isPassword = el.tagName === 'INPUT' &&
      norm(el.getAttribute('type')).toLowerCase() === 'password';

    rawElements.push({
      type: type,
      text: textOf(el),
      label: labelOf(el),
      aria_label: norm(el.getAttribute('aria-label')) || null,
      placeholder: norm(el.getAttribute('placeholder')) || null,
      name: norm(el.getAttribute('name')) || null,
      // 密码框的 value 一律不采集，避免任何形式的凭据泄露
      value: isPassword ? null : (norm(el.value).slice(0, MAX_VALUE) || null),
      href: (el.tagName === 'A' && el.href) ? el.href : null,
      selector: selector,
      xpath: xpathOf(el),
      visible: visible,
      bbox: rect ? {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height)
      } : null,
      group_selector: gNode ? cssPath(gNode) : null,
      in_form: !!formNode,
      form_selector: formNode ? cssPath(formNode) : null,
      required: (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')
        ? !!el.required : null,
      disabled: !!el.disabled,
      level: /^h[1-6]$/.test(el.tagName) ? parseInt(el.tagName[1], 10) : null,
      options: type === 'select' ? selectOptionsOf(el) : null,
      // 截断优先级：可见交互元素(0) > 可见文本(1) > 隐藏交互元素(2) > 隐藏文本(3)。
      // 实测 12306 首页 400 个元素里仅 107 个可见，若不按可见性分级，
      // 隐藏元素会把 B 的预算吃光，导致 B 拿到的几乎全是页面上根本看不到的东西。
      _rank: c.rank + (visible ? 0 : 2),
      _order: DOC_ORDER.has(el) ? DOC_ORDER.get(el) : 0
    });
  });

  // ---------- radio / checkbox 组：合并为一个「选项组」元素 ----------
  choiceBuckets.forEach((members) => {
    if (!members.length) return;
    const sample = members[0];
    const container = commonAncestor(members);
    if (!container) return;
    const selector = cssPath(container);
    if (!selector) return;

    const isRadio = norm(sample.getAttribute('type')).toLowerCase() === 'radio';
    const visible = members.some(isVisible);
    const rect = visible ? container.getBoundingClientRect() : null;
    const gNode = groupOf(sample);
    const formNode = sample.form || (sample.closest ? sample.closest('form') : null);
    const groupText = members.length === 1
      // 单成员组（如一个「同意条款」复选框）没有独立的组标题，
      // 它的标签就是控件自己的标签；向上找 fieldset legend 会串成整张表单的名字。
      ? choiceOptionLabel(members[0])
      : choiceGroupLabel(container);

    rawElements.push({
      type: isRadio ? 'radio' : 'checkbox',
      text: groupText,
      label: groupText || null,
      aria_label: norm(container.getAttribute('aria-label')) || null,
      placeholder: null,
      name: norm(sample.getAttribute('name')) || null,
      value: null,
      href: null,
      selector: selector,
      xpath: xpathOf(container),
      visible: visible,
      bbox: rect ? {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height)
      } : null,
      group_selector: gNode ? cssPath(gNode) : null,
      in_form: !!formNode,
      form_selector: formNode ? cssPath(formNode) : null,
      required: members.some((m) => !!m.required),
      disabled: members.every((m) => !!m.disabled),
      level: null,
      // 每个选项自带 selector —— A 靠它逐项勾选并触发 input/change。
      // 只给 element_id 不够：A 不持有 elements.json，无法用它定位 DOM。
      options: members.map((m) => ({
        label: choiceOptionLabel(m),
        value: norm(m.value),
        selected: !!m.checked,
        selector: cssPath(m)
      })),
      _rank: 0 + (visible ? 0 : 2),
      _order: DOC_ORDER.has(container) ? DOC_ORDER.get(container) : 0
    });
  });

  // DOM 文档序，保证 B 的排序与用户在页面上看到的顺序一致
  rawElements.sort((a, b) => a._order - b._order);

  const rawGroups = groupNodes.map((g) => ({
    selector: cssPath(g.node),
    type: g.type,
    label: groupLabel(g.node, g.type)
  })).filter((g) => g.selector);

  return {
    page_title: norm(document.title),
    final_url: location.href,
    lang: norm(document.documentElement.getAttribute('lang')) || null,
    elements: rawElements,
    groups: rawGroups
  };
}
