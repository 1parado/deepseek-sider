// ============================================================
// AI Sider - 侧边栏逻辑
// 顶部图标栏：单击切换站点；Ctrl+点击多选 → 可拖拽分栏对比。
// 分栏：每面板 flex-grow = 持久化权重（比例×100），splitter 拖拽
// 调权重，min 160px / max = 容器-160px×(n-1)，双击 splitter 复位。
// 布局与多选状态都持久化，重开侧边栏原样恢复。
// ＋ 打开管理面板：新增 / 编辑 / 删除站点，列表持久化到
// storage.local.aiSites（出厂清单在 shared/ai-sites.js）。
// 图标三级兜底（参照 OrbitShot）：扩展内置 → favicon 候选链 → 首字母色块。
// 注意：MV3 扩展页面 CSP 禁止内联 <script>，逻辑必须放在本文件。
// ============================================================

const view = document.getElementById("view");
const tabsBox = document.getElementById("tabs");
const hintBox = document.getElementById("hint");
const emptyState = document.getElementById("empty-state");
const emptyText = document.getElementById("empty-text");
const emptyHint = document.getElementById("empty-hint");
const addBtn = document.getElementById("add-btn");
const popoutBtn = document.getElementById("popout-btn");
const toastBox = document.getElementById("toast");
const slowBanner = document.getElementById("slow-banner");
const manageBox = document.getElementById("manage");
const siteListBox = document.getElementById("site-list");
const formBox = document.getElementById("site-form");
const formName = document.getElementById("form-name");
const formUrl = document.getElementById("form-url");
const formError = document.getElementById("form-error");
const urlPreview = document.getElementById("url-preview");
const formSave = document.getElementById("form-save");
const formCancel = document.getElementById("form-cancel");
const resetBtn = document.getElementById("reset-btn");
const closeManage = document.getElementById("close-manage");
const moreBtn = document.getElementById("more-btn");
const moreMenu = document.getElementById("more-menu");

const MAX_SITES = 30; // 顶栏最多承载的站点数（防失控）
const MAX_COMPARE = 4; // 侧边栏最多并排数（再多每格太窄）
const PANE_MIN = 160; // 拖拽时单面板最小宽度 px
const DRAG_WEIGHT_MIN = 0.12; // 权重下限（≈ 视口 12%，与 PANE_MIN 大致对应）
let toastTimer = null;

let SITES = []; // 运行时站点列表（storage 持久化）
let currentId = null; // 单选站点（主站点：右键投递 / ⧉ 弹出的目标）
let selected = new Set(); // Ctrl 多选集合；空 = 单站点模式
let paneWeights = {}; // id -> 权重（0~1），布局持久化
const frames = new Map(); // id -> { el, loadedAt, fallbackTimer }

const siteById = (id) => SITES.find((s) => s.id === id);

function showToast(msg) {
  toastBox.textContent = msg;
  toastBox.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastBox.classList.remove("show"), 1800);
}
slowBanner.querySelector(".sb-close").addEventListener("click", () => slowBanner.classList.remove("show"));

// ---------- 图标：三级兜底 ----------
// 返回 {src} 或 {letter, color}；候选链上 img.onerror 依次换下一源
const LETTER_COLORS = ["#4285f4", "#34a853", "#f4b400", "#ea4335", "#9334e6", "#12b5cb", "#f4511e", "#795548"];
function iconState(site) {
  if (site.icon) return { src: site.icon };
  const chain = faviconCandidates(site.url);
  if (chain.length) return { src: chain[0], fallbacks: chain.slice(1) };
  return { letter: (site.name || "?").trim().charAt(0).toUpperCase() || "?" };
}
function letterColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return LETTER_COLORS[Math.abs(h) % LETTER_COLORS.length];
}
// 统一创建图标元素（顶栏 / 面板头 / 管理列表共用）
function makeIcon(site, cls) {
  const st = iconState(site);
  if (st.letter) {
    const d = document.createElement("span");
    d.className = (cls || "") + " letter";
    d.textContent = st.letter;
    d.style.background = letterColor(site.name || site.id);
    return d;
  }
  const img = document.createElement("img");
  img.className = cls || "";
  img.alt = site.name;
  img.draggable = false;
  img.referrerPolicy = "no-referrer";
  img.src = st.src;
  const fallbacks = st.fallbacks || [];
  let fi = 0;
  img.onerror = () => {
    // 候选链走完 → 降级为首字母色块
    if (fi < fallbacks.length) img.src = fallbacks[fi++];
    else {
      const d = makeIcon({ ...site, icon: null, url: "" }, cls);
      img.replaceWith(d);
    }
  };
  return img;
}

