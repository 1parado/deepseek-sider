// ============================================================
// DeepSeek Sider - Background Service Worker
// 职责：
//   1. 右键菜单「AI 一下」：把选中内容投递给侧边栏当前 AI 的输入框
//   2. 侧边栏请求的「弹出独立小窗」（按站点列表查找/兜底）
//   3. （保留）AI 页面桥的 browser 指令执行路由
// 站点列表：storage.local.aiSites（用户自定义）优先，
//           回落 BUILTIN_AI_SITES（shared/ai-sites.js）。
// ============================================================

importScripts("../shared/ai-sites.js");

// Agent 目标标签页（协议指令 read/click 等作用对象）
let agentTabId = null;

const EXECUTABLE_ACTIONS = new Set([
  "read",
  "click",
  "fill",
  "extract",
  "scroll",
  "select",
  "get_interactive",
]);

async function getSiteList() {
  const d = await chrome.storage.local.get("aiSites");
  const list = d && d.aiSites;
  return Array.isArray(list) && list.length && list.every(isValidSite) ? list : BUILTIN_AI_SITES;
}

async function getActiveSite() {
  const [sites, d] = await Promise.all([getSiteList(), chrome.storage.local.get("dsActiveSite")]);
  return sites.find((s) => s.id === d.dsActiveSite) || sites[0] || null;
}

// 按站点 id 取站点（指定 id 不存在时回落 null，由调用方兜底）
async function getSiteById(id) {
  const sites = await getSiteList();
  return sites.find((s) => s.id === id) || null;
}

chrome.runtime.onInstalled.addListener(() => {
  // 点击工具栏图标时打开侧边栏
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});

  // 右键菜单：选中文本 → AI 一下
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "ds-ask-selection",
      title: "AI 一下",
      contexts: ["selection"],
    });
  });
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

// ---- 右键菜单点击：把选中内容投递给侧边栏当前 AI 的输入框 ----
// 参照 Chrome 官方模式（contextMenus 示例）：回调里【同步】调用
// sidePanel.open() 保住用户手势。注意不要在 open 之前 await 任何异步
// 操作——手势会在第一个 await 后丢失，open 将被 Chrome 拒绝。
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "ds-ask-selection" || !info.selectionText || !tab) return;

  const prompt =
    "关于我在页面上选中的内容（页面：" +
    (tab.title || "") +
    "，URL：" +
    info.pageUrl +
    "）：\n" +
    info.selectionText +
    "\n";

  // 1. 用户手势上下文内同步打开原生侧边栏；失败则走停靠小窗兜底
  chrome.sidePanel
    .open({ windowId: tab.windowId })
    .then(() => console.info("[DS BG] 侧边栏已打开"))
    .catch((e) => {
      console.warn("[DS BG] sidePanel.open 失败：", e);
      openDockedWindowIfBridgeDead();
    });

  // 2. 投递内容：页面桥（侧边栏 iframe / 停靠小窗中）经 storage 变化
  //    收到后填入当前 AI 站点输入框（不自动发送）
  chrome.storage.local.set({
    aiPendingPrompt: { text: prompt, at: Date.now(), send: false },
  });
});

// 侧边栏打不开时：页面桥心跳还活着（桥已在某处运行）就不弹窗；
// 否则弹出/复用贴边停靠小窗（真实标签页，脚本注入必定生效）
async function openDockedWindowIfBridgeDead() {
  // 心跳按站点 host 分键（dsBridgeBeat.<host>，桥 3s 一写）；
  // 任一 host 的心跳在 10s 内即视为桥存活（兼容旧全局键 dsBridgeBeat）
  const all = await new Promise((r) => chrome.storage.local.get(null, (d) => r(d || {})));
  const now = Date.now();
  const alive = Object.keys(all).some(
    (k) => (k === "dsBridgeBeat" || k.startsWith("dsBridgeBeat.")) && typeof all[k] === "number" && now - all[k] < 10000
  );
  if (alive) return;
  await openDockedWindow();
  console.warn("[DS BG] 侧边栏无法程序化打开，已改用贴边停靠小窗投递");
}

