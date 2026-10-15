// ============================================================
// AI Sider - 知识库视图（侧边栏内 overlay）
// 布局：顶栏入口 📚 → #kb overlay
//   左列：收件箱 + 项目列表（新建/重命名/删除）
//   右列：搜索框 + 摘录卡片流（时间倒序，缩略图懒加载）
//   详情：点卡片 → 下方滑出完整内容（blocks 渲染 + 图片 + 溯源）
//   卡片操作：发送给 AI / 插入输入框 / 整理 / 删除（toast 撤销）
// 数据层：shared/kb-db.js（IndexedDB，扩展 origin）
// 写入事件：storage.local.kbFocusExcerpt（整理定位）
//          storage.onChanged 不可见 IDB，用 runtime DS_KB_CHANGED 补刷
// ============================================================

(() => {
  const kbBtn = document.getElementById("kb-btn");
  const kbBox = document.getElementById("kb");
  const kbClose = document.getElementById("kb-close");
  const projList = document.getElementById("kb-projects");
  const cardBox = document.getElementById("kb-cards");
  const searchInput = document.getElementById("kb-search");
  const kbTitle = document.getElementById("kb-title");
  const detailBox = document.getElementById("kb-detail");
  const detailBody = document.getElementById("kb-detail-body");
  const detailTitle = document.getElementById("kb-detail-title");
  const detailMeta = document.getElementById("kb-detail-meta");
  const detailClose = document.getElementById("kb-detail-close");
  const newProjBtn = document.getElementById("kb-new-project");
  const toastEl = document.getElementById("toast");

  // 关闭按钮也统一 SVG 图标
  if (detailClose) detailClose.innerHTML = svgIcon("close");
  // 详情头插入 上一篇/下一篇 按钮（HTML 不用手动维护）
  (function injectDetailNav() {
    const head = detailBox.querySelector(".kb-detail-head");
    const row = detailBox.querySelector(".kb-detail-head > div:last-child");
    if (!head || !row) return;
    const mk = (icon, title, dir) => {
      const b = document.createElement("button");
      b.className = "kb-detail-nav " + (dir < 0 ? "prev" : "next");
      b.title = title;
      b.innerHTML = svgIcon(icon);
      b.addEventListener("click", () => stepDetail(dir));
      return b;
    };
    head.insertBefore(mk("left", "上一篇", -1), row);
    head.insertBefore(mk("right", "下一篇", 1), row);
  })();

  let projects = [];
  let currentProj = "inbox";
  let excerpts = []; // 当前项目全部摘录（内存，搜索过滤）
  let detailId = null;
  let searchTimer = null;
  let undoStack = []; // 删除撤销快照 { excerpt, mediaList }

  // ---------- toast（带可选按钮） ----------
  let toastTimer = null;
  function kbToast(msg, actions) {
    toastEl.innerHTML = "";
    const t = document.createElement("span");
    t.textContent = msg;
    toastEl.appendChild(t);
    (actions || []).forEach(([label, fn]) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "margin-left:10px;border:none;background:rgba(255,255,255,.18);color:#fff;" +
        "border-radius:5px;padding:2px 10px;font-size:12px;cursor:pointer";
      b.addEventListener("click", () => {
        clearTimeout(toastTimer);
        toastEl.classList.remove("show");
        fn();
      });
      toastEl.appendChild(b);
    });
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), actions ? 5000 : 1800);
  }

  // ---------- 开关 ----------
  function openKb() {
    if (kbBox.classList.contains("show")) {
      closeKb(); // 顶栏按钮即开关：再点一次退出知识库
      return;
    }
    kbBox.classList.add("show");
    detailBox.classList.remove("show");
    detailId = null;
    refreshProjects().then(() => {
      selectProj(currentProj);
    });
  }
  function closeKb() {
    kbBox.classList.remove("show");
  }
  kbBtn.addEventListener("click", openKb);
  kbClose.addEventListener("click", closeKb);

  // 刷新按钮：重新拉取项目 + 摘录（注入到标题左侧，HTML 不用手动维护）
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "btn-text";
  refreshBtn.title = "刷新知识库";
  refreshBtn.textContent = "刷新";
  refreshBtn.style.cssText = "margin-right:auto";
  kbTitle.parentElement.insertBefore(refreshBtn, kbTitle.nextSibling);
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "刷新中…";
    await refreshProjects();
    await selectProj(currentProj);
    refreshBtn.disabled = false;
    refreshBtn.textContent = "刷新";
    kbToast("知识库已刷新");
  });
  // 切换 AI 站点时自动退出知识库（sidepanel 顶栏发出）
  document.addEventListener("kb-close-request", () => {
    if (kbBox.classList.contains("show")) closeKb();
  });

  // ============================================================
  // 导出 Markdown + 每日自动导出
  // 「导出」点击 → 未选目录先选，然后立即导出
  // 「自动」开关 → 开启每日自动导出（含清空）
  // ============================================================
  const exportBtn = document.createElement("button");
  exportBtn.className = "btn-text";
  exportBtn.title = "导出知识库为 Markdown（首次点击需选择导出目录）";
  const autoDot = document.createElement("span");
  autoDot.style.cssText =
    "display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;" +
    "background:#c8ccd2;vertical-align:middle";
  exportBtn.append(autoDot, document.createTextNode("导出"));
  kbTitle.parentElement.insertBefore(exportBtn, refreshBtn);

  const autoBtn = document.createElement("button");
  autoBtn.className = "btn-text";
  autoBtn.title = "每日自动导出：开启后每天上午自动导出 Markdown 并清空知识库";
  autoBtn.textContent = "自动";
  kbTitle.parentElement.insertBefore(autoBtn, exportBtn);
  refreshAutoDot();
  async function refreshAutoDot() {
    const on = await kbExportGetAuto();
    autoDot.style.background = on ? "#34a853" : "#c8ccd2";
    autoBtn.style.color = on ? "#1a73e8" : "";
    autoBtn.style.fontWeight = on ? "600" : "";
  }

  exportBtn.addEventListener("click", () => doExport(false));

  autoBtn.addEventListener("click", async () => {
    const on = !(await kbExportGetAuto());
    await toggleAuto(on);
  });

  async function pickDir() {
    try {
      await kbExportPickDir();
      return true;
    } catch (e) {
      if (e && e.name !== "AbortError") kbToast("选择目录失败：" + (e.message || e));
      return false;
    }
  }

  async function doExport(clear) {
    let handle = await kbExportGetDir();
    if (!handle) {
      const ok = await pickDir();
      if (!ok) return;
      handle = await kbExportGetDir();
    }
    // 手动导出前先确认一次读/写权限（浏览器可能要求重新授权）
    try {
      const q = await handle.queryPermission({ mode: "readwrite" });
      if (q !== "granted") await handle.requestPermission({ mode: "readwrite" });
    } catch (_e) {}
    exportBtn.disabled = true;
    try {
      const res = await kbExportRun(handle, clear);
      if (res.skipped) {
        kbToast("知识库是空的，没有可导出的内容");
      } else {
        kbToast(
          `已导出 ${res.count} 条到 ${kbExportFolderName(Date.now())}${clear ? "，知识库已清空" : ""}`
        );
        if (clear) {
          await loadExcerpts();
          renderProjects();
          renderCards();
        }
      }
    } catch (e) {
      kbToast("导出失败：" + (e.message || e));
    }
    exportBtn.disabled = false;
  }

  async function toggleAuto(on) {
    if (on) {
      const hasDir = await kbExportGetDir();
      if (!hasDir) {
        const ok = await pickDir();
        if (!ok) return;
      }
      if (
        !confirm(
          "开启后，每天上午自动把知识库导出为 Markdown 写入所选目录，并清空 IndexedDB 中的数据。\n确定开启？"
        )
      ) {
        return;
      }
      await kbExportSetAuto(true);
      chrome.runtime.sendMessage({ type: "DS_KB_EXPORT_SETTINGS" }).catch(() => {});
      kbToast("已开启每日自动导出（每天上午 9:30）");
    } else {
      await kbExportSetAuto(false);
      chrome.runtime.sendMessage({ type: "DS_KB_EXPORT_SETTINGS" }).catch(() => {});
      kbToast("已关闭每日自动导出");
    }
    refreshAutoDot();
  }

  // ---------- 项目 ----------
  async function refreshProjects() {
    await kbEnsureInbox();
    projects = (await kbListProjects()).sort((a, b) => {
      if (a.isInbox) return -1;
      if (b.isInbox) return 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    renderProjects();
  }

  function renderProjects() {
    projList.textContent = "";
    const counts = {};
    excerpts.forEach((x) => (counts[x.projectId] = (counts[x.projectId] || 0) + 1));
    // 全部摘录计数需要全量；简单起见每次全取太贵——用上次 selectProj 的数据 + 请求全量计数
    projects.forEach((p, i) => {
      const row = document.createElement("button");
      row.className = "kb-proj" + (p.id === currentProj ? " current" : "");
      row.style.animationDelay = Math.min(i * 25, 200) + "ms";
      const dot = document.createElement("span");
      dot.className = "kb-dot";
      dot.style.background = p.isInbox ? "#4285f4" : p.color || "#9334e6";
      const nm = document.createElement("span");
      nm.className = "kb-proj-name";
      nm.textContent = p.name;
      const badge = document.createElement("span");
      badge.className = "kb-count";
      // 整理闭环：收件箱存在「未整理」条目（tags 为空）→ 角标变橙并提示
      const unorganized = p.isInbox
        ? excerpts.filter((x) => x.projectId === p.id && !(x.tags || []).length).length
        : 0;
      if (unorganized) {
        badge.classList.add("unorganized");
        badge.title = `${unorganized} 条未整理（未加标签）`;
        row.classList.add("has-unorganized");
      }
      badge.textContent = counts[p.id] || 0;
      row.append(dot, nm, badge);
      row.title = p.name;
      row.addEventListener("click", () => selectProj(p.id));
      bindProjectDrop(row, p);
      if (!p.isInbox) {
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          projectMenu(p);
        });
      }
      projList.appendChild(row);
    });
  }

  // ---- 拖拽卡片到项目：移动摘录 ----
  function bindProjectDrop(row, p) {
    row.addEventListener("dragover", (e) => {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      row.classList.add("kb-proj-drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("kb-proj-drop"));
    row.addEventListener("drop", (e) => {
      if (!dragId) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove("kb-proj-drop");
      const x = excerpts.find((v) => v.id === dragId);
      dragEl = null;
      dragId = null;
      if (!x || x.projectId === p.id) return;
      x.projectId = p.id;
      x.updatedAt = Date.now();
      kbPutExcerpt(x).then(() => {
        kbToast(`已移入「${p.name}」`, [
          ["撤销", () => {
            x.projectId = "inbox";
            x.updatedAt = Date.now();
            kbPutExcerpt(x).then(() => selectProj(currentProj));
          }],
        ]);
        if (currentProj === p.id) {
          // 拖入该项目：立即显示
          loadExcerpts().then(renderCards);
        } else {
          // 从当前项目拖出：卡片带动画消失
          const el = cardBox.querySelector(`.kb-card[data-id="${x.id}"]`);
          if (el) {
            el.classList.add("removing");
            setTimeout(() => loadExcerpts().then(renderCards), 180);
          } else {
            loadExcerpts().then(renderCards);
          }
        }
        renderProjects();
      });
    });
  }

  // 项目右键菜单：重命名 / 删除
  function projectMenu(p) {
    document.getElementById("kb-ctx")?.remove();
    const menu = document.createElement("div");
    menu.id = "kb-ctx";
    menu.style.cssText =
      "position:fixed;z-index:60;background:#fff;border:1px solid #e4e6ea;border-radius:10px;" +
      "box-shadow:0 10px 32px rgba(0,0,0,.14);padding:4px;min-width:110px";
    const item = (label, danger, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "display:block;width:100%;border:none;background:none;text-align:left;padding:7px 10px;" +
        "border-radius:7px;font-size:12px;cursor:pointer;color:" + (danger ? "#d93025" : "#1c1f23");
      b.onmouseenter = () => (b.style.background = danger ? "#fdeeee" : "#f2f3f5");
      b.onmouseleave = () => (b.style.background = "none");
      b.onclick = () => {
        menu.remove();
        fn();
      };
      return b;
    };
    menu.appendChild(item("重命名", false, () => renameProject(p)));
    menu.appendChild(item("删除项目", true, () => deleteProject(p)));
    document.body.appendChild(menu);
    const close = () => {
      menu.remove();
      document.removeEventListener("click", close);
    };
    setTimeout(() => document.addEventListener("click", close), 0);
  }
  function renameProject(p) {
    const name = prompt("项目名称", p.name);
    if (name == null) return;
    const n = name.trim();
    if (!n) return;
    p.name = n;
    p.updatedAt = Date.now();
    kbPutProject(p).then(() => {
      refreshProjects();
      kbTitle.textContent = n;
    });
  }
  function deleteProject(p) {
    // 默认摘录移入收件箱；删除需确认
    if (!confirm(`删除「${p.name}」？其下摘录将移入收件箱。`)) return;
    kbDeleteProjectDeep(p.id, false).then(() => {
      kbToast(`已删除「${p.name}」，摘录移入收件箱`);
      if (currentProj === p.id) currentProj = "inbox";
      refreshProjects().then(() => selectProj(currentProj));
    });
  }
  newProjBtn.addEventListener("click", () => {
    const name = prompt("新项目名称");
    if (!name || !name.trim()) return;
    const p = {
      id: kbId("pj"),
      name: name.trim(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      color: ["#4285f4", "#34a853", "#f4b400", "#ea4335", "#9334e6", "#12b5cb"][
        Math.floor(Math.random() * 6)
      ],
    };
    kbPutProject(p).then(refreshProjects);
  });

  // ---------- 摘录列表 ----------
  async function selectProj(id) {
    currentProj = id;
    const p = projects.find((x) => x.id === id);
    kbTitle.textContent = p ? p.name : "知识库";
    await loadExcerpts();
    renderProjects();
    renderCards();
  }
  // 防竞态：删除后 180ms 的重渲染若撞上更早起飞的 loadExcerpts，
  // 会用旧数据把已删卡片画回来——序号保证只有最新一次加载生效
  let loadSeq = 0;
  async function loadExcerpts() {
    const seq = ++loadSeq;
    const all = await kbListExcerpts();
    const orderMap = await getOrderMap();
    if (seq !== loadSeq) return; // 已有更新的加载，丢弃这次旧结果
    const order = orderMap[currentProj] || [];
    const rank = (id) => {
      const i = order.indexOf(id);
      return i === -1 ? Infinity : i;
    };
    // excerpts 保留全量（项目计数用）；卡片顺序按自定义排序，未排序的按时间倒序
    excerpts = all.sort((a, b) => {
      if (a.projectId === currentProj && b.projectId === currentProj) {
        const ra = rank(a.id);
        const rb = rank(b.id);
        if (ra !== rb) return ra - rb;
      }
      return b.createdAt - a.createdAt;
    });
  }

  function matchSearch(x, q) {
    if (!q) return true;
    const hay = (
      x.title +
      " " +
      x.plainText +
      " " +
      (x.tags || []).join(" ") +
      " " +
      (x.sourceModel || "")
    ).toLowerCase();
    // 空格分词，全部命中才算
    return q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((t) => hay.includes(t));
  }

  function renderCards() {
    cardBox.textContent = "";
    const q = searchInput.value.trim();
    const list = excerpts.filter((x) => x.projectId === currentProj && matchSearch(x, q));
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "kb-empty";
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("class", "kb-empty-icon");
      icon.setAttribute("viewBox", "0 0 16 16");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "1.2");
      icon.setAttribute("stroke-linecap", "round");
      icon.setAttribute("stroke-linejoin", "round");
      icon.innerHTML =
        '<path d="M3 2.5h7.5a1 1 0 0 1 1 1V13a.9.9 0 0 0 .9.9H4a1.5 1.5 0 0 1-1.5-1.5V3a.5.5 0 0 1 .5-.5z"/>' +
        '<path d="M11.5 13.9H12a1.5 1.5 0 0 0 1.5-1.5V5.5H8.75"/>' +
        '<path d="M5.2 5.6h3.4M5.2 8.2h3.4"/>';
      empty.appendChild(icon);
      const line = document.createElement("div");
      line.textContent = q
        ? "没有匹配的摘录"
        : currentProj === "inbox"
          ? "收件箱是空的\n在 AI 网页选中文字或悬停回复即可存入"
          : "该项目还没有摘录";
      empty.appendChild(line);
      cardBox.appendChild(empty);
      return;
    }
    list.forEach((x, i) => {
      cardBox.appendChild(card(x, i));
    });
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (sameDay) return hm;
    const md = `${d.getMonth() + 1}月${d.getDate()}日`;
    if (d.getFullYear() === today.getFullYear()) return `${md} ${hm}`;
    return `${d.getFullYear()}/${md} ${hm}`;
  }

  function firstThumb(x) {
    const b = (x.blocks || []).find((b) => b.t === "img" && b.thumb);
    return b ? b.thumb : null;
  }

  function card(x, i) {
    const el = document.createElement("div");
    el.className = "kb-card";
    el.style.animationDelay = Math.min(i * 25, 250) + "ms";
    el.dataset.id = x.id;
    el.draggable = true;

    const thumb = firstThumb(x);
    if (thumb) {
      const im = document.createElement("img");
      im.className = "kb-card-thumb";
      im.src = thumb;
      im.draggable = false;
      el.appendChild(im);
    }
    const body = document.createElement("div");
    body.className = "kb-card-body";
    const title = document.createElement("div");
    title.className = "kb-card-title";
    title.textContent = x.title || "无标题";
    const preview = document.createElement("div");
    preview.className = "kb-card-preview";
    const plain = (x.plainText || "").replace(/\s+/g, " ").trim();
    preview.textContent = plain.slice(0, 90) || "（图片）";
    const meta = document.createElement("div");
    meta.className = "kb-card-meta";
    if (x.sourceModel) {
      const sm = document.createElement("span");
      sm.textContent = x.sourceModel;
      meta.appendChild(sm);
    }
    const tm = document.createElement("span");
    tm.className = "kb-time-pill";
    tm.textContent = fmtTime(x.createdAt);
    meta.appendChild(tm);
    // 图片数量角标（放进 meta 行，不遮挡内容）
    const imgCount = (x.blocks || []).filter((b) => b.t === "img").length;
    if (imgCount) {
      const badge = document.createElement("span");
      badge.className = "kb-img-badge";
      badge.innerHTML = svgIcon("image") + "<span>" + imgCount + "</span>";
      badge.title = imgCount + " 张图片";
      meta.appendChild(badge);
    }
    body.append(title, preview, meta);
    el.appendChild(body);

    // 拖拽手柄（hover 左缘显现）
    const grip = document.createElement("span");
    grip.className = "kb-grip";
    grip.innerHTML = svgIcon("grip");
    grip.title = "拖拽排序";
    el.appendChild(grip);

    // hover 操作条（SVG 图标）
    const ops = document.createElement("div");
    ops.className = "kb-card-ops";
    const opBtn = (icon, title, fn, danger) => {
      const b = document.createElement("button");
      b.innerHTML = svgIcon(icon);
      b.title = title;
      if (danger) b.className = "danger";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    ops.appendChild(opBtn("send", "发送给当前 AI（自动发送）", () => sendToAI(x, true)));
    ops.appendChild(opBtn("insert", "插入当前 AI 输入框（不发送）", () => sendToAI(x, false)));
    ops.appendChild(opBtn("folder", "整理：移动到项目", () => organize(x)));
    ops.appendChild(opBtn("trash", "删除", () => delExcerpt(x, el), true));
    el.appendChild(ops);

    el.addEventListener("click", () => openDetail(x));
    bindCardDrag(el, x);
    return el;
  }

  // ---------- 内联 SVG 图标库（16px 描边风） ----------
  function svgIcon(name) {
    const P = {
      send: '<path d="M14 2 7.5 8.5M14 2 9.8 14l-2.3-5.5L2 6.2 14 2z"/>',
      insert: '<path d="M10 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V5L10 2z"/><path d="M10 2v3h3M5.5 9h5M5.5 11.5h3"/>',
      folder: '<path d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.8h6.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4z"/>',
      trash: '<path d="M2.5 4h11M6.5 4V2.8a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8V4M4 4l.6 9.2a1 1 0 0 0 1 .8h4.8a1 1 0 0 0 1-.8L12 4M6.5 7v4.5M9.5 7v4.5"/>',
      image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.8" cy="6.5" r="1.2"/><path d="M2.5 11.5 6 8.5l2.5 2 2.5-2.5 2.5 2.5"/>',
      grip: '<circle cx="6" cy="4" r="1"/><circle cx="6" cy="8" r="1"/><circle cx="6" cy="12" r="1"/><circle cx="10" cy="4" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="10" cy="12" r="1"/>',
      left: '<path d="M10 3 5 8l5 5"/>',
      right: '<path d="M6 3l5 5-5 5"/>',
      close: '<path d="M4 4l8 8M12 4l-8 8"/>',
      edit: '<path d="M11.3 2.3a1.4 1.4 0 0 1 2 2L6 11.6l-2.8.8.8-2.8 7.3-7.3z"/><path d="M3 14h10"/>',
      open: '<path d="M6.5 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9.5M9.5 2H14v4.5M14 2 7.5 8.5"/>',
    };
    return (
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      (P[name] || "") +
      "</svg>"
    );
  }

  // ---------- 卡片拖拽排序（同项目内，持久化到 storage.kbCardOrder） ----------
  const ORDER_KEY = "kbCardOrder"; // { [projectId]: [excerptId,...] }
  async function getOrderMap() {
    const o = await new Promise((r) => chrome.storage.local.get(ORDER_KEY, (v) => r(v[ORDER_KEY] || {})));
    return o;
  }
  function bindCardDrag(el) {
    el.addEventListener("dragstart", (e) => {
      dragEl = el;
      dragId = el.dataset.id;
      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragId);
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      dragEl = null;
      dragId = null;
      cardBox.querySelectorAll(".kb-drop-above").forEach((n) => n.classList.remove("kb-drop-above"));
    });
    el.addEventListener("dragover", (e) => {
      if (!dragEl || dragEl === el) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = el.getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      el.classList.toggle("kb-drop-above", above);
      el.classList.toggle("kb-drop-below", !above);
    });
    el.addEventListener("dragleave", () => el.classList.remove("kb-drop-above", "kb-drop-below"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!dragEl || dragEl === el) return;
      const above = el.classList.contains("kb-drop-above");
      el.classList.remove("kb-drop-above", "kb-drop-below");
      // 计算新顺序（基于当前渲染顺序）
      const ids = [...cardBox.querySelectorAll(".kb-card")].map((n) => n.dataset.id).filter((id) => id !== dragId);
      let idx = ids.indexOf(el.dataset.id);
      if (!above) idx += 1;
      ids.splice(idx, 0, dragId);
      // 持久化：项目内完整顺序 = ids + 不在当前视图（搜索过滤掉）的其余摘录
      const orderMap = await getOrderMap();
      const restIds = excerpts
        .filter((x) => x.projectId === currentProj && !ids.includes(x.id))
        .map((x) => x.id);
      orderMap[currentProj] = ids.concat(restIds);
      await new Promise((r) => chrome.storage.local.set({ [ORDER_KEY]: orderMap }, r));
      // 立即按新顺序重渲染
      const byId = {};
      excerpts.forEach((x) => (byId[x.id] = x));
      excerpts = ids.concat(restIds).map((id) => byId[id]).filter(Boolean);
      renderCards();
      kbToast("已调整顺序");
    });
  }
  let dragEl = null;
  let dragId = null;

  // ---------- 详情 ----------
  async function openDetail(x) {
    // 可能已被改动过（如整理移动），重新取
    const fresh = (await kbGetExcerpt(x.id)) || x;
    detailId = x.id;
    detailTitle.textContent = fresh.title || "无标题";
    detailMeta.textContent = "";
    // 元信息胶囊：来源 + 时间
    [fresh.sourceModel, fmtTime(fresh.createdAt)].filter(Boolean).forEach((txt) => {
      const pill = document.createElement("span");
      pill.className = "kb-time-pill";
      pill.textContent = txt;
      detailMeta.appendChild(pill);
    });
    detailBody.textContent = "";
    renderBlocks(detailBody, fresh);
    // 参考资料区：AI 引用的网页链接，单独存放
    if ((fresh.refs || []).length) {
      const head = document.createElement("div");
      head.className = "kb-refs-head";
      head.textContent = `参考资料（${fresh.refs.length}）`;
      detailBody.appendChild(head);
      const list = document.createElement("div");
      list.className = "kb-refs";
      fresh.refs.forEach((r) => {
        const a = document.createElement("a");
        a.className = "kb-ref-item";
        a.href = r.url;
        a.target = "_blank";
        a.rel = "noopener";
        const t = document.createElement("span");
        t.className = "kb-ref-title";
        t.textContent = r.title || r.url;
        const u = document.createElement("span");
        u.className = "kb-ref-url";
        u.textContent = r.url;
        a.append(t, u);
        a.addEventListener("click", (e) => {
          e.preventDefault();
          chrome.runtime.sendMessage({ type: "DS_OPEN_IN_TAB", url: r.url }).catch(() => {});
        });
        list.appendChild(a);
      });
      detailBody.appendChild(list);
    }
    // 溯源链接
    if (fresh.sourceUrl) {
      const link = document.createElement("a");
      link.className = "kb-src-link";
      link.textContent = "查看来源页面 ↗";
      link.href = fresh.sourceUrl;
      link.target = "_blank";
      detailBody.appendChild(link);
    }
    detailBox.classList.add("show");
  }
  let lbEl = null; // 灯箱元素（存在即打开）
  function openLightbox(x, mi) {
    // 收集的是 img block 的 mi（media 序号），不是 blocks 下标
    const imgs = (x.blocks || [])
      .filter((b) => b.t === "img" && typeof b.mi === "number")
      .map((b) => b.mi);
    if (!imgs.length) return;
    let cur = Math.max(0, imgs.indexOf(mi));
    closeLightbox();
    lbEl = document.createElement("div");
    lbEl.className = "kb-lightbox";
    const img = document.createElement("img");
    const counter = document.createElement("span");
    counter.className = "kb-lb-counter";
    const render = async () => {
      img.src = "";
      const full = await kbGetMediaFull(x, imgs[cur]);
      if (!lbEl) return;
      if (full) img.src = full;
      counter.textContent = imgs.length > 1 ? `${cur + 1} / ${imgs.length}` : "";
      prevBtn.style.visibility = imgs.length > 1 && cur > 0 ? "visible" : "hidden";
      nextBtn.style.visibility = imgs.length > 1 && cur < imgs.length - 1 ? "visible" : "hidden";
    };
    const closeBtn = document.createElement("button");
    closeBtn.className = "kb-lb-close";
    closeBtn.innerHTML = svgIcon("close");
    closeBtn.title = "关闭";
    closeBtn.addEventListener("click", closeLightbox);
    const prevBtn = document.createElement("button");
    prevBtn.className = "kb-lb-nav prev";
    prevBtn.innerHTML = svgIcon("left");
    prevBtn.title = "上一张";
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (cur > 0) { cur--; render(); }
    });
    const nextBtn = document.createElement("button");
    nextBtn.className = "kb-lb-nav next";
    nextBtn.innerHTML = svgIcon("right");
    nextBtn.title = "下一张";
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (cur < imgs.length - 1) { cur++; render(); }
    });
    lbEl.append(img, closeBtn, prevBtn, nextBtn, counter);
    // 点背景关闭；点图片/按钮不冒泡
    lbEl.addEventListener("click", (e) => {
      if (e.target === lbEl) closeLightbox();
    });
    document.body.appendChild(lbEl);
    render();
  }
  function closeLightbox() {
    if (lbEl) { lbEl.remove(); lbEl = null; }
  }

  // ---- 详情正文渲染：结构化排版（标题/列表/表格/代码/图片） ----
  // 行内格式：**粗体**、`行内代码`、[文本](url) 链接（外链开新标签页）
  function kbInline(parent, text) {
    const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1] != null) {
        const b = document.createElement("strong");
        b.textContent = m[1];
        parent.appendChild(b);
      } else if (m[2] != null) {
        const c = document.createElement("code");
        c.className = "kb-inline-code";
        c.textContent = m[2];
        parent.appendChild(c);
      } else if (m[3] != null) {
        const a = document.createElement("a");
        a.href = m[4];
        a.textContent = m[3];
        a.target = "_blank";
        a.rel = "noopener";
        a.addEventListener("click", (e) => {
          e.preventDefault();
          chrome.runtime.sendMessage({ type: "DS_OPEN_IN_TAB", url: m[4] }).catch(() => {});
        });
        parent.appendChild(a);
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  // 标题行识别：# 前缀，或「一、/1./1.1/第X章」等开头的短行
  function kbHeadingLevel(text) {
    let m = text.match(/^(#{1,4})\s+(.*)$/);
    if (m) return { level: m[1].length + 1, text: m[2] };
    m = text.match(/^(第[一二三四五六七八九十百\d]+[章节部分]|[一二三四五六七八九十]+、|\d+(\.\d+)*\.?[、.\s])\s*\S/);
    if (m && text.length <= 60 && !/[。！？；;.…]$/.test(text)) return { level: 3, text };
    return null;
  }

  // ---- LaTeX / mermaid 渲染（KB 详情）----
  let mmSeq = 0;
  function renderMermaid(el, src) {
    if (typeof mermaid === "undefined") { kbCodeFallback(el, "mermaid", src); return; }
    try {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      const id = "kbmmd" + ++mmSeq;
      mermaid.render(id, src).then(
        ({ svg }) => { el.innerHTML = svg; },
        () => kbCodeFallback(el, "mermaid", src)
      );
    } catch (e) {
      kbCodeFallback(el, "mermaid", src);
    }
  }
  // 渲染失败 → 回退为普通代码块
  function kbCodeFallback(el, lang, text) {
    el.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "kb-code";
    const head = document.createElement("div");
    head.className = "kb-code-head";
    const tag = document.createElement("span");
    tag.className = "kb-code-lang";
    tag.textContent = lang;
    head.appendChild(tag);
    pre.appendChild(head);
    const code = document.createElement("code");
    code.textContent = text;
    pre.appendChild(code);
    el.appendChild(pre);
  }
  // 行内/独立公式渲染（文本块渲染完后对包含 $...$ / $$...$$ 的元素二次处理）
  function renderMathIn(el) {
    if (typeof renderMathInElement === "undefined") return;
    try {
      renderMathInElement(el, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
        ],
        throwOnError: false,
      });
    } catch (e) { /* 渲染失败保留原文 */ }
  }

  function renderBlocks(container, x) {
    const els = [];
    (x.blocks || []).forEach((b) => {
      if (b.t === "img") {
        const im = document.createElement("img");
        im.className = "kb-img";
        im.src = b.thumb || "";
        im.loading = "lazy";
        im.addEventListener("error", () => {
          // 加载失败 → 虚线占位（懒加载/失效图链常见）
          const ph = document.createElement("div");
          ph.className = "kb-img-broken";
          ph.textContent = "🖼 图片加载失败";
          im.replaceWith(ph);
        });
        im.addEventListener("click", () => {
          // 点图 → 应用内灯箱放大（多图可左右切换，Esc/点背景关闭）
          kbGetMediaFull(x, b.mi).then((full) => {
            if (full) openLightbox(x, b.mi);
          });
        });
        els.push(im);
        return;
      }
      if (b.t === "code") {
        // 表格块 → 真 <table>
        if (b.lang === "table" || b.lang === "markdown-table") {
          const rows = b.text.split("\n").filter((r) => r.trim());
          if (rows.length) {
            const wrap = document.createElement("div");
            wrap.className = "kb-table-wrap";
            const table = document.createElement("table");
            table.className = "kb-table";
            rows.forEach((row, ri) => {
              const cells = row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
                .filter((c) => !/^:?-{2,}:?$/.test(c) || c.length === 0);
              if (!cells.length) return;
              const tr = document.createElement("tr");
              cells.forEach((c) => {
                const td = document.createElement(ri === 0 ? "th" : "td");
                td.textContent = c;
                tr.appendChild(td);
              });
              table.appendChild(tr);
            });
            wrap.appendChild(table);
            els.push(wrap);
            return;
          }
        }
        // mermaid 代码块 → 渲染成流程图（失败回退为代码展示）
        if (b.lang === "mermaid") {
          const mm = document.createElement("div");
          mm.className = "kb-mermaid";
          els.push(mm);
          renderMermaid(mm, b.text);
          return;
        }
        const pre = document.createElement("pre");
        pre.className = "kb-code";
        if (b.lang) {
          const head = document.createElement("div");
          head.className = "kb-code-head";
          const tag = document.createElement("span");
          tag.className = "kb-code-lang";
          tag.textContent = b.lang;
          const copy = document.createElement("button");
          copy.className = "kb-code-copy";
          copy.textContent = "复制";
          copy.addEventListener("click", () => {
            navigator.clipboard.writeText(b.text).then(() => {
              copy.textContent = "已复制";
              setTimeout(() => (copy.textContent = "复制"), 1200);
            });
          });
          head.appendChild(tag);
          head.appendChild(copy);
          pre.appendChild(head);
        }
        const code = document.createElement("code");
        code.textContent = b.text;
        pre.appendChild(code);
        els.push(pre);
        return;
      }
      // 文本块：按行拆 → 标题 / 列表 / 段落
      const mathStart = els.length;
      const lines = (b.text || "").split("\n");
      let listEl = null, listOrdered = false;
      const flushList = () => { listEl = null; };
      lines.forEach((line) => {
        const t = line.trim();
        if (!t) { flushList(); return; }
        const h = kbHeadingLevel(t);
        if (h) {
          flushList();
          const hd = document.createElement("h" + Math.min(6, h.level));
          hd.className = "kb-h";
          kbInline(hd, h.text);
          els.push(hd);
          return;
        }
        const ulM = t.match(/^[•\-–*]\s+(.*)$/);
        const olM = t.match(/^(\d+)[.、)]\s+(.*)$/);
        // 任务列表：- [ ] / - [x] → 复选框
        const taskM = ulM && ulM[1].match(/^\[( |x|X)\]\s+(.*)$/);
        if (taskM) {
          flushList();
          const label = document.createElement("label");
          label.className = "kb-task";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.disabled = true;
          cb.checked = taskM[1].toLowerCase() === "x";
          const span = document.createElement("span");
          kbInline(span, taskM[2]);
          label.append(cb, span);
          els.push(label);
          return;
        }
        if (ulM || olM) {
          const ordered = !!olM;
          if (!listEl || listOrdered !== ordered) {
            listEl = document.createElement(ordered ? "ol" : "ul");
            listEl.className = "kb-list";
            listOrdered = ordered;
            els.push(listEl);
          }
          const li = document.createElement("li");
          kbInline(li, (ulM || olM)[ulM ? 1 : 2]);
          listEl.appendChild(li);
          return;
        }
        flushList();
        // 引用块：> 开头的连续行
        const quoteM = t.match(/^>\s?(.*)$/);
        if (quoteM) {
          flushList();
          let q = els[els.length - 1];
          if (!(q && q.classList && q.classList.contains("kb-quote"))) {
            q = document.createElement("blockquote");
            q.className = "kb-quote";
            els.push(q);
          }
          const p = document.createElement("p");
          p.className = "kb-p";
          kbInline(p, quoteM[1]);
          q.appendChild(p);
          return;
        }
        const p = document.createElement("p");
        p.className = "kb-p";
        kbInline(p, t);
        els.push(p);
      });
      // 文本块渲染后对含 $...$ / $$...$$ 的行内公式二次处理
      for (let i = mathStart; i < els.length; i++) renderMathIn(els[i]);
    });
    els.forEach((el, i) => {
      if (i > 0) el.style.marginTop = "";
      container.appendChild(el);
    });
  }
  async function kbGetMediaFull(x, mi) {
    if (typeof mi !== "number" || !(x.mediaIds || [])[mi]) return null;
    const m = await kbGetMedia(x.mediaIds[mi]);
    return m ? m.dataUrl : null;
  }
  detailClose.addEventListener("click", () => {
    detailBox.classList.remove("show");
    detailId = null;
  });

  // 详情内 上一篇/下一篇：循环当前卡片列表（按项目 + 搜索过滤后的顺序）
  function detailNavList() {
    return excerpts.filter(
      (x) => x.projectId === currentProj && matchSearch(x, searchInput.value.trim())
    );
  }
  function stepDetail(dir) {
    const list = detailNavList();
    if (list.length < 2) return;
    const i = list.findIndex((x) => x.id === detailId);
    if (i === -1) return;
    const next = list[(i + dir + list.length) % list.length];
    openDetail(next);
  }

  // ---------- 操作：发送给 AI / 插入输入框 ----------
  function excerptToText(x) {
    return (x.blocks || [])
      .filter((b) => b.t !== "img")
      .map((b) => (b.t === "code" ? "```\n" + b.text + "\n```" : b.text))
      .join("\n\n")
      .slice(0, 20000);
  }
  async function sendToAI(x, autoSend) {
    const text = `【${x.title}】\n` + excerptToText(x);
    if (!text.trim()) return kbToast("该摘录没有文字内容");
    // 写 aiPendingPrompt：当前 AI 站点桥会轮询填入输入框
    await chrome.storage.local.set({
      aiPendingPrompt: { text: text + "\n", at: Date.now(), send: !!autoSend },
    });
    closeKb();
    kbToast(autoSend ? "已发送给当前 AI" : "已插入当前 AI 输入框");
  }

  // ---------- 操作：整理（移动项目 + 标签） ----------
  function organize(x) {
    document.getElementById("kb-org")?.remove();
    const panel = document.createElement("div");
    panel.id = "kb-org";
    panel.style.cssText =
      "position:fixed;z-index:60;bottom:52px;left:50%;transform:translateX(-50%);" +
      "background:#fff;border:1px solid #e4e6ea;border-radius:12px;padding:12px;" +
      "box-shadow:0 12px 36px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:8px;min-width:220px";
    const title = document.createElement("div");
    title.style.cssText = "font-size:12px;color:#9aa0a6";
    title.textContent = "移动到项目";
    panel.appendChild(title);
    const grid = document.createElement("div");
    grid.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";
    projects.forEach((p) => {
      const b = document.createElement("button");
      b.textContent = p.name;
      b.disabled = p.id === x.projectId;
      b.style.cssText =
        "border:1px solid #dcdfe3;background:none;border-radius:999px;padding:4px 12px;" +
        "font-size:12px;cursor:pointer" +
        (p.id === x.projectId ? ";opacity:.4" : "");
      b.onclick = () => {
        x.projectId = p.id;
        x.updatedAt = Date.now();
        kbPutExcerpt(x).then(() => {
          panel.remove();
          kbToast(`已移入「${p.name}」`, [
            ["撤销", () => {
              x.projectId = "inbox";
              x.updatedAt = Date.now();
              kbPutExcerpt(x).then(() => selectProj(currentProj));
            }],
          ]);
          loadExcerpts().then(renderCards);
          if (currentProj !== p.id) selectProj(currentProj);
          else renderCards();
        });
      };
      grid.appendChild(b);
    });
    panel.appendChild(grid);
    const tagsRow = document.createElement("div");
    tagsRow.style.cssText = "display:flex;gap:6px";
    const tagInput = document.createElement("input");
    tagInput.placeholder = "标签（空格分隔，可选）";
    tagInput.value = (x.tags || []).join(" ");
    tagInput.style.cssText =
      "flex:1;border:1px solid #dcdfe3;border-radius:8px;padding:6px 9px;font-size:12px;outline:none";
    const saveTag = document.createElement("button");
    saveTag.textContent = "存标签";
    saveTag.style.cssText =
      "border:none;background:#4285f4;color:#fff;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer";
    saveTag.onclick = () => {
      x.tags = tagInput.value.trim().split(/\s+/).filter(Boolean);
      x.updatedAt = Date.now();
      kbPutExcerpt(x).then(() => {
        panel.remove();
        kbToast("标签已更新");
        loadExcerpts().then(renderCards);
      });
    };
    tagsRow.append(tagInput, saveTag);
    panel.appendChild(tagsRow);
    document.body.appendChild(panel);
    setTimeout(() => {
      const close = (e) => {
        if (!panel.contains(e.target)) {
          panel.remove();
          document.removeEventListener("click", close);
        }
      };
      document.addEventListener("click", close);
    }, 0);
  }

  // ---------- 操作：删除（toast 撤销） ----------
  async function delExcerpt(x, el) {
    const mediaList = [];
    for (const id of x.mediaIds || []) {
      const m = await kbGetMedia(id);
      if (m) mediaList.push(m);
    }
    await kbRemoveExcerpt(x.id);
    el.classList.add("removing");
    setTimeout(() => {
      loadExcerpts().then(renderCards);
    }, 180);
    undoStack.push({ excerpt: x, mediaList });
    kbToast(`已删除「${(x.title || "").slice(0, 20)}」`, [
      ["撤销", async () => {
        const snap = undoStack.pop();
        if (!snap) return;
        await kbSaveExcerpt(snap.excerpt, snap.mediaList);
        await loadExcerpts();
        renderCards();
        kbToast("已恢复");
      }],
    ]);
  }

  // ---------- 搜索 ----------
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderCards, 150);
  });

  // ---------- 外部写入联动 ----------
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "DS_KB_CHANGED" && kbBox.classList.contains("show")) {
        loadExcerpts().then(renderCards);
      }
    });
  }
  if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener((changes, area) => {
    // content script「整理」：打开侧边栏并定位到该条
    if (area === "local" && changes.kbFocusExcerpt && changes.kbFocusExcerpt.newValue) {
      const f = changes.kbFocusExcerpt.newValue;
      chrome.storage.local.remove("kbFocusExcerpt");
      if (Date.now() - (f.at || 0) > 60000) return;
      kbBox.classList.add("show");
      loadExcerpts().then(() => {
        renderProjects();
        const x = excerpts.find((e) => e.id === f.id);
        if (x) {
          currentProj = x.projectId;
          renderProjects();
          renderCards();
          openDetail(x);
        }
      });
    }
  });

  // Esc：关灯箱 → 关详情 → 关知识库
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && kbBox.classList.contains("show")) {
      if (lbEl) {
        closeLightbox();
      } else if (detailBox.classList.contains("show")) {
        detailBox.classList.remove("show");
        detailId = null;
      } else {
        closeKb();
      }
    }
    // 灯箱左右方向键切换
    if (lbEl && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const nav = lbEl.querySelector(e.key === "ArrowLeft" ? ".kb-lb-nav.prev" : ".kb-lb-nav.next");
      if (nav && nav.style.visibility !== "hidden") nav.click();
    }
  });

  // ============================================================
  // 详情编辑 / 上传图片 / 粘贴截图
  // ============================================================
  const IMG_PH = "🖼";

  // blocks → 可编辑文本（代码/表格进 fence，图片占位独立成行）
  function blocksToEditable(x) {
    const out = [];
    (x.blocks || []).forEach((b) => {
      if (b.t === "img") {
        out.push(IMG_PH);
      } else if (b.t === "code") {
        const lang = b.lang || "";
        const fence = b.text.includes("```") ? "````" : "```";
        out.push(fence + lang + "\n" + b.text + (b.text.endsWith("\n") ? "" : "\n") + fence);
      } else {
        out.push(b.text || "");
      }
    });
    return out.join("\n\n");
  }

  // 可编辑文本 → blocks（fence 代码块 + 图片占位 + 普通段落）
  function editableToBlocks(text) {
    const blocks = [];
    const lines = String(text || "").split("\n");
    let para = [];
    let inFence = false, fenceLang = "", fenceBody = [];
    const flushPara = () => {
      if (para.length) {
        blocks.push({ t: "p", text: para.join("\n").replace(/\n{3,}/g, "\n\n").trim() });
        para = [];
      }
    };
    for (const line of lines) {
      const fm = line.match(/^(`{3,4})(\w*)\s*$/);
      if (fm) {
        if (inFence) {
          blocks.push({ t: "code", lang: fenceLang, text: fenceBody.join("\n") });
          inFence = false; fenceBody = []; fenceLang = "";
        } else {
          flushPara();
          inFence = true; fenceLang = fm[2] || "";
        }
        continue;
      }
      if (inFence) { fenceBody.push(line); continue; }
      if (line.trim() === IMG_PH) {
        flushPara();
        blocks.push({ t: "img" });
        continue;
      }
      para.push(line);
    }
    if (inFence) blocks.push({ t: "code", lang: fenceLang, text: fenceBody.join("\n") });
    flushPara();
    return blocks;
  }

  // 压缩上传图 → {dataUrl, mime, thumb}
  function kbCompressUpload(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, 1200 / Math.max(im.width, im.height));
        const w = Math.max(1, Math.round(im.width * scale));
        const h = Math.max(1, Math.round(im.height * scale));
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(im, 0, 0, w, h);
        const isPng = blob.type === "image/png";
        const dataUrl = cv.toDataURL(isPng ? "image/png" : "image/jpeg", 0.82);
        const ts = Math.min(1, 300 / Math.max(w, h));
        const tc = document.createElement("canvas");
        tc.width = Math.max(1, Math.round(w * ts));
        tc.height = Math.max(1, Math.round(h * ts));
        tc.getContext("2d").drawImage(im, 0, 0, tc.width, tc.height);
        const thumb = tc.toDataURL("image/jpeg", 0.7);
        resolve({ dataUrl, mime: isPng ? "image/png" : "image/jpeg", thumb });
      };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片解码失败")); };
      im.src = url;
    });
  }

  let editState = null; // { id, media: Map(id -> {dataUrl,mime,thumb}) }

  async function startEdit(x) {
    const fresh = (await kbGetExcerpt(x.id)) || x;
    editState = { id: fresh.id, media: new Map() };
    detailTitle.contentEditable = "plaintext-only";
    detailTitle.style.outline = "none";
    const ta = document.createElement("textarea");
    ta.id = "kb-edit-ta";
    ta.value = blocksToEditable(fresh);
    ta.spellcheck = false;
    detailBody.textContent = "";
    detailBody.appendChild(ta);
    const bar = document.createElement("div");
    bar.id = "kb-edit-bar";
    const fileBtn = document.createElement("button");
    fileBtn.className = "btn-text";
    fileBtn.textContent = "📎 上传图片";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    fileBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      for (const f of fileInput.files) await addImageFile(f);
      fileInput.value = "";
    });
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn-text";
    saveBtn.textContent = "✓ 保存";
    saveBtn.addEventListener("click", () => saveEdit(fresh));
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-text";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", () => {
      editState = null;
      openDetail(fresh);
    });
    bar.append(fileBtn, fileInput, saveBtn, cancelBtn);
    detailBody.appendChild(bar);
    // 粘贴截图：编辑框内 Ctrl+V 剪贴板图片
    ta.addEventListener("paste", async (e) => {
      const items = [...((e.clipboardData || {}).items || [])];
      const imgItem = items.find((it) => it.type.startsWith("image/"));
      if (!imgItem) return; // 文本粘贴走默认
      e.preventDefault();
      const blob = imgItem.getAsFile();
      if (blob) await addImageFile(blob);
    });
    ta.focus();
  }

  // 加入一张图片：压缩 → 暂存 editState → 文本域末尾追加占位符
  async function addImageFile(blob) {
    if (!editState) return;
    try {
      const r = await kbCompressUpload(blob);
      const mid = kbId("med");
      editState.media.set(mid, r);
      const ta = document.getElementById("kb-edit-ta");
      ta.value = ta.value.replace(/\s*$/, "") + "\n\n" + IMG_PH + "\n";
      kbToast("已添加图片（保存后生效）");
    } catch (err) {
      kbToast("图片处理失败：" + (err.message || err));
    }
  }

  async function saveEdit(fresh) {
    if (!editState) return;
    const ta = document.getElementById("kb-edit-ta");
    const title = (detailTitle.textContent || "").trim() || "无标题";
    const parsed = editableToBlocks(ta.value);
    // 占位符 ↔ 图片配对：原有 img 按顺序保留 mi/thumb；新增的依次消费 editState.media
    const origImgs = (fresh.blocks || []).filter((b) => b.t === "img");
    let oi = 0;
    const mediaAdds = [];
    const plainParts = [];
    const finalBlocks = [];
    parsed.forEach((b) => {
      if (b.t === "img") {
        const orig = origImgs[oi];
        if (orig) {
          b.mi = orig.mi; b.thumb = orig.thumb;
          finalBlocks.push(b);
        } else {
          const entry = editState.media.entries().next();
          if (!entry.done) {
            const [mid, r] = entry.value;
            editState.media.delete(mid);
            b.mi = (fresh.mediaIds || []).length + mediaAdds.length;
            b.thumb = r.thumb;
            mediaAdds.push({ id: mid, dataUrl: r.dataUrl, mime: r.mime, thumb: r.thumb });
            finalBlocks.push(b);
          }
          // 没配到 media 的占位符 → 丢弃
        }
        oi++;
      } else {
        finalBlocks.push(b);
        plainParts.push(b.text);
      }
    });
    const excerpt = {
      ...fresh,
      title,
      blocks: finalBlocks.filter((b) => b.t !== "p" || (b.text || "").trim()),
      plainText: plainParts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 20000),
      mediaIds: [...(fresh.mediaIds || []), ...mediaAdds.map((m) => m.id)],
      updatedAt: Date.now(),
    };
    await kbSaveExcerpt(excerpt, mediaAdds);
    editState = null;
    kbToast("已保存修改");
    await loadExcerpts();
    renderCards();
    openDetail(excerpt);
  }

  // 详情头「编辑」按钮
  (function injectEditBtn() {
    const row = detailBox.querySelector(".kb-detail-head > div:last-child");
    if (!row || document.getElementById("kb-detail-edit")) return;
    const b = document.createElement("button");
    b.id = "kb-detail-edit";
    b.className = "row-btn kb-icon-btn";
    b.title = "编辑（改标题/正文，上传或粘贴图片）";
    b.innerHTML = svgIcon("edit");
    b.addEventListener("click", () => {
      if (editState) return;
      const x = excerpts.find((e) => e.id === detailId);
      if (x) startEdit(x);
    });
    row.insertBefore(b, detailClose);
  })();
})();