// ---------- 站点列表持久化 ----------
function loadSites() {
  return new Promise((resolve) => {
    chrome.storage.local.get("aiSites", (d) => {
      const list = d && d.aiSites;
      resolve(Array.isArray(list) && list.length && list.every(isValidSite) ? list : BUILTIN_AI_SITES.slice());
    });
  });
}
function saveSites() {
  chrome.storage.local.set({ aiSites: SITES });
}

// ---------- 顶栏 ----------
let dragTab = null; // 拖拽中的顶栏图标
let suppressClickUntil = 0; // 拖拽刚结束时不触发 click（避免误切换）

function buildTabs() {
  tabsBox.textContent = "";
  SITES.forEach((site, i) => {
    const b = document.createElement("button");
    b.className = "site-tab";
    b.title = site.name + (site.noEmbed ? "（仅独立小窗）" : "") + "（Ctrl+点击加入对比）";
    b.dataset.id = site.id;
    b.draggable = true;
    b.appendChild(makeIcon(site));
    b.style.animation = `row-in 0.25s ${Math.min(i * 30, 360)}ms both`; // 级联入场
    b.addEventListener("click", (e) => {
      if (Date.now() < suppressClickUntil) return; // 刚拖完，不是点击
      if (e.ctrlKey || e.metaKey) toggleSelect(site.id);
      else showSite(site.id);
    });
    // ---- 顶栏图标拖拽排序 ----
    b.addEventListener("dragstart", (e) => {
      dragTab = b;
      b.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", site.id);
      } catch (_e) {}
    });
    b.addEventListener("dragend", () => {
      b.classList.remove("dragging");
      dragTab = null;
      commitTabOrder();
      // 松手后的合成 click 不当真：短窗内忽略
      suppressClickUntil = Date.now() + 250;
    });
    tabsBox.appendChild(b);
  });
  moreItems(); // 两行装不下的站点收进「⋯」菜单
}

// ---------- 顶栏溢出「⋯」菜单 ----------
// #tabs 最多两行；装不下的站点收进菜单（图标 + 名称 + 仅小窗标记）。
// 溢出量随侧边栏宽度变化，用 resizeObserver + 每次 buildTabs 后重算。
function moreItems() {
  const tabs = [...tabsBox.querySelectorAll(".site-tab")];
  if (!tabs.length) {
    moreBtn.hidden = true;
    closeMoreMenu();
    return;
  }
  // 顶栏可用高度能容纳的行数（92px 上限 ≈ 2 行 30px 图标 + 间隙）
  const rows = Math.max(1, Math.floor((tabsBox.clientHeight || 92) / 33));
  const perRow = Math.max(1, Math.floor(tabsBox.clientWidth / 33)); // 30px 图标 + 2px 间隙
  const capacity = rows * perRow;
  const overflow = tabs.slice(capacity);
  moreBtn.hidden = overflow.length === 0;
  overflow.forEach((el) => (el.style.visibility = "hidden"));
  tabs.slice(0, capacity).forEach((el) => (el.style.visibility = ""));
  // 菜单内容：仅溢出的站点
  moreMenu.textContent = "";
  overflow.forEach((el) => {
    const site = siteById(el.dataset.id);
    if (!site) return;
    const item = document.createElement("button");
    item.className = "more-item";
    item.appendChild(makeIcon(site));
    const nm = document.createElement("span");
    nm.className = "more-name";
    nm.textContent = site.name;
    item.appendChild(nm);
    if (site.noEmbed) {
      const tg = document.createElement("span");
      tg.className = "more-tag";
      tg.textContent = "仅小窗";
      item.appendChild(tg);
    }
    item.addEventListener("click", () => {
      closeMoreMenu();
      showSite(site.id);
    });
    moreMenu.appendChild(item);
  });
}
function closeMoreMenu() {
  moreMenu.classList.remove("show");
}
moreBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  moreMenu.classList.toggle("show");
});
document.addEventListener("click", (e) => {
  if (moreMenu.classList.contains("show") && !moreMenu.contains(e.target)) closeMoreMenu();
});
window.addEventListener("resize", moreItems);

