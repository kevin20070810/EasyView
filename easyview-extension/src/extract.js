/* EasyView 简界 —— 页面内提取模块
 *
 * 职责边界（规范 §3）：只做「客观描述」——网页上有什么元素、什么类型、什么文本、在哪。
 * 不做价值判断（不打分、不排序重要性、不决定哪个功能对老人更有用），不生成任何 HTML/CSS。
 *
 * 本文件是**普通 content script**：没有构建步骤、不能用 import/export、加载后自动执行的
 * 只有「挂载接口」这一件事。调用方决定何时跑：
 *
 *   const { elements, resolve } = globalThis.EasyViewExtract.run();
 *   // elements → 一份完整的 elements.json（docs/elements.schema.json v1.1.0）
 *   // resolve  → 把 elements 里的 el_xxxxxxxx 换回真实 DOM 元素，供渲染层定位
 *
 * 元素与分组按文档顺序分配稳定的会话内 ID；selector / xpath 也会记录供绑定器核对。
 * resolve(id) 优先返回当前页面的元素，节点被替换时再用 selector 定位。
 * 可见性、截断和统计规则以本文件与 docs/elements.schema.json 为准。
 */
(function () {
  'use strict';

  /* ---------- 上限与常量 ---------- */
  const MAX_TEXT = 200;        // 单个文本/标签字段上限
  const MAX_VALUE = 120;       // 表单 value 上限
  // value 只在"value 本身就是标签"的按钮类控件上采集。
  // <input type="submit" value="查询"> 里 value 是按钮文字，属于页面内容；
  // 而 text / number / date / textarea / select 的 value 是**用户已经填进去的内容**，
  // 一律不采集 —— 老人可能先填了身份证号、手机号、住址，再点「适老」。
  const VALUE_AS_LABEL_TYPES = new Set(['submit', 'button', 'reset', 'image']);
  const MAX_ELEMENTS = 400;
  const SCHEMA_VERSION = '1.1.0';

  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, ' +
    '[role="button"], [role="link"], [onclick]';
  const STRUCTURAL = 'form, nav, h1, h2, h3, h4, h5, h6, img[alt], iframe, table, ' +
    '[role="navigation"], [role="main"], [role="search"], [role="banner"], [role="contentinfo"]';
  const TEXTY = 'p, li, td, th, label, dt, dd, figcaption, blockquote';

  /* 分组节点：结构标签 + 链接数 >= 3 的列表（典型菜单）。
     顺序即输出顺序，与参考实现的对象键顺序一致。 */
  const GROUP_TAGS = [
    ['form', 'form'], ['nav', 'nav'], ['header', 'header'], ['footer', 'footer'],
    ['aside', 'aside'], ['main', 'main'], ['table', 'table']
  ];

  /* ---------- 小工具 ---------- */
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const hex8 = (n) => n.toString(16).padStart(8, '0');

  // 带本地时区偏移的 ISO-8601（schema format: date-time）。
  // 等价于 Python 侧 datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")。
  function nowIso() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const offMin = -d.getTimezoneOffset();
    const sign = offMin >= 0 ? '+' : '-';
    const abs = Math.abs(offMin);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
      sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
  }

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

  /* ---------- 绝对 XPath（协议要求字段，selector 失效时的兜底） ---------- */
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
   * 纯客观的 DOM 关联查询（label[for] / 包裹 label / aria-label / aria-labelledby / 紧邻 label），
   * 不做任何语义猜测。B 拿到 input 时能直接知道它对应的中文名。
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

  /* ---------- 分组标签 ---------- */
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

  /* ---------- select 的选项 ---------- */
  function selectOptionsOf(selectEl) {
    return Array.prototype.map.call(selectEl.options || [], (opt) => ({
      label: norm(opt.text) || norm(opt.value) || '',
      value: norm(opt.value) || norm(opt.text) || '',
      selected: !!opt.selected,
      // select 的选项由 A 按 value 匹配 <option>，不需要逐项 selector（A 组已确认）
      selector: null,
      node: null
    }));
  }

  /* ---------- radio / checkbox 分组 ----------
   * 一个 radio/checkbox 组在语义上是「一个问题 + N 个选项」，但在 DOM 上是 N 个独立元素。
   * 协议里一个 field 只能带一个 selector，所以必须在这里就把它们合并成「一个元素」，
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

  /* =====================================================================
   * 采集：读 DOM，产出「原始结构」（带 _rank / _order / _node 等中间字段，
   * 这些字段绝不会出现在最终输出里 —— buildDocument 会逐字段白名单复制）。
   * 每次调用都是全新的一次采集，所有状态都是本次调用的局部变量。
   * ===================================================================== */
  function collect() {
    // 文档序索引：一次性建表，避免排序时对每个元素反复 querySelector。
    // 真实大页面（如 12306 首页）候选元素上千，原实现会产生上万次选择器查询。
    const DOC_ORDER = new Map();
    Array.prototype.forEach.call(document.querySelectorAll('*'), (n, i) => DOC_ORDER.set(n, i));

    /* ---------- 分组节点收集 ---------- */
    const groupNodes = [];
    const seenGroup = new Set();
    function addGroup(node, type) {
      if (seenGroup.has(node)) return;
      seenGroup.add(node);
      groupNodes.push({ node: node, type: type });
    }

    GROUP_TAGS.forEach((pair) => {
      Array.prototype.forEach.call(document.querySelectorAll(pair[0]), (n) => addGroup(n, pair[1]));
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

    /* ---------- radio / checkbox 归桶：按 (form, name) 合并 ---------- */
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
    // 再次被采集，两者 selector 相同 -> 去重后选项组整个消失。
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

    /* ---------- 组装原始元素 ---------- */
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
        // 只采集"value 即标签"的按钮类；输入类控件的 value 是用户隐私，绝不采集
        value: (el.tagName === 'INPUT' &&
          VALUE_AS_LABEL_TYPES.has(norm(el.getAttribute('type')).toLowerCase()))
          ? (norm(el.value).slice(0, MAX_VALUE) || null)
          : null,
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
        /* 截断优先级（数字越小越先保留）。只看客观属性：是不是交互元素、
         * 是不是表单控件、可不可见、是不是标题 —— 不含任何「对老人重要不重要」
         * 的判断，那是理解层的活。
         *
         *   0  可见的交互/结构元素   能办事的东西
         *   1  隐藏的表单控件       折叠面板、弹窗里的表单往往才是核心功能
         *                          （实测 12306 的出发地/到达地/日期就在 display:none 里）
         *   2  可见标题             页面的骨架，模型靠它理解分区
         *   3  可见文本             上下文
         *   4  其他隐藏交互/结构     通常是折叠起来的导航菜单
         *   5  隐藏文本             最后才考虑
         *
         * 注意 1 排在 2、3 之前：表单控件即使当前不可见，它承载的也是"任务"，
         * 而可见散文只是背景。这个站点上老人是来办事的，不是来读新闻的。
         */
        _rank: (() => {
          const isControl = el.tagName === 'INPUT' || el.tagName === 'SELECT' ||
            el.tagName === 'TEXTAREA';
          const isHeading = /^h[1-6]$/.test(el.tagName);
          if (c.rank === 0) {
            if (visible) return isHeading ? 2 : 0;
            return isControl ? 1 : 4;
          }
          return visible ? 3 : 5;
        })(),
        _order: DOC_ORDER.has(el) ? DOC_ORDER.get(el) : 0,
        _node: el
      });
    });

    /* ---------- radio / checkbox 组：合并为一个「选项组」元素 ---------- */
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
        // 每个选项自带 selector —— A 靠它逐项勾选并触发 input/change
        options: members.map((m) => ({
          label: choiceOptionLabel(m),
          value: norm(m.value),
          selected: !!m.checked,
          selector: cssPath(m),
          node: m
        })),
        _rank: 0 + (visible ? 0 : 2),
        _order: DOC_ORDER.has(container) ? DOC_ORDER.get(container) : 0,
        _node: container
      });
    });

    // DOM 文档序，保证 B 的排序与用户在页面上看到的顺序一致
    rawElements.sort((a, b) => a._order - b._order);

    const rawGroups = groupNodes.map((g) => ({
      selector: cssPath(g.node),
      type: g.type,
      label: groupLabel(g.node, g.type)
    })).filter((g) => g.selector);

    const title = norm(document.title);
    const h1 = document.querySelector('h1');
    return {
      page_title: title || (h1 ? norm(h1.innerText).slice(0, MAX_TEXT) : ''),
      final_url: location.href,
      lang: norm(document.documentElement.getAttribute('lang')) || null,
      elements: rawElements,
      groups: rawGroups
    };
  }

  /* =====================================================================
   * 封装：把原始结构包装成符合 docs/elements.schema.json 的文档。
   * 返回 { document, registry }，registry 是 id -> {node, selector} 的查找表。
   * ===================================================================== */
  function buildDocument(raw) {
    /* ---------- 1. 分组：selector -> 分组 ID（顺序分配，不再用 sha1） ---------- */
    const groupIdBySelector = new Map();
    const rawGroups = [];
    let formSeq = 0;
    let grpSeq = 0;
    raw.groups.forEach((g) => {
      const sel = g.selector;
      if (!sel || groupIdBySelector.has(sel)) return;
      const gid = g.type === 'form'
        ? 'form_' + hex8(formSeq += 1)
        : 'grp_' + hex8(grpSeq += 1);
      groupIdBySelector.set(sel, gid);
      rawGroups.push({ id: gid, type: g.type || 'section', label: g.label || '' });
    });

    /* ---------- 2. 元素：白名单复制（中间字段绝不外泄） ---------- */
    const seenSelectors = new Set();
    const kept = [];
    raw.elements.forEach((item) => {
      const selector = item.selector;
      if (!selector) return;
      // 防御：cssPath 已保证选择器唯一，万一碰撞则丢弃后来者，
      // 绝不允许两条记录指向同一节点（会让下游高亮错元素）。
      if (seenSelectors.has(selector)) return;
      seenSelectors.add(selector);
      const bbox = item.bbox;
      kept.push({
        rank: item._rank || 0,
        order: item._order || 0,
        node: item._node || null,
        element: {
          id: '',                                  // 截断后按文档序统一编号
          type: item.type,
          text: item.text || '',
          label: item.label === undefined ? null : item.label,
          aria_label: item.aria_label === undefined ? null : item.aria_label,
          placeholder: item.placeholder === undefined ? null : item.placeholder,
          name: item.name === undefined ? null : item.name,
          value: item.value === undefined ? null : item.value,
          href: item.href === undefined ? null : item.href,
          selector: selector,
          xpath: item.xpath || '',
          visible: !!item.visible,
          bbox: bbox ? {
            x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height
          } : null,
          group_id: groupIdBySelector.get(item.group_selector) || null,
          in_form: !!item.in_form,
          form_id: groupIdBySelector.get(item.form_selector) || null,
          required: item.required === undefined ? null : item.required,
          disabled: !!item.disabled,
          level: item.level === undefined ? null : item.level,
          options: null,                           // 下方填充
          order: 0
        },
        rawOptions: item.options
      });
    });

    /* ---------- 3. 截断：按优先级保留 ----------
     * 优先级定义见上面 _rank 的注释。这里必须**真的按 rank 排序** ——
     * 早先的实现把"其余"按文档顺序截取，于是"可见文本优先于隐藏表单控件"
     * 只写在注释里，并没有生效：谁在文档里靠前谁活下来。
     */
    let truncated = false;
    if (kept.length > MAX_ELEMENTS) {
      truncated = true;
      kept.sort((a, b) => a.rank - b.rank || a.order - b.order);
      kept.length = MAX_ELEMENTS;
    }

    // 截断后恢复 DOM 文档序。优先级只用于决定「谁被保留」，
    // 绝不能变成「输出顺序即重要性排序」——那等于替理解层做功能排序（规范 §3）。
    kept.sort((a, b) => a.order - b.order);

    /* ---------- 4. 分组归属：只保留仍有元素归属的分组 ---------- */
    const grouped = new Map();
    kept.forEach((b) => {
      const gid = b.element.group_id;
      if (!gid) return;
      if (!grouped.has(gid)) grouped.set(gid, []);
      grouped.get(gid).push(b);
    });
    const liveGroupIds = new Set();
    rawGroups.forEach((g) => { if (grouped.has(g.id)) liveGroupIds.add(g.id); });

    // 防御：form_id 指向的分组若因「表单内元素全被截断」而不复存在，
    // 就置空而不是留一个悬空引用（下游拿它关联提交按钮，悬空只会更糟）。
    kept.forEach((b) => {
      if (b.element.group_id && !liveGroupIds.has(b.element.group_id)) b.element.group_id = null;
      if (b.element.form_id && !liveGroupIds.has(b.element.form_id)) b.element.form_id = null;
    });

    /* ---------- 5. ID 与 order：按文档序递增 ---------- */
    // 提取与渲染同进程，ID 不需要可跨进程复现，用递增计数器最直观：
    //   el_00000001, el_00000002 ...（8 位十六进制，满足 ^el_[0-9a-f]{8}$）
    const registry = new Map();
    let elementSeq = 0;
    const elements = kept.map((b, index) => {
      const el = b.element;
      el.order = index;
      elementSeq += 1;
      el.id = 'el_' + hex8(elementSeq);
      registry.set(el.id, { node: b.node, selector: el.selector });
      // radio/checkbox 的每个选项也是独立 DOM 控件，给它自己的 ID（供跨模块追溯），
      // 主元素的 ID 保持 1..N 连续，选项 ID 从 N+1 开始排。
      if (b.rawOptions && b.rawOptions.length) {
        el.options = b.rawOptions.map((o) => ({
          label: o.label || '',
          value: o.value || '',
          selected: !!o.selected,
          selector: o.selector === undefined ? null : o.selector,
          element_id: null,
          _node: o.node || null
        }));
      }
      return el;
    });
    elements.forEach((el) => {
      if (!el.options) return;
      el.options.forEach((o) => {
        if (!o.selector) { o.element_id = null; return; }
        elementSeq += 1;
        o.element_id = 'el_' + hex8(elementSeq);
        registry.set(o.element_id, { node: o._node, selector: o.selector });
      });
    });
    // 选项对象里的 _node 只是中间字段，出文档前删掉（schema additionalProperties: false）
    elements.forEach((el) => {
      if (!el.options) return;
      el.options = el.options.map((o) => ({
        label: o.label,
        value: o.value,
        selected: o.selected,
        selector: o.selector,
        element_id: o.element_id
      }));
    });

    /* ---------- 6. 分组列表 ---------- */
    const groups = rawGroups
      .filter((g) => grouped.has(g.id))
      .map((g) => ({
        id: g.id,
        type: g.type,
        label: g.label,
        element_ids: grouped.get(g.id).map((b) => b.element.id)
      }));

    /* ---------- 7. 统计：数出来的，不是估计的 ---------- */
    const byType = {};
    let visibleCount = 0;
    elements.forEach((el) => {
      byType[el.type] = (byType[el.type] || 0) + 1;
      if (el.visible) visibleCount += 1;
    });

    return {
      document: {
        schema_version: SCHEMA_VERSION,
        page_url: location.href,
        final_url: raw.final_url || location.href,
        page_title: raw.page_title || '',
        lang: raw.lang === undefined ? null : raw.lang,
        source: 'live',              // 扩展里没有降级快照的概念
        fallback_reason: null,
        extracted_at: nowIso(),
        stats: {
          total: elements.length,
          visible: visibleCount,
          by_type: byType,
          truncated: truncated
        },
        elements: elements,
        groups: groups
      },
      registry: registry
    };
  }

  /* ---------- resolve：ID -> 真实 DOM 元素 ---------- */
  function makeResolve(registry) {
    return function resolve(id) {
      if (typeof id !== 'string' || !id) return null;
      const rec = registry.get(id);
      if (!rec) return null;
      const node = rec.node;
      if (node && node.isConnected) return node;
      // 元素已被页面重新渲染替换：用 selector 回退定位（不往页面打任何标记，零污染）
      if (rec.selector) {
        try {
          const found = document.querySelector(rec.selector);
          if (found) return found;
        } catch (e) { /* 选择器已失效（页面结构大改）时忽略 */ }
      }
      return node || null;
    };
  }

  globalThis.EasyViewExtract = {
    /* 每次调用都重新提取（页面可能已经变了），并返回本次结果专属的 resolve。 */
    run() {
      const raw = collect();
      const built = buildDocument(raw);
      return {
        elements: built.document,
        resolve: makeResolve(built.registry)
      };
    }
  };
})();
