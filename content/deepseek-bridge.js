// ============================================================
// DeepSeek Browser Bridge - DeepSeek 页面桥
// 注入到 chat.deepseek.com（真实标签页、侧边栏 iframe、停靠小窗；
// 侧边栏 iframe 中 content script 可运行，但只能用 storage 通信，
// 无法被 tabs.sendMessage 直达）。
// 工作原理（"代码块协议"）：
//   1. 监听 DeepSeek 回复中新增的代码块
//   2. 若代码块是符合协议的 JSON（tool === "browser"），解析出指令
//   3. 交给 background 执行，拿到结果
//   4. 把结果回填到 DeepSeek 输入框（send 决定是否自动发送）
// 另：监听 storage 的 dsPendingPrompt（右键「DeepSeek 一下」投递），
//   把内容填进输入框供用户补充提问。
// 协议格式（DeepSeek 需按此输出）：
//   ```browser
//   {"tool":"browser","action":"open","url":"https://example.com"}
//   ```
// 诊断：在 DeepSeek 页面按 F12 打开控制台，筛选 "[DS Bridge]"
// 可看到捕获指令 / 执行结果 / 回填状态等运行日志。
// ============================================================

(() => {
  if (window.__dsAgentBridge) return;
  window.__dsAgentBridge = true;

  const log = (...args) => console.info("[DS Bridge]", ...args);
  const warn = (...args) => console.warn("[DS Bridge]", ...args);

  const EXECUTABLE_ACTIONS = new Set([
    "open",
    "list_tabs",
    "switch",
    "close",
    "read",
    "click",
    "fill",
    "extract",
    "scroll",
    "select",
    "get_interactive",
  ]);

  // 设置（保留 storage 通道；结果回填默认不自动发送）
  const settings = { enabled: true, autoSend: false };
  chrome.storage.local.get("dsBridgeSettings", (d) => {
    if (d && d.dsBridgeSettings) Object.assign(settings, d.dsBridgeSettings);
  });

  // 心跳：供侧边栏面板检测页面桥是否存活（未注入时面板显示复制兜底）
  setInterval(() => {
    chrome.storage.local.set({ dsBridgeBeat: Date.now() });
  }, 3000);

  // 存活探测：background 检查小窗里的桥是否还活着（失效则重载页面重新注入）
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "DS_PING") sendResponse({ ok: true, bridge: "deepseek" });
    // 不返回 true：无需保持通道，同步应答即可
  });

  let lastHandled = ""; // 已处理代码块的指纹，防止重复执行
  let running = false;

  // ---------- 容错 JSON 解析 ----------
  // DeepSeek 渲染的代码块可能混入语言标签（"browser"）、围栏残留等
  function tryParse(raw) {
    let text = (raw || "").trim();
    // 去掉成对/残留的围栏
    text = text.replace(/^`+/, "").replace(/`+$/, "").trim();
    try {
      return JSON.parse(text);
    } catch (e) {
      /* 继续尝试 */
    }
    // 从第一个 { 或 [ 开始截取再试（跳过语言标签等前缀杂质）
    const start = text.search(/[{[]/);
    if (start > 0) {
      try {
        return JSON.parse(text.slice(start).replace(/`+$/, "").trim());
      } catch (e) {
        /* 放弃 */
      }
    }
    return null;
  }

  // 是否"像"协议指令（用于区分普通代码块与格式错误的协议指令）
  function looksLikeProtocol(text) {
    return /"tool"\s*:\s*"browser"/.test(text);
  }

  // ---------- 扫描代码块 ----------

  function scanCodeBlocks() {
    if (!settings.enabled || running) return;
    // 覆盖 pre code / pre / code 三种渲染结构，取文档中最后一个
    const nodes = document.querySelectorAll("pre code, pre, code");
    if (!nodes.length) return;
    const last = nodes[nodes.length - 1];
    const raw = (last.textContent || "").trim();
    if (!raw || raw === lastHandled) return;

    if (!looksLikeProtocol(raw)) return; // 普通代码块，静默忽略

    const parsed = tryParse(raw);
    if (!parsed) {
      warn("检测到疑似协议代码块但 JSON 解析失败：", raw.slice(0, 200));
      lastHandled = raw;
      return;
    }
    const commands = Array.isArray(parsed) ? parsed : [parsed];
    if (
      !commands.length ||
      commands.some((c) => !c || c.tool !== "browser" || !EXECUTABLE_ACTIONS.has(c.action))
    ) {
      warn("协议代码块中含有无效指令：", JSON.stringify(commands).slice(0, 200));
      lastHandled = raw;
      return;
    }

    lastHandled = raw;
    log("捕获指令：", JSON.stringify(commands));
    running = true;
    runCommands(commands).finally(() => {
      running = false;
      setTimeout(scanCodeBlocks, 1200);
    });
  }

  async function runCommands(commands) {
    const results = [];
    for (const cmd of commands) {
      try {
        const res = await chrome.runtime.sendMessage({ type: "DS_BRIDGE_CMD", command: cmd });
        log("执行结果：", cmd.action, res);
        results.push({ action: cmd.action, ...(res || { ok: false, error: "无响应" }) });
      } catch (e) {
        warn("发送指令失败：", e);
        results.push({ action: cmd.action, ok: false, error: String(e) });
      }
    }
    const single = results.length === 1 ? results[0] : results;
    const payload = formatResult(single);
    const filled = await fillInput(payload);
    if (!filled) warn("回填失败：未找到 DeepSeek 输入框");
    if (settings.autoSend) await autoSend();
  }

  function formatResult(res) {
    try {
      const s = JSON.stringify(res, null, 2);
      return "[browser 结果]\n```json\n" + (s.length > 8000 ? s.slice(0, 8000) + "\n... (已截断)" : s) + "\n```";
    } catch (e) {
      return "[browser 结果]\n" + String(res);
    }
  }

  // ---------- 回填 DeepSeek 输入框 ----------

  function findInput() {
    return (
      document.querySelector("textarea#chat-input") ||
      document.querySelector("textarea") ||
      document.querySelector('[contenteditable="true"]')
    );
  }

  async function fillInput(text) {
    // 新开标签页时 DeepSeek 是 SPA，输入框可能好几秒后才渲染，放宽到 ~12s
    for (let i = 0; i < 40; i++) {
      const el = findInput();
      if (el) {
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          el.textContent = text;
          el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        }
        el.focus();
        return true;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  function inputIsEmpty(el) {
    if (!el) return true;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return !el.value.trim();
    return !el.textContent.trim();
  }

  // 发送后校验输入框是否被清空；没清空说明没发出去，重试
  async function autoSend() {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 300));
      const btns = document.querySelectorAll('div[role="button"], button');
      for (const b of btns) {
        const aria = b.getAttribute("aria-label") || "";
        if (/send|发送/i.test(aria) && !b.disabled) {
          b.click();
          await new Promise((r) => setTimeout(r, 500));
          if (inputIsEmpty(findInput())) return true;
          break;
        }
      }
      const el = findInput();
      if (el) {
        el.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true })
        );
      }
      await new Promise((r) => setTimeout(r, 500));
      if (inputIsEmpty(findInput())) return true;
    }
    warn("自动发送未确认成功，内容仍保留在输入框中，可手动按回车发送");
    return false;
  }

  // ---------- 右键菜单投递：把内容填进输入框 ----------
  // send 为 false 时只填入不发送（用户接着输入自己的问题后手动发送）；
  // item.send === true 时填入后自动发送（保留给程序化触发场景）

  let lastPendingAt = 0;
  async function handlePendingPrompt(item) {
    if (!item || !item.text || item.at === lastPendingAt) return;
    lastPendingAt = item.at;
    // 先清掉，避免重载页面后重复触发
    chrome.storage.local.remove("dsPendingPrompt");
    const filled = await fillInput(item.text);
    if (!filled) {
      warn("待填内容写入失败：未找到 DeepSeek 输入框");
      return;
    }
    log("待填内容已写入输入框");
    if (item.send) await autoSend();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.dsPendingPrompt && changes.dsPendingPrompt.newValue) {
      handlePendingPrompt(changes.dsPendingPrompt.newValue);
    }
  });

  // ---------- 监听页面变化 ----------

  const observer = new MutationObserver(() => scanCodeBlocks());
  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(scanCodeBlocks, 1000);
    // 侧边栏/小窗刚被打开时，投递可能先于本脚本就绪：补查 60 秒内的待填内容
    chrome.storage.local.get("dsPendingPrompt", (d) => {
      const item = d && d.dsPendingPrompt;
      if (item && Date.now() - item.at < 60000) handlePendingPrompt(item);
    });
    log("页面桥已就绪", location.href);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