// 拖拽经过时实时腾位：把被拖图标插到指针最近的间隙（同行优先）
function insertionSlot(x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const el of tabsBox.querySelectorAll(".site-tab:not(.dragging)")) {
    const r = el.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const d = dx * dx + dy * dy * 4; // y 加权：优先插到同一行
    if (d < bestDist) {
      bestDist = d;
      best = { el, before: dx < 0 };
    }
  }
  if (!best) return null;
  return best.before ? best.el : best.el.nextSibling;
}

// 松手落盘：按 DOM 顺序重排 SITES
function commitTabOrder() {
  const ids = [...tabsBox.querySelectorAll(".site-tab")].map((el) => el.dataset.id);
  SITES = ids.map(siteById).filter(Boolean);
  saveSites();
}
tabsBox.addEventListener("dragover", (e) => {
  if (!dragTab) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const slot = insertionSlot(e.clientX, e.clientY);
  if (slot == null) tabsBox.appendChild(dragTab);
  else if (slot !== dragTab) tabsBox.insertBefore(dragTab, slot);
});

function markTabs() {
  tabsBox.querySelectorAll(".site-tab").forEach((el) => {
    el.classList.toggle("current", el.dataset.id === currentId && !selected.size);
    el.classList.toggle("selected", selected.has(el.dataset.id));
  });
  // 对比模式提示：站点图标胶囊组（「对比中」+ 各站点 chip）
  hintBox.textContent = "";
  hintBox.classList.toggle("show", !!selected.size);
  if (selected.size) {
    const label = document.createElement("span");
    label.className = "hint-label";
    label.textContent = "对比中";
    hintBox.appendChild(label);
    [...selected].forEach((id) => {
      const site = siteById(id);
      if (!site) return;
      const chip = document.createElement("span");
      chip.className = "hint-chip";
      chip.appendChild(makeIcon(site));
      const nm = document.createElement("span");
      nm.textContent = site.name;
      chip.appendChild(nm);
      hintBox.appendChild(chip);
    });
  }
}

// ---------- iframe 池 ----------
function getFrame(id) {
  const site = siteById(id);
  let entry = frames.get(id);
  if (!entry) {
    const el = document.createElement("iframe");
    el.src = site.url;
    el.allow = "clipboard-read; clipboard-write";
    entry = { el, loadedAt: 0 };
    el.addEventListener("load", () => {
      entry.loadedAt = Date.now();
      clearTimeout(entry.fallbackTimer);
      clearTimeout(entry.slowTimer);
      // 隐藏该面板的 spinner，清掉慢载警告
      const l = el.parentElement && el.parentElement.querySelector(".loading");
      if (l) l.classList.add("done");
      const p = el.closest(".pane");
      if (p) p.classList.remove("warn");
      slowBanner.classList.remove("show");
    });
    frames.set(id, entry);
  }
  return entry;
}

// noEmbed 站点：不给空白 iframe，直接弹独立小窗
function openOrPopout(id) {
  const site = siteById(id);
  if (site && site.noEmbed) {
    popout(id);
    return false;
  }
  return true;
}

