// ============================================================
// DeepSeek Sider - AI 页面桥
// 注入到各 AI 网页版（真实标签页、侧边栏 iframe、停靠小窗；
// 侧边栏 iframe 中 content script 可运行，但只能用 storage 通信，
// 无法被 tabs.sendMessage 直达）。
// 职责：
//   1. 监听 storage 的 aiPendingPrompt（右键「AI 一下」投递），
//      把内容填进当前 AI 站点的输入框供用户补充提问
//   2. （保留）DeepSeek 页面桥的 browser 指令协议：解析回复中的
//      协议代码块 → background 执行 → 结果回填输入框
// 协议格式（AI 需按此输出）：
//   ```browser
//   {"tool":"browser","action":"open","url":"https://example.com"}
//   ```
// 诊断：在 AI 页面按 F12 打开控制台，筛选 "[AI Bridge]"
// 可看到投递 / 捕获指令 / 执行结果 / 回填状态等运行日志。
// ============================================================

(() => {
  if (window.__dsAgentBridge) return;
  window.__dsAgentBridge = true;

  const log = (...args) => console.info("[AI Bridge]", ...args);
  const warn = (...args) => console.warn("[AI Bridge]", ...args);

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

  // ---------- 各站点输入框适配 ----------
  // input : 返回主输入框元素（轮询重试由 fillInput 统一处理）
  // send  : 触发发送（可选；缺省时退化为模拟 Enter 键）
  const ADAPTERS = {
    deepseek: {
      input: () =>
        document.querySelector("textarea#chat-input") ||
        document.querySelector("textarea") ||
        document.querySelector('[contenteditable="true"]'),
      send: () => clickSendButton(/send|发送/i),
    },
    chatgpt: {
      input: () => document.getElementById("prompt-textarea"),
      send: () => clickSendButton(/send/i),
    },
    claude: {
      input: () =>
        document.querySelector('div[contenteditable="true"].ProseMirror') ||
        document.querySelector('div[contenteditable="true"]'),
      send: () => clickSendButton(/send message|发送/i),
    },
    gemini: {
      input: () =>
        document.querySelector("rich-textarea div.ql-editor[contenteditable='true']") ||
        document.querySelector("div.ql-editor[contenteditable='true']"),
      send: () => clickSendButton(/send|发送/i),
    },
    grok: {
      input: () => document.querySelector("textarea"),
      send: () => clickSendButton(/submit|send/i),
    },
    doubao: {
      input: () =>
        document.querySelector('[data-testid="chat_input_input"]') ||
        document.querySelector("textarea[data-testid='receive_message_input_textarea']") ||
        document.querySelector("textarea") ||
        document.querySelector('[contenteditable="true"]'),
      send: () => clickSendButton(/send|发送/i),
    },
    kimi: {
      input: () =>
        document.querySelector("textarea") ||
        document.querySelector('[contenteditable="true"].editor-input') ||
        document.querySelector('[contenteditable="true"]'),
      send: () => clickSendButton(/send|发送/i),
    },
    zhipu: {
      input: () =>
        document.querySelector("textarea") ||
        document.querySelector('[contenteditable="true"]'),
      send: () => clickSendButton(/发送|send/i),
    },
    qwen: {
      input: () =>
        document.querySelector("textarea") ||
        document.querySelector('div[contenteditable="true"]'),
      send: () => clickSendButton(/send|发送/i),
    },
    perplexity: {
      input: () =>
        document.querySelector('div[contenteditable="true"].ProseMirror') ||
        document.querySelector('textarea[enterkeyhint]') ||
        document.querySelector('div[contenteditable="true"]') ||
        document.querySelector("textarea"),
      send: () => clickSendButton(/submit|send|arrow/i),
    },
    mistral: {
      input: () =>
        document.querySelector('div[contenteditable="true"].ProseMirror') ||
        document.querySelector("textarea") ||
        document.querySelector('[contenteditable="true"]'),
      send: () => clickSendButton(/send/i),
    },
    copilot: {
      input: () =>
        document.querySelector("textarea") ||
        document.querySelector('[contenteditable="true"]'),
      send: () => clickSendButton(/submit|send/i),
    },
    poe: {
      input: () =>
        document.querySelector("textarea GrowingTextArea_textArea__ZWQbP") ||
        document.querySelector("textarea"),
      send: () => clickSendButton(/send/i),
    },
    groq: {
      input: () => document.querySelector("textarea"),
      send: () => clickSendButton(/send/i),
    },
    huggingchat: {
      input: () =>
        document.querySelector('textarea[placeholder]') ||
        document.querySelector("textarea"),
      send: () => clickSendButton(/send|submit/i),
    },
    pi: {
      input: () =>
        document.querySelector("textarea") ||
        document.querySelector('[contenteditable="true"]'),
      send: () => clickSendButton(/send/i),
    },
    youcom: {
      input: () =>
        document.querySelector("textarea") ||
        document.querySelector('[contenteditable="true"]'),
      send: () => clickSendButton(/send|submit/i),
    },
    yuanbao: {
      input: () =>
        document.querySelector('.agent-chat__input textarea') ||
        document.querySelector("textarea") ||
        document.querySelector('[contenteditable="true"]'),
      send: () => clickSendButton(/send|发送/i),
    },
  };

  // host 关键字 → 适配键（通义新域名 qianwen.com 仍复用 qwen 适配）
  const HOST_CHAT = {
    deepseek: "deepseek",
    chatgpt: "chatgpt",
    claude: "claude",
    gemini: "gemini",
    grok: "grok",
    doubao: "doubao",
    kimi: "kimi",
    chatglm: "zhipu",
    zhipu: "zhipu",
    bigmodel: "zhipu",
    qianwen: "qwen",
    tongyi: "qwen",
    yuanbao: "yuanbao",
    perplexity: "perplexity",
    mistral: "mistral",
    copilot: "copilot",
    poe: "poe",
    groq: "groq",
    huggingface: "huggingchat",
    pi: "pi",
    you: "youcom",
  };

  function adapter() {
    // 按 host 前缀匹配当前站点（sidepanel iframe / 停靠小窗 / 真实标签页通用）
    const host = location.hostname;
    const chatKey = Object.keys(HOST_CHAT).find((k) => host.includes(k));
    const ad = (chatKey && ADAPTERS[HOST_CHAT[chatKey]]) || null;
    if (ad) return ad;
    // 兜底：通用 textarea / contenteditable
    return {
      input: () => document.querySelector("textarea") || document.querySelector('[contenteditable="true"]'),
      send: () => clickSendButton(/send|发送|submit/i),
    };
  }

  // 设置（保留 storage 通道；结果回填默认不自动发送）
  const settings = { enabled: true, autoSend: false };
  chrome.storage.local.get("dsBridgeSettings", (d) => {
    if (d && d.dsBridgeSettings) Object.assign(settings, d.dsBridgeSettings);
  });

  // 心跳：供侧边栏面板/后台检测页面桥是否存活（未注入时后台走停靠小窗兜底）
  // 按站点 host 分键（dsBridgeBeat.<host>），多 iframe 并存时互不覆盖，
  // 侧边栏据此在对比面板头上点亮存活点
  setInterval(() => {
    const beat = {};
    beat["dsBridgeBeat." + location.hostname] = Date.now();
    chrome.storage.local.set(beat);
  }, 3000);

  // 存活探测：background 检查小窗里的桥是否还活着（失效则重载页面重新注入）
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "DS_PING") sendResponse({ ok: true, bridge: "deepseek" });
    // 不返回 true：无需保持通道，同步应答即可
  });

  let lastHandled = ""; // 已处理代码块的指纹，防止重复执行
  let running = false;

  // ---------- 容错 JSON 解析 ----------
  // AI 渲染的代码块可能混入语言标签（"browser"）、围栏残留等
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
  // 协议执行目前仍只在 DeepSeek 页生效（其官方回复较稳定遵循协议）；
  // 其它站点默认只做「投递填入」，扫描行为可通过 settings.enabled 关闭。
  const PROTOCOL_HOSTS = /(^|\.)chat\.deepseek\.com$/i;

  function scanCodeBlocks() {
    if (!settings.enabled || running || !PROTOCOL_HOSTS.test(location.hostname)) return;
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
    if (!filled) warn("回填失败：未找到输入框");
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

  // ---------- 回填当前 AI 站点输入框 ----------

  async function fillInput(text) {
    // SPA 输入框可能好几秒后才渲染，放宽到 ~12s
    const ad = adapter();
    for (let i = 0; i < 40; i++) {
      const el = ad.input();
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

  // 在可见按钮中按 aria-label 匹配发送键并点击
  function clickSendButton(pattern) {
    const btns = document.querySelectorAll('div[role="button"], button');
    for (const b of btns) {
      const aria = b.getAttribute("aria-label") || "";
      if (pattern.test(aria) && !b.disabled) {
        b.click();
        return true;
      }
    }
    return false;
  }

  // 发送后校验输入框是否被清空；没清空说明没发出去，重试
  async function autoSend() {
    const ad = adapter();
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 300));
      ad.send();
      await new Promise((r) => setTimeout(r, 500));
      if (inputIsEmpty(ad.input())) return true;
      // 发送键没匹配上：退化为模拟 Enter
      const el = ad.input();
      if (el) {
        el.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true })
        );
      }
      await new Promise((r) => setTimeout(r, 500));
      if (inputIsEmpty(ad.input())) return true;
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
    chrome.storage.local.remove("aiPendingPrompt");
    const filled = await fillInput(item.text);
    if (!filled) {
      warn("待填内容写入失败：未找到输入框");
      return;
    }
    log("待填内容已写入输入框");
    if (item.send) await autoSend();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.aiPendingPrompt && changes.aiPendingPrompt.newValue) {
      handlePendingPrompt(changes.aiPendingPrompt.newValue);
    }
  });

  // ---------- 监听页面变化 ----------

  const observer = new MutationObserver(() => scanCodeBlocks());
  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(scanCodeBlocks, 1000);
    // 侧边栏/小窗刚被打开时，投递可能先于本脚本就绪：补查 60 秒内的待填内容
    chrome.storage.local.get("aiPendingPrompt", (d) => {
      const item = d && d.aiPendingPrompt;
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