// 打开（或聚焦已存在的）停靠在当前窗口右缘的 AI 小窗
// siteId 可选：指定时弹出该站点（对比模式下每个面板可独立弹出），
// 缺省用上次选中的站点。不同站点的小窗可同时存在，重复弹出 = 聚焦已有小窗
async function openDockedWindow(siteId) {
  const site = siteId ? await getSiteById(siteId) : await getActiveSite();
  if (!site) return;

  // 已有该站点的小窗：聚焦即可，内容会经 storage 投递自动填入
  const origin = new URL(site.url).origin + "/*";
  const existing = (await chrome.tabs.query({ url: origin })).find((t) => t.windowId != null);
  if (existing) {
    const win = await chrome.windows.get(existing.windowId);
    if (win.type === "popup") {
      // 扩展刷新后旧小窗里的桥接脚本会失效：ping 不通就重载页面重新注入
      // （bridge.js 在所有页面都会应答 DS_PING，这里只认 ai 桥的专属标记）
      let alive = false;
      try {
        const res = await chrome.tabs.sendMessage(existing.id, { type: "DS_PING" });
        alive = !!(res && res.bridge === "deepseek");
      } catch (e) {
        alive = false;
      }
      if (!alive) chrome.tabs.reload(existing.id);
      chrome.windows.update(win.id, { focused: true });
      return;
    }
  }

  const PANEL_WIDTH = 430;
  const cur = await chrome.windows.getLastFocused();
  const width = Math.min(PANEL_WIDTH, cur.width || PANEL_WIDTH);
  const height = cur.height || 800;
  await chrome.windows.create({
    url: site.url,
    type: "popup",
    top: cur.top != null ? cur.top : 0,
    left: cur.left != null ? cur.left + Math.max(0, (cur.width || 0) - width) : 0,
    width,
    height,
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // ---- 侧边栏「弹出为独立小窗」按钮（可指定站点，不改变当前选中态） ----
  if (msg.type === "DS_POPUP_WINDOW") {
    openDockedWindow(msg.siteId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  // ---- 来自 AI 页面桥的协议指令 ----
  if (msg.type === "DS_BRIDGE_CMD") {
    handleCommand(msg.command)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true; // 异步响应
  }
});

async function handleCommand(cmd) {
  if (Array.isArray(cmd)) {
    const results = [];
    for (const c of cmd) results.push(await handleCommand(c));
    return { ok: true, results };
  }
  if (!cmd || typeof cmd !== "object") {
    return { ok: false, error: "无效命令" };
  }

  const action = cmd.action;

  // ---- 标签页级命令 ----
  if (action === "open") {
    if (!cmd.url || !/^https?:\/\//i.test(cmd.url)) {
      return { ok: false, error: "open 需要 http(s) 的 url 字段" };
    }
    const tab = await chrome.tabs.create({ url: cmd.url, active: cmd.active !== false });
    agentTabId = tab.id;
    await waitForLoad(tab.id);
    const fresh = await chrome.tabs.get(tab.id).catch(() => null);
    return { ok: true, tabId: tab.id, title: fresh ? fresh.title : "", url: fresh ? fresh.url : cmd.url };
  }

  if (action === "list_tabs") {
    const tabs = await chrome.tabs.query({});
    return {
      ok: true,
      tabs: tabs
        .filter((t) => /^https?:/i.test(t.url || ""))
        .slice(0, 30)
        .map((t) => ({ id: t.id, title: t.title, url: t.url })),
    };
  }

  if (action === "switch") {
    if (typeof cmd.tabId !== "number") return { ok: false, error: "switch 需要数字 tabId（先调用 list_tabs 获取）" };
    const tab = await chrome.tabs.get(cmd.tabId).catch(() => null);
    if (!tab) return { ok: false, error: "tabId 不存在：" + cmd.tabId };
    agentTabId = tab.id;
    await chrome.tabs.update(tab.id, { active: true });
    return { ok: true, tabId: tab.id, title: tab.title, url: tab.url };
  }

  if (action === "close") {
    if (typeof cmd.tabId === "number") {
      await chrome.tabs.remove(cmd.tabId);
      if (agentTabId === cmd.tabId) agentTabId = null;
      return { ok: true };
    }
    return { ok: false, error: "close 需要数字 tabId" };
  }

  // ---- DOM 级命令：转发给页面执行器 ----
  if (EXECUTABLE_ACTIONS.has(action)) {
    const tab = await resolveTab();
    if (!tab || !tab.id) return { ok: false, error: "没有可操作的标签页，请先执行 open 或 switch" };
    agentTabId = tab.id;
    await ensureBridge(tab.id);
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: "DS_BROWSER_CMD",
      command: cmd,
    });
    return res;
  }

  return { ok: false, error: "未知 action：" + action };
}

// 目标标签页：优先用 agent 记住的标签页，其次当前激活标签页
async function resolveTab() {
  if (agentTabId != null) {
    const t = await chrome.tabs.get(agentTabId).catch(() => null);
    if (t) return t;
    agentTabId = null;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

// 确保目标页面已注入执行器；没注入则补一次
async function ensureBridge(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "DS_PING" });
  } catch (e) {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["content/bridge.js"],
    });
  }
}

// 等待页面加载完成（最多 15s），给 SPA 一点渲染余量
function waitForLoad(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(resolve, 800);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, 15000);
  });
}