// ---------- 渲染：单站点 / 多选可拖拽分栏 ----------
function render() {
  const ids = selected.size ? [...selected] : currentId ? [currentId] : [];
  view.querySelectorAll(".pane, .splitter").forEach((el) => el.remove());
  emptyState.classList.remove("show");
  slowBanner.classList.remove("show"); // 旧面板的慢载提示随重渲染一并撤下

  if (!ids.length) {
    emptyText.innerHTML = SITES.length
      ? '点上方图标使用对应 AI，<b>Ctrl+点击</b>可多选并排对比。<br />在网页选中文字右键「<b>AI 一下</b>」可一键提问。'
      : '还没有任何 AI 站点，点右上角 <b>＋</b> 添加一个。';
    if (!SITES.length) emptyState.classList.add("show");
    markTabs();
    return;
  }

  const multi = ids.length > 1;
  let prev = null;
  ids.forEach((id, idx) => {
    const site = siteById(id);
    if (!site) return; // 已被删除的站点
    const entry = getFrame(id);

    const pane = document.createElement("div");
    pane.className = "pane";
    pane.dataset.id = id;
    // 面板入场级联
    pane.style.animationDelay = idx * 40 + "ms";
    if (multi) {
      // 权重布局：有持久化权重用之，否则均分
      const w = paneWeights[id] || 1 / ids.length;
      pane.style.flexGrow = String(Math.max(DRAG_WEIGHT_MIN, w) * 100);

      const head = document.createElement("div");
      head.className = "pane-head";
      head.appendChild(makeIcon(site));
      const name = document.createElement("span");
      name.textContent = site.name;
      // 存活点：桥心跳正常 = 绿，未见心跳 = 灰（可能停在登录页）
      const alive = document.createElement("span");
      alive.className = "alive";
      alive.dataset.id = id;
      // 内嵌异常警告：3s 未 load 出现，悬停见说明
      const warnIcon = document.createElement("span");
      warnIcon.className = "warn-embed";
      warnIcon.textContent = "⚠";
      warnIcon.title = "该面板迟迟未加载，可能被站点拒绝内嵌，点 ⧉ 用独立小窗打开";
      // 面板级弹出：把该站点弹成独立小窗（不同站点可各自弹出、互不影响）
      const popBtn = document.createElement("button");
      popBtn.className = "pane-pop";
      popBtn.title = "将「" + site.name + "」弹出为独立小窗";
      popBtn.textContent = "⧉";
      popBtn.addEventListener("click", () => popout(id));
      const close = document.createElement("button");
      close.className = "pane-close";
      close.title = "移出对比";
      close.textContent = "✕";
      close.addEventListener("click", () => toggleSelect(id));
      head.append(name, alive, warnIcon, popBtn, close);
      pane.appendChild(head);

      // spinner：iframe load 事件后淡出
      const loading = document.createElement("div");
      loading.className = "loading";
      const sp = document.createElement("div");
      sp.className = "spinner";
      loading.appendChild(sp);
      pane.appendChild(loading);
      if (entry.loadedAt) loading.classList.add("done");

      // 拖拽分隔条（两面板之间）：先插面板再插分隔条
      if (prev) {
        const sp2 = document.createElement("div");
        sp2.className = "splitter";
        sp2.addEventListener("dblclick", () => resetWeights());
        attachDrag(sp2, prev);
        view.appendChild(sp2);
      }
    }
    pane.appendChild(entry.el);
    view.appendChild(pane);
    prev = pane;

    // 内嵌失败兜底：
    //   3s 未 load → 多选时 pane-head 出 ⚠；单站点时底部浮半透明提示条
    //   8s 未 load → 单站点时切换到空态指引（用小窗打开）
    if (!entry.loadedAt) {
      clearTimeout(entry.slowTimer);
      entry.slowTimer = setTimeout(() => {
        if (entry.loadedAt) return;
        pane.classList.add("warn");
        if (!selected.size) slowBanner.classList.add("show");
      }, 3000);
      clearTimeout(entry.fallbackTimer);
      entry.fallbackTimer = setTimeout(() => {
        if (!entry.loadedAt && !selected.size) {
          slowBanner.classList.remove("show");
          emptyHint.style.display = "block";
          emptyState.classList.add("show");
        }
      }, 8000);
    }
  });
  markTabs();
}

function showSite(id) {
  if (currentId !== id) {
    currentId = id;
    chrome.storage.local.set({ dsActiveSite: id });
  }
  selected.clear();
  saveCompareState();
  render();
}

// Ctrl 多选（OrbitShot 模式）：2~4 个并排对比
function toggleSelect(id) {
  if (selected.has(id)) {
    selected.delete(id);
    if (!selected.size) {
      saveCompareState();
      render();
      return;
    }
  } else {
    if (selected.size >= MAX_COMPARE) {
      showToast(`最多同时对比 ${MAX_COMPARE} 个`);
      return;
    }
    const site = siteById(id);
    if (!site) return;
    // noEmbed 站点进不了对比集合（面板根本无法内嵌），直接弹小窗，
    // 避免出现「顶栏选中态/对比胶囊里有它，面板却不显示」的错位
    if (site.noEmbed) {
      showToast(`「${site.name}」仅支持独立小窗，已为你弹出`);
      popout(id);
      return;
    }
    selected.add(id);
    currentId = id;
    chrome.storage.local.set({ dsActiveSite: id });
  }
  saveCompareState();
  render();
}

// ---------- 布局持久化 ----------
function saveCompareState() {
  chrome.storage.local.set({
    dsCompareIds: [...selected],
    dsPaneWeights: paneWeights,
  });
}

// 双击 splitter：全部复位为均分
function resetWeights() {
  paneWeights = {};
  saveCompareState();
  render();
  showToast("已恢复均分布局");
}

// ---------- 拖拽分栏 ----------
// 核心思路：拖动 splitter 时只改左右两面板的 flexGrow（权重），
// 两者之和（pairSum）守恒，其余面板不受影响。
// 约束：任意一侧权重不得低于 PANE_MIN 换算的像素占比，
// 即 wLeft ∈ [minW, pairSum - minW]，对侧最小宽度由此自然保证。
function attachDrag(splitter, leftPane) {
  splitter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const leftPaneEl = leftPane;
    const rightPaneEl = splitter.nextElementSibling;
    if (!rightPaneEl || !rightPaneEl.classList.contains("pane")) return;

    const containerWidth = view.clientWidth;
    const startX = e.clientX;

    const wLeft0 = parseFloat(leftPaneEl.style.flexGrow) / 100;
    const wRight0 = parseFloat(rightPaneEl.style.flexGrow) / 100;
    const pairSum = wLeft0 + wRight0;

    // 权重上下限：minW 像素占比；上限由「对侧也要留 minW」推出
    const minW = PANE_MIN / containerWidth;
    const minLeft = minW;
    const maxLeft = Math.max(minLeft + 0.01, pairSum - minW);

    splitter.classList.add("active");
    document.body.classList.add("dragging");
    splitter.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      let wLeft = wLeft0 + dx / containerWidth;
      wLeft = Math.min(maxLeft, Math.max(minLeft, wLeft));
      const wRight = Math.max(DRAG_WEIGHT_MIN, pairSum - wLeft);
      leftPaneEl.style.flexGrow = String(wLeft * 100);
      rightPaneEl.style.flexGrow = String(wRight * 100);
      paneWeights[leftPaneEl.dataset.id] = wLeft;
      paneWeights[rightPaneEl.dataset.id] = wRight;
    };
    const onUp = () => {
      splitter.classList.remove("active");
      document.body.classList.remove("dragging");
      splitter.removeEventListener("pointermove", onMove);
      splitter.removeEventListener("pointerup", onUp);
      saveCompareState(); // 松手才落盘，避免拖动过程频繁写 storage
    };
    splitter.addEventListener("pointermove", onMove);
    splitter.addEventListener("pointerup", onUp);
  });
}

// ---------- 弹出独立小窗 ----------
function popout(id) {
  if (!siteById(id)) return;
  chrome.runtime.sendMessage({ type: "DS_POPUP_WINDOW", siteId: id });
}
popoutBtn.addEventListener("click", () => {
  if (currentId) popout(currentId);
});

// ---------- 管理面板 ----------
let editingId = null; // null=新增
let dragRow = null; // 拖拽排序中的列表行

// 列表拖拽经过时实时腾位：插到指针最近的行间隙
siteListBox.addEventListener("dragover", (e) => {
  if (!dragRow) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const rows = [...siteListBox.querySelectorAll(".site-row:not(.dragging)")];
  let best = null;
  let bestDist = Infinity;
  for (const el of rows) {
    const r = el.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    const d = Math.abs(e.clientY - (r.top + r.height / 2));
    if (d < bestDist) {
      bestDist = d;
      best = after ? el.nextSibling : el;
    }
  }
  if (!best) siteListBox.appendChild(dragRow);
  else if (best !== dragRow) siteListBox.insertBefore(dragRow, best);
});

function openManage() {
  manageBox.classList.add("show");
  hideForm();
  renderManageList();
}
function closeManagePanel() {
  manageBox.classList.remove("show");
  hideForm();
}
addBtn.addEventListener("click", openManage);
closeManage.addEventListener("click", closeManagePanel);

function renderManageList() {
  siteListBox.textContent = "";
  if (!SITES.length) {
    const tip = document.createElement("p");
    tip.style.cssText = "text-align:center;color:#9aa0a6;font-size:13px;padding:32px 0";
    tip.textContent = "暂无站点，点击下方「新增站点」添加。";
    siteListBox.appendChild(tip);
  }
  SITES.forEach((site, i) => {
    const row = document.createElement("div");
    row.className = "site-row";
    row.style.animationDelay = Math.min(i * 30, 400) + "ms"; // 级联入场
    // ---- 管理列表拖拽排序（顶栏图标顺序跟随此处） ----
    row.draggable = true;
    row.dataset.id = site.id;

    row.appendChild(makeIcon(site, "row-icon"));

    const main = document.createElement("div");
    main.className = "row-main";
    const nameLine = document.createElement("div");
    nameLine.className = "row-name";
    nameLine.append(document.createTextNode(site.name));
    if (!site.icon) {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = "自定义";
      nameLine.appendChild(t);
    }
    if (site.noEmbed) {
      const t = document.createElement("span");
      t.className = "tag risky";
      t.textContent = "仅小窗";
      nameLine.appendChild(t);
    }
    const urlLine = document.createElement("div");
    urlLine.className = "row-url";
    urlLine.textContent = site.url;
    urlLine.title = site.url;
    main.append(nameLine, urlLine);
    row.appendChild(main);

    const edit = document.createElement("button");
    edit.className = "row-btn";
    edit.title = "编辑名称 / 网址";
    edit.textContent = "✎";
    edit.addEventListener("click", () => showForm(site));
    row.appendChild(edit);

    const del = document.createElement("button");
    del.className = "row-btn danger";
    del.title = "删除该站点";
    del.textContent = "🗑";
    del.addEventListener("click", () => {
      const idx = SITES.indexOf(site);
      // 行内退场动画 → 删除，toast 提供 5 秒撤销
      row.classList.add("removing");
      setTimeout(() => deleteSite(site.id, idx), 180);
    });
    row.appendChild(del);

    // 拖拽手柄态：按住行拖动可调顺序；松手按 DOM 顺序重排 SITES
    row.addEventListener("dragstart", (e) => {
      dragRow = row;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", site.id);
      } catch (_e) {}
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      dragRow = null;
      const ids = [...siteListBox.querySelectorAll(".site-row")].map((el) => el.dataset.id);
      const reordered = ids.map(siteById).filter(Boolean);
      if (reordered.length !== SITES.length || reordered.some((s, j) => s.id !== SITES[j].id)) {
        SITES = reordered;
        saveSites();
        refreshAll(); // 顶栏图标 + 管理列表一起按新顺序重建
      }
    });

    siteListBox.appendChild(row);
  });

  const addRow = document.createElement("div");
  addRow.style.cssText = "padding:10px 8px";
  const addB = document.createElement("button");
  addB.textContent = "＋ 新增站点";
  addB.style.cssText =
    "width:100%;padding:9px 0;border:1px dashed #c6c9cd;border-radius:10px;background:none;color:#5f6368;font-size:13px;cursor:pointer;transition:border-color .15s,color .15s";
  addB.addEventListener("mouseenter", () => {
    addB.style.borderColor = "#4285f4";
    addB.style.color = "#4285f4";
  });
  addB.addEventListener("mouseleave", () => {
    addB.style.borderColor = "#c6c9cd";
    addB.style.color = "#5f6368";
  });
  addB.addEventListener("click", () => showForm(null));
  addRow.appendChild(addB);
  siteListBox.appendChild(addRow);
}

function showForm(site) {
  editingId = site ? site.id : null;
  formName.value = site ? site.name : "";
  formUrl.value = site ? site.url : "";
  formError.style.display = "none";
  formSave.textContent = site ? "保存修改" : "新增";
  updateUrlPreview();
  formBox.classList.add("show");
  formName.focus();
}
function hideForm() {
  formBox.classList.remove("show");
  editingId = null;
}
formCancel.addEventListener("click", hideForm);

// ---------- 网址即时预览：blur / input 时显示 favicon + 解析后域名 ----------
function updateUrlPreview() {
  const url = normalizeSiteUrl(formUrl.value);
  if (!url || (editingId && url === normalizeSiteUrl((siteById(editingId) || {}).url))) {
    urlPreview.classList.remove("show");
    urlPreview.textContent = "";
    return;
  }
  urlPreview.textContent = "";
  const icon = makeIcon({ name: url, url, icon: null });
  icon.classList.add("preview-icon");
  const host = new URL(url).hostname;
  urlPreview.append(icon, document.createTextNode(host));
  urlPreview.classList.add("show");
}
formUrl.addEventListener("blur", updateUrlPreview);
formUrl.addEventListener("input", () => {
  // 输入中即时刷新域名文字（favicon 可能 404，makeIcon 自带兜底）
  clearTimeout(formUrl._pvTimer);
  formUrl._pvTimer = setTimeout(updateUrlPreview, 300);
});

// Enter 提交表单（在任一输入框内按 Enter）
[formName, formUrl].forEach((el) =>
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      formSave.click();
    }
  })
);

formSave.addEventListener("click", () => {
  const name = formName.value.trim();
  const url = normalizeSiteUrl(formUrl.value);
  if (!name) return showFormError("请填写名称");
  if (!url) return showFormError("网址格式不正确");

  if (editingId) {
    const site = siteById(editingId);
    if (!site) return hideForm();
    const sameUrl = url === normalizeSiteUrl(site.url);
    site.name = name;
    site.url = url;
    // 网址变了：id 重新生成（查重）、旧会话作废；网址没变则保留 id 与会话
    if (!sameUrl) {
      SITES = SITES.filter((s) => s.id !== editingId || s === site);
      site.id = siteIdFor(url);
      if (SITES.some((s) => s.id === site.id && s !== site)) return showFormError("该网址已存在");
      frames.get(editingId)?.el.remove();
      frames.delete(editingId);
      if (currentId === editingId) currentId = site.id;
      selected.delete(editingId);
    }
  } else {
    const id = siteIdFor(url);
    if (SITES.some((s) => s.id === id)) return showFormError("该网址已存在");
    if (SITES.length >= MAX_SITES) return showFormError(`最多 ${MAX_SITES} 个站点`);
    SITES.push({ id, name, url });
  }

  saveSites();
  hideForm();
  refreshAll();
  // 新增/改址后立即打开看一眼
  showSite(currentId && siteById(currentId) ? currentId : SITES[SITES.length - 1].id);
});

// ---------- 删除站点：toast + 撤销（替代原生 confirm） ----------
// 撤销 = 按原下标把站点塞回去，恢复会话帧与选中态。
// 快照用栈：连续删除多个时不丢最早的撤销机会（后删先撤）
let undoTimer = null;
const undoStack = []; // { site, idx, framesEntry }，栈顶 = 最近一次删除

function deleteSite(id, idx) {
  const site = siteById(id);
  if (!site) return;
  undoStack.push({ site, idx, framesEntry: frames.get(id) || null });
  SITES = SITES.filter((s) => s.id !== id);
  frames.get(id)?.el.remove();
  frames.delete(id);
  selected.delete(id);
  delete paneWeights[id];
  if (currentId === id) currentId = SITES.length ? SITES[0].id : null;
  saveSites();
  saveCompareState();
  refreshAll();
  if (currentId && openOrPopout(currentId)) showSite(currentId);
  else render();

  toastBox.innerHTML = "";
  const t = document.createElement("span");
  t.textContent = `已删除「${site.name}」`;
  const undo = document.createElement("button");
  undo.textContent = "撤销";
  undo.style.cssText =
    "margin-left:10px;border:none;background:rgba(255,255,255,.18);color:#fff;border-radius:5px;padding:2px 10px;font-size:12px;cursor:pointer";
  undo.addEventListener("click", () => {
    clearTimeout(undoTimer);
    toastBox.classList.remove("show");
    restoreSite();
  });
  toastBox.append(t, undo);
  toastBox.classList.add("show");
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    toastBox.classList.remove("show");
    undoStack.length = 0; // 撤销窗口关闭，快照作废
  }, 5000);
}

function restoreSite() {
  const snap = undoStack.pop();
  if (!snap) return;
  SITES.splice(Math.min(snap.idx, SITES.length), 0, snap.site);
  if (snap.framesEntry) frames.set(snap.site.id, snap.framesEntry); // 会话帧不销毁，原地恢复
  if (!currentId || !siteById(currentId)) currentId = snap.site.id;
  saveSites();
  saveCompareState();
  refreshAll();
  showSite(currentId);
  showToast("已恢复「" + snap.site.name + "」");
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.style.display = "block";
  // 重触发抖动动画
  formError.style.animation = "none";
  void formError.offsetWidth;
  formError.style.animation = "";
}

resetBtn.addEventListener("click", async () => {
  // 可撤销：快照整个当前列表，toast 5 秒内可一键还原
  const snapshot = SITES.slice();
  await new Promise((r) => chrome.storage.local.remove("aiSites", r));
  SITES = BUILTIN_AI_SITES.slice();
  frames.forEach((e) => e.el.remove());
  frames.clear();
  const prevCurrent = currentId;
  selected.clear();
  paneWeights = {};
  currentId = SITES[0].id;
  saveCompareState();
  refreshAll();
  showSite(currentId);
  // toast：撤销 = 还原快照列表并回到之前的站点
  toastBox.innerHTML = "";
  const t = document.createElement("span");
  t.textContent = "已恢复默认站点";
  const undo = document.createElement("button");
  undo.textContent = "撤销";
  undo.style.cssText =
    "margin-left:10px;border:none;background:rgba(255,255,255,.18);color:#fff;border-radius:5px;padding:2px 10px;font-size:12px;cursor:pointer";
  undo.addEventListener("click", async () => {
    clearTimeout(undoTimer);
    toastBox.classList.remove("show");
    SITES = snapshot;
    if (prevCurrent && siteById(prevCurrent)) currentId = prevCurrent;
    await new Promise((r) => chrome.storage.local.set({ aiSites: SITES }, r));
    refreshAll();
    showSite(currentId);
    showToast("已还原自定义站点");
  });
  toastBox.append(t, undo);
  toastBox.classList.add("show");
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => toastBox.classList.remove("show"), 5000);
});

// 站点列表变化后统一重建（顶栏 + 管理列表）
function refreshAll() {
  buildTabs();
  renderManageList();
}

// ---------- 面板存活点 ----------
// ai-bridge 每 3s 按站点 host 写 dsBridgeBeat.<host>；这里用【单个】
// 定时器 get(null) 一次读全量，刷新所有 .alive 点（多面板共用），
// 并顺手清掉超过 60s 无心跳的死键（站点删了/桥停了留下的残留）。
// 心跳在 8s 内视为存活（桥写间隔 3s，留 2 轮余量）。
const BEAT_STALE_MS = 8000;
const BEAT_KEY_GC_MS = 60000;
let beatTimer = null;
function startBeatWatch() {
  if (beatTimer) return;
  const refresh = () => {
    chrome.storage.local.get(null, (all) => {
      const now = Date.now();
      const stale = [];
      const beats = new Map();
      for (const k in all) {
        if (!k.startsWith("dsBridgeBeat.")) continue;
        const at = all[k];
        if (typeof at === "number") {
          if (now - at > BEAT_KEY_GC_MS) stale.push(k);
          else beats.set(k.slice("dsBridgeBeat.".length), at);
        } else stale.push(k);
      }
      if (stale.length) chrome.storage.local.remove(stale); // #10 死键清理
      document.querySelectorAll(".pane-head .alive[data-id]").forEach((el) => {
        const s = siteById(el.dataset.id);
        if (!s) return;
        let host;
        try {
          host = new URL(s.url).hostname;
        } catch (_e) {
          return;
        }
        const at = beats.get(host) || 0;
        el.classList.toggle("ok", now - at < BEAT_STALE_MS);
      });
    });
  };
  beatTimer = setInterval(refresh, 4000);
  refresh();
}
startBeatWatch();


// Esc：优先关表单，再退出对比模式，最后关管理面板
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (formBox.classList.contains("show")) return hideForm();
    if (manageBox.classList.contains("show")) return closeManagePanel();
    if (selected.size) return showSite(currentId);
    return;
  }
  // Ctrl 按住时顶栏进入「多选暗示」态；Ctrl+1~4 快速选前几个站点
  if (e.key === "Control") tabsBox.classList.add("ctrl-mode");
  if (e.ctrlKey || e.metaKey) {
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 4 && SITES[n - 1]) {
      e.preventDefault();
      toggleSelect(SITES[n - 1].id);
    }
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Control") tabsBox.classList.remove("ctrl-mode");
});
// 窗口失焦兜底清态（Ctrl 状态可能因切窗丢失 keyup）
window.addEventListener("blur", () => tabsBox.classList.remove("ctrl-mode"));

// ---------- 启动：恢复列表 / 上次站点 / 多选布局 ----------
(async () => {
  SITES = await loadSites();
  buildTabs();

  const d = await chrome.storage.local.get(["dsActiveSite", "dsCompareIds", "dsPaneWeights"]);
  const saved = d && d.dsActiveSite;
  paneWeights = (d && d.dsPaneWeights) || {};
  const savedIds = (d && d.dsCompareIds) || [];

  currentId = siteById(saved) ? saved : SITES.length ? SITES[0].id : null;
  // 恢复多选：只保留仍存在且可内嵌的站点（noEmbed 站点进不了对比集合）；合法（≥2）才进对比模式
  selected = new Set(savedIds.filter((id) => { const s = siteById(id); return s && !s.noEmbed; }));
  if (selected.size === 1) selected.clear();
  if (selected.size > MAX_COMPARE) selected = new Set([...selected].slice(0, MAX_COMPARE));

  markTabs();
  if (currentId && selected.size && openOrPopout(currentId)) {
    render(); // 直接恢复对比布局
    showToast("已恢复上次的对比布局");
  } else if (currentId && openOrPopout(currentId)) {
    render();
  } else if (!SITES.length) {
    render(); // 0 站点 → 显示「去添加」空态
  }
})();
