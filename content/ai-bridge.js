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

  // ---------- Grok 实时连接（WebSocket）补丁 ----------
  // Grok 页面脚本会建 WebSocket 做实时流；在 iframe（第三方上下文）里首次握手
  // 可能因 Cookie 分区/风控暂时失败，页面自己不重试，直接挂上
  // 「你的网络或安全软件阻止了 Grok 的实时连接」横幅，且之后不再恢复。
  // 做法（须在页面主世界执行才能拦截页面的 new WebSocket）：
  //   1. 包一层 WebSocket：失败自动退避重连，连上后页面逻辑自行恢复
  //   2. 连不上时隐藏报错横幅，避免误导（并不影响文字聊天）
  function patchGrokSocket() {
    // content script 默认跑在隔离世界，看不到页面的 window.WebSocket 调用点；
    // 用 <script> 注入主世界（rules.json 已剥掉 grok 的 CSP，允许内联脚本）
    const code = `(${function main() {
      const WS = window.WebSocket;
      const BANNER_TEXT = /实时连接|realtime|WebSocket/i;
      let retry = 0;
      const RETRIES = [500, 2000, 5000, 10000, 15000]; // 退避序列，ms

      window.WebSocket = function PatchedWS(url, protocols) {
        const isGrok = String(url).toLowerCase().startsWith("ws");
        let ws;
        function open() {
          ws = protocols === undefined ? new WS(url) : new WS(url, protocols);
          const origClose = ws.close.bind(ws);
          ws.addEventListener("close", (e) => {
            // 非用户主动关闭且没连上过 → 退避重连
            if (isGrok && retry < RETRIES.length && e.code !== 1000) {
              const delay = RETRIES[retry++];
              setTimeout(open, delay);
            }
          });
          ws.addEventListener("open", () => { retry = 0; });
          return ws;
        }
        ws = open();
        // 代理属性（页面会挂 onmessage/onclose 等），透传到当前底层连接
        return new Proxy(ws, {
          get(t, p) {
            if (p === "reopen") return open;
            const v = Reflect.get(t, p);
            return typeof v === "function" ? v.bind(t) : v;
          },
          set(t, p, v) { Reflect.set(t, p, v); return true; },
        });
      };
      window.WebSocket.prototype = WS.prototype;
      // 静态属性（CONNECTING/OPEN/CLOSING/CLOSED 常量被页面引用）
      Object.entries(WS).forEach(([k, v]) => { window.WebSocket[k] = v; });

      // 重试都失败后，页面挂出的报错横幅直接隐藏（文字聊天不受影响）
      setInterval(() => {
        document.querySelectorAll("div,span,p").forEach((el) => {
          if (el.children.length === 0 && el.childElementCount === 0 &&
              el.textContent.length < 200 && BANNER_TEXT.test(el.textContent) &&
              /网络或安全软件|network or security/i.test(el.textContent)) {
            const bar = el.closest('[role="alert"],div') || el;
            bar.style.display = "none";
          }
        });
      }, 3000);
    }})()`;
    const s = document.createElement("script");
    s.textContent = code;
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  // ============================================================
  // 知识库采集（PRD v2 静默保存管线）
  // 入口 A：hover AI 回复 → 「存入知识库」；入口 B：选区浮条；Alt+S（经
  // background commands 转发）。全部走同一条管线：解析 DOM → 结构
  // 化 blocks（含图片 dataURL）→ chrome.runtime.sendMessage →
  // background 写 IndexedDB（扩展 origin，绕开站点配额/溯源问题）。
  // 保存确认后在页面内弹 toast，附 [整理] [撤销]。
  // ============================================================

  // ============================================================
  // 站点适配器注册表（每站点一段声明式配置，集中维护）
  // 字段：
  //   match   — host 匹配正则
  //   reply   — 该站点「一条 AI 回复」的精准选择器（优先于通用启发式）
  //   user    — 用户提示词气泡选择器（保存时整块跳过）
  //   think   — 深度思考/推理面板选择器（保存时整块跳过）
  //   panels  — 回复容器之外但属于本条消息的面板（搜索过程/参考卡片栏）：
  //             collectRefsAround 会从这些面板抓外链进「参考资料」，
  //             但其文本不进正文。null = 用通用向上扫描
  // 站点改版 → 只改这里对应站点的选择器；新站点 → 加一段 + 通用兜底仍生效
  // ============================================================
  const KB_SITE_ADAPTERS = {
    deepseek: {
      match: /chat\.deepseek\.com/i,
      reply: ".ds-markdown",
      user: '[class*="user-message"], .fbb7 > .fbb7:first-child',
      think: '[class*="think"], [class*="cof"], _think',
      panels: null,
    },
    qianwen: {
      match: /(chat\.qwen\.ai|tongyi\.aliyun|qianwen\.com)/i,
      reply: '[data-message-author-role="assistant"] .markdown-body, .markdown-body',
      user: '[data-message-author-role="user"], [class*="user-message"], [class*="check-title"]',
      think: null,
      // 搜索过程面板（已完成分析/搜索N个关键词/参考标题墙/查看全部）
      panels: '[class*="search-panel"], [class*="search_result"], [class*="search-collapse"]',
    },
    chatgpt: {
      match: /chat\.openai\.com|chatgpt\.com/i,
      reply: '[data-message-author-role="assistant"]',
      user: '[data-message-author-role="user"]',
      think: null,
      panels: null,
    },
    claude: {
      match: /claude\.ai/i,
      reply: '.font-claude-message, [data-testid="assistant-message"]',
      user: ".font-user-message",
      think: null,
      panels: null,
    },
    grok: {
      match: /grok\.com/i,
      reply: '.message-bubble, [class*="response"]',
      user: '[class*="user"]',
      think: null,
      panels: null,
    },
    doubao: {
      match: /doubao\.com/i,
      reply: '[data-testid="receive_message"], [class*="message__content"]',
      user: '[data-testid="send_message"]',
      think: null,
      panels: null,
    },
    kimi: {
      match: /(kimi\.com|moonshot)/i,
      reply: '.segment-container, [class*="markdown"]',
      user: '[class*="user-content"]',
      think: null,
      panels: null,
    },
    yuanbao: {
      match: /(yuanbao|hunyuan)/i,
      reply: '.agent-chat__conversation__item',
      user: '[class*="agent-chat__item--human"]',
      think: null,
      panels: null,
    },
    chatglm: {
      match: /chatglm\.cn/i,
      reply: '[class*="answer-content"], .markdown-body',
      user: '[class*="user-content"]',
      think: null,
      panels: null,
    },
    gemini: {
      match: /gemini\.google\.com/i,
      reply: '[class*="markdown"], model-response',
      user: 'user-query, [class*="query-content"]',
      think: 'thought-panel, [class*="thought"]',
      panels: null,
    },
    perplexity: {
      match: /perplexity\.ai/i,
      reply: ".markdown",
      user: null,
      think: null,
      panels: null,
    },
    mistral: {
      match: /(mistral\.ai)/i,
      reply: '[class*="message-content"], [class*="markdown"]',
      user: '[class*="user-message"], [class*="user-content"]',
      think: null,
      panels: null,
    },
    copilot: {
      match: /copilot\.microsoft\.com/i,
      reply: '[class*="ac-container"], [class*="markdown"]',
      user: '[data-content="user"], [class*="user-message"]',
      think: null,
      classes: "copilot",
    },
    poe: {
      match: /(^|\.)poe\.com/i,
      reply: '[class*="markdown"], [class*="BotMessage"]',
      user: '[class*="HumanMessage"]',
      think: null,
      panels: null,
    },
    groq: {
      match: /chat\.groq\.com/i,
      reply: '[class*="markdown"], [class*="message"]',
      user: '[class*="user-message"]',
      think: null,
      panels: null,
    },
    huggingchat: {
      match: /huggingface\.co/i,
      reply: '[class*="message"], .markdown-body, [class*="prose"]',
      user: '[class*="user-message"]',
      think: null,
    },
    pi: {
      match: /(^|\.)pi\.ai/i,
      reply: '[class*="response"], [class*="message"]',
      user: null,
      think: null,
    },
    youcom: {
      match: /(^|\.)you\.com/i,
      reply: '[class*="markdown"], [class*="result"]',
      user: null,
      think: null,
    },
  };

  // 通用回复容器选择器（无适配器站点 / 适配器失效时的兜底链）
  const KB_REPLY_SELECTORS = [
    '[data-message-author-role="assistant"]',
    ".markdown-body",
    '[class*="message-content"]',
    '[class*="msg-content"]',
    '[class*="message-item"]',
    '[class*="answer-content"]',
    '[class*="response-content"]',
    '[class*="chat-content-item"]',
    '[class*="chat-message"]',
    '[class*="agent-chat__conv"]',
    '[class*="markdown"]',
    '[class*="prose"]',
  ];

  function sourceModelName() {
    const host = location.hostname;
    const names = {
      deepseek: "DeepSeek", chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini",
      grok: "Grok", doubao: "豆包", kimi: "Kimi", chatglm: "智谱清言",
      qianwen: "通义千问", yuanbao: "腾讯元宝", perplexity: "Perplexity",
      mistral: "Le Chat", copilot: "Copilot", poe: "Poe", groq: "Groq",
      huggingface: "HuggingChat", pi: "Pi", you: "You.com",
    };
    const key = Object.keys(names).find((k) => host.includes(k));
    return key ? names[key] : host;
  }

  // 深度思考/推理容器：不是最终回复，保存时跳过（推理内容混进正文的问题源）
  const KB_THINK_SELECTORS = [
    '[class*="think"]', // deepseek 深度思考、通用 thinking 容器
    '[class*="reasoning"]', // 通用推理面板
    '[class*="thought"]',
    '[class*="cof"]', // deepseek 旧版思考容器
  ];

  // 当前站点的适配器（按 host 正则匹配 KB_SITE_ADAPTERS）
  function kbSiteAdapter() {
    const host = location.hostname;
    return Object.values(KB_SITE_ADAPTERS).find((a) => a.match.test(host)) || null;
  }

  // 思考面板选择器：适配器声明优先，无声明用通用兜底
  function thinkSelectors() {
    const a = kbSiteAdapter();
    return (a && a.think ? a.think.split(",").map((s) => s.trim()) : []).concat(KB_THINK_SELECTORS);
  }

  // ---- 回复容器定位：适配器精准选择器优先 → 通用链兜底 + 思考面板排除 ----
  function findReplyContainer(node) {
    const adapter = kbSiteAdapter();
    const thinkSels = thinkSelectors();
    const inThink = (n) => {
      try { return thinkSels.some((sel) => n.closest(sel)); } catch (_e) { return false; }
    };
    const selectors = [
      ...(adapter && adapter.reply ? adapter.reply.split(",").map((s) => s.trim()) : []),
      ...KB_REPLY_SELECTORS,
    ];
    let el = node;
    while (el && el !== document.body) {
      for (const sel of selectors) {
        let m = null;
        try {
          m = el.matches(sel) ? el : el.querySelector(sel);
        } catch (_e) { /* 非法选择器忽略 */ }
        // 命中思考容器/在思考容器内 → 不是最终回复，跳过继续找
        if (m && m.textContent && m.textContent.trim().length > 20 && !inThink(m)) return m;
      }
      el = el.parentElement;
    }
    return null;
  }

  // ---- DOM → 结构化 blocks（保序：p / code / img / heading） ----
  // 用户提示词气泡（不存进知识库）
  const KB_USER_SELECTORS = [
    '[data-message-author-role="user"]', // chatgpt/千问
    ".font-user-message", // claude
    '[class*="user-message"]',
    '[class*="user-msg"]',
    '[class*="question-message"]',
    '[data-testid="send_message"]', // 豆包
  ];
  // 用户气泡选择器：适配器声明优先，无声明用通用兜底
  function userSelectors() {
    const a = kbSiteAdapter();
    return (a && a.user ? a.user.split(",").map((s) => s.trim()) : []).concat(KB_USER_SELECTORS);
  }
  function kbParseBlocks(root) {
    const blocks = [];
    const imgUrls = [];
    const refs = []; // 参考资料链接（单独存放，不进正文）
    // 公式还原：KaTeX 渲染后的 textContent 会把 LaTeX 打散（QK^T→QKT、\frac 丢失），
    // 从隐藏的 MathML annotation 里取回原始源码，替换为 $...$ / $$...$$ 文本
    const kbElText = (el) => {
      const clone0 = el.cloneNode(true);
      // 图表 SVG（内嵌 <style> 会让 textContent 变成 CSS 乱码）：从文本里剔除
      // （独立大 SVG 已在 walk 中序列化为图片；此处只防段落内混排）
      clone0.querySelectorAll("svg").forEach((sv) => {
        const vb = sv.viewBox && sv.viewBox.baseVal;
        if ((vb && (vb.width > 0 || vb.height > 0)) || sv.getBoundingClientRect().width > 200) sv.remove();
      });
      el = clone0;
      const kts = el.querySelectorAll(".katex");
      if (!kts.length) return el.textContent;
      const clone = el.cloneNode(true);
      clone.querySelectorAll(".katex").forEach((kt) => {
        const ann = kt.querySelector('annotation[encoding="application/x-tex"]');
        const tex = (ann ? ann.textContent : kt.textContent || "").trim();
        if (!tex) return;
        const span = document.createElement("span");
        span.textContent = kt.closest(".katex-display") ? "$$" + tex + "$$" : "$" + tex + "$";
        kt.replaceWith(span);
      });
      return clone.textContent;
    };
    // 图标判定：favicon / logo / 小尺寸渲染图 / 参考卡片里的站点图标
    const isIconImg = (im) => {
      if (/favicon|logo|icon/i.test((im.className || "") + " " + (im.src || ""))) return true;
      if (im.complete && im.naturalWidth > 0 && im.naturalWidth <= 64) return true;
      const r = im.getBoundingClientRect();
      if (r.width > 0 && r.width <= 48 && r.height <= 48) return true; // 未解码也按渲染尺寸判
      // 参考资料簇里的站点图标：锚点父级聚集多条链接
      const a = im.closest("a");
      if (a && a.href && /^https?:/.test(a.href)) {
        const siblings = a.parentElement ? a.parentElement.querySelectorAll("a[href]").length : 0;
        if (siblings >= 2) return true;
      }
      return false;
    };
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) {
          // 顶层裸文本（少见）
          if (child.nodeType === 3 && child.textContent.trim() && node !== root) return;
          continue;
        }
        // 深度思考/推理面板：整块跳过。
        // 注意不能只凭 child.querySelector 命中就丢——豆包等站点回复正文里嵌着
        // 「深度思考」折叠条（class 含 think），会把整条回复误判成思考面板。
        // 规则：子块自身命中 → 跳过；仅在根层且命中节点占该块 ≥90% 文本时才整块跳过，
        // 否则递归进入，由逐层 matches 精确剔除思考/用户子树。
        const mostlyMatches = (sels) => {
          try {
            for (const sel of sels) {
              if (child.matches(sel)) return true;
              if (node === root) {
                const m = child.querySelector(sel);
                if (m) {
                  const tLen = (child.textContent || "").trim().length;
                  if (tLen === 0 || (m.textContent || "").trim().length >= tLen * 0.9) return true;
                }
              }
            }
          } catch (_e) { /* 非法选择器忽略 */ }
          return false;
        };
        if (mostlyMatches(thinkSelectors())) continue;
        // 用户提示词气泡：整块跳过（同上，按占比防误杀）
        if (mostlyMatches(userSelectors())) continue;
        const tag = child.tagName;
        if (tag === "PRE") {
          const code = child.querySelector("code") || child;
          const langM = (code.className || "").match(/language-([\w-]+)/);
          blocks.push({ t: "code", lang: langM ? langM[1] : "", text: code.textContent || "" });
        } else if (tag === "CODE" && child.closest("pre")) {
          continue; // 随 PRE 一起处理
        } else if (tag === "A") {
          // 独立引用链接：收进参考资料区，不进正文
          const href = child.href || "";
          const text = child.textContent.trim();
          if (/^https?:\/\//.test(href) && text.length >= 4) {
            refs.push({ title: text.slice(0, 80), url: href });
            continue;
          }
          walk(child);
        } else if (tag === "IMG") {
          // favicon / 站点 logo / 参考卡片图标不是正文图片
          if (isIconImg(child)) continue;
          const url = child.currentSrc || child.src;
          if (url && !url.startsWith("data:")) imgUrls.push(url);
          blocks.push({ t: "img", url });
        } else if (/^H[1-6]$/.test(tag)) {
          const text = kbElText(child).trim();
          if (text) blocks.push({ t: "p", text });
        } else if (tag === "UL" || tag === "OL") {
          const lines = [...child.querySelectorAll("li")].map((li, i) =>
            (tag === "OL" ? i + 1 + ". " : "• ") + kbElText(li).trim()
          );
          if (lines.length) blocks.push({ t: "p", text: lines.join("\n") });
        } else if (tag === "P" || tag === "BLOCKQUOTE") {
          const imgs = [...child.querySelectorAll("img")].filter((im) => !isIconImg(im));
          const text = kbElText(child).trim();
          imgs.forEach((im) => {
            const u = im.currentSrc || im.src;
            if (u && !u.startsWith("data:")) imgUrls.push(u);
            // 段落里的图（含文+图混排）也生成 img block，否则图片抓了也无处显示
            blocks.push({ t: "img", url: u });
          });
          if (text) blocks.push({ t: "p", text });
        } else if (tag === "TABLE") {
          const rows = [...child.querySelectorAll("tr")].slice(0, 40).map((tr) =>
            [...tr.querySelectorAll("th,td")].map((td) => kbElText(td).trim()).join(" | ")
          );
          if (rows.length) blocks.push({ t: "code", lang: "table", text: rows.join("\n") });
        } else if (tag === "BUTTON" || tag === "SCRIPT" || tag === "STYLE") {
          continue;
        } else if (tag === "svg") {
          // Mermaid/图表 SVG（豆包等把流程图渲染成内联 SVG，textContent 是整段 CSS 乱码）
          // → 序列化为 data URL 当图片抓取，保留图形；小 svg（图标）忽略
          // 注意：svg.viewBox 属性对象恒存在，必须看 baseVal 是否有值
          const vb = child.viewBox && child.viewBox.baseVal;
          const r = child.getBoundingClientRect();
          if ((vb && (vb.width > 0 || vb.height > 0)) || r.width > 200 || r.height > 200) {
            try {
              const svgStr = new XMLSerializer().serializeToString(child);
              const dataUrl = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgStr)));
              imgUrls.push(dataUrl);
              blocks.push({ t: "img", url: dataUrl });
            } catch (_e) { /* 序列化失败忽略 */ }
          }
        } else if (child.querySelector("p,pre,img,ul,ol,table,h1,h2,h3,h4,h5,h6")) {
          walk(child);
        } else {
          const text = kbElText(child).trim();
          if (text) blocks.push({ t: "p", text });
        }
      }
    };
    walk(root);
    // 相邻 p 合并（很多站点把每行拆成独立 <p>）
    const merged = [];
    for (const b of blocks) {
      const prev = merged[merged.length - 1];
      if (b.t === "p" && prev && prev.t === "p" && prev.text.length + b.text.length < 4000) prev.text += "\n" + b.text;
      else merged.push(b);
    }
    // 图片 block 对齐 url（按出现顺序）
    let ui = 0;
    merged.forEach((b) => {
      if (b.t === "img") b.url = b.url || imgUrls[ui++] || "";
    });
    const plainText = merged.filter((b) => b.t !== "img").map((b) => b.text).join("\n\n");
    // 引用链接去重（同 URL 只留一条）
    const seen = new Set();
    const dedupRefs = refs.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
    return { blocks: merged, plainText, imgUrls, refs: dedupRefs };
  }

  // 参考资料收集：回复 markdown 容器之外的引用面板（「已参考 N 篇资料」、
  // 搜索来源卡片等）通常挂在同一条会话消息的父容器里——向上找一级，
  // 把那里的外链一并收进 refs（正文容器内的已由 kbParseBlocks 收过）
  // 从回复容器向上找「本条消息」的根（父级包含另一条回复即停）
  function kbMessageRoot(container) {
    let root = container;
    for (let i = 0; i < 4 && root.parentElement; i++) {
      const parent = root.parentElement;
      try {
        const others = KB_REPLY_SELECTORS.some((sel) => {
          const first = sel.split(",")[0].trim();
          return [...parent.querySelectorAll(first)].some((m) => !root.contains(m) && m !== root);
        });
        if (others) break;
      } catch (_e) { /* ignore */ }
      root = parent;
    }
    return root;
  }

  function collectRefsAround(container) {
    const adapter = kbSiteAdapter();
    const refs = [];
    const seen = new Set();
    const addFrom = (el) => {
      if (!el || el === container || container.contains(el)) return;
      el.querySelectorAll("a[href]").forEach((a) => {
        const href = a.href || "";
        if (!/^https?:\/\//.test(href) || seen.has(href)) return;
        // 正文容器内的链接不算（kbParseBlocks 已处理）
        if (container.contains(a)) return;
        // 纯图标链接（无文字）跳过；操作类链接（查看全部/展开）跳过
        const text = (a.textContent || "").trim();
        if (text.length < 4) return;
        if (/^(查看全部|展开|收起|更多|查看来源|举报|反馈|复制|重试|停止|分享)$/.test(text)) return;
        seen.add(href);
        refs.push({ title: text.slice(0, 80), url: href });
      });
    };
    // 适配器声明了参考面板（如千问搜索面板）→ 只扫声明的面板，精准且不误捞
    if (adapter && adapter.panels) {
      const msgRoot = kbMessageRoot(container);
      msgRoot.querySelectorAll(adapter.panels).forEach((panel) => {
        if (container.contains(panel)) return; // 正文容器内的链接已由 kbParseBlocks 收过
        addFrom(panel);
      });
      // 正文容器内的链接也已在 kbParseBlocks 中收集，这里补收容器上方遗漏
      return refs.slice(0, 20);
    }
    // 一层：会话消息父容器（限 3 级内，避免捞到整页导航链接）
    let p = container.parentElement;
    for (let i = 0; p && i < 3; i++) {
      // 父容器若包含多条消息（整页对话流），只扫不包含其他回复容器的兄弟子树
      [...p.children].forEach((sib) => {
        if (sib === container) return;
        if (sib.contains(container)) return;
        // 兄弟里还有别的 AI 回复容器 → 说明 p 已是消息列表层，停止扩散
        const otherReplies = KB_REPLY_SELECTORS.some((sel) => {
          try { return [...sib.querySelectorAll(sel.split(",")[0].trim())].length > 0; } catch (_e) { return false; }
        });
        if (otherReplies) return;
        addFrom(sib);
      });
      // 若 p 含其他回复消息则不再上溯
      const replyCount = KB_REPLY_SELECTORS.filter((sel) => {
        try { return p.querySelector(sel.split(",")[0].trim()); } catch (_e) { return false; }
      }).length;
      if (replyCount > 1) break;
      p = p.parentElement;
    }
    return refs.slice(0, 20);
  }

  // ---- 图片抓取 + 压缩（content script 内 fetch，host 权限覆盖） ----
  async function kbCaptureImage(url) {
    try {
      let blob = null;
      // 1. 页面内直接抓（data:/blob:/同源图片可行；跨域受页面 CORS 限制）
      try {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        blob = await resp.blob();
        if (!/^image\//.test(blob.type)) throw new Error("非图片");
      } catch (_e) {
        // 2. 兜底：background SW 抓（host_permissions <all_urls>，不受页面 CORS 限制）
        const res = await chrome.runtime.sendMessage({ type: "DS_KB_FETCH_IMG", url });
        if (!res || !res.ok) throw new Error((res && res.error) || "SW 抓图失败");
        blob = await (await fetch(res.dataUrl)).blob();
      }
      const isGif = blob.type === "image/gif";
      if (blob.size > 10 * 1024 * 1024) throw new Error("超过 10MB");
      if (!isGif && blob.type !== "image/svg+xml") {
        blob = await kbCompress(blob, 1920, 0.8);
      }
      const thumb = await kbCompress(blob, 300, 0.7).catch(() => null);
      const dataUrl = await blobToDataUrl(blob);
      return { dataUrl, mime: blob.type, thumb: thumb ? await blobToDataUrl(thumb) : dataUrl };
    } catch (e) {
      warn("图片保存失败，降级为占位：", url.slice(0, 80), e.message);
      return null;
    }
  }
  function kbCompress(blob, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const u = URL.createObjectURL(blob);
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(img.width * scale));
          c.height = Math.max(1, Math.round(img.height * scale));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          c.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("toBlob 失败"))),
            blob.type === "image/png" && scale === 1 ? "image/png" : "image/jpeg",
            quality
          );
        } catch (e) {
          reject(e);
        } finally {
          URL.revokeObjectURL(u);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(u);
        reject(new Error("图片解码失败"));
      };
      img.src = u;
    });
  }
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  // ---- 静默保存：组装 → 发 background → 页面内 toast（整理/撤销） ----
  let kbSaving = false;
  async function kbSavePipeline({ blocks, plainText, imgUrls, refs, sourceUrl }) {
    if (kbSaving) return;
    kbSaving = true;
    try {
      if (!plainText.trim() && !imgUrls.length) {
        kbPageToast("没有可保存的内容");
        return;
      }
      // 标题：首个非空 block 首行，截 40 字
      const firstLine = plainText.split("\n").find((l) => l.trim()) || "";
      const title = (firstLine.trim().slice(0, 40) || (imgUrls.length ? "图片摘录" : "无标题")).trim();

      const media = [];
      let failedImgs = 0;
      const capList = imgUrls.slice(0, 6);
      for (const url of capList) {
        const r = await kbCaptureImage(url);
        if (r) media.push(r);
        else failedImgs++;
      }
      const finalBlocks = blocks.map((b) => ({ ...b }));
      // img block 引用已成功抓取的媒体序号
      let mi = 0;
      finalBlocks.forEach((b) => {
        if (b.t === "img") {
          if (media[mi]) {
            b.mi = mi;
            b.thumb = media[mi].thumb;
            mi++;
          }
          delete b.url; // 不把站点 URL 存进 blocks（签名 URL 会过期）
        }
      });

      const res = await chrome.runtime.sendMessage({
        type: "DS_KB_SAVE",
        payload: {
          title,
          blocks: finalBlocks,
          plainText,
          refs: (refs || []).slice(0, 20),
          media, // {dataUrl, mime, thumb}
          sourceModel: sourceModelName(),
          sourceUrl,
        },
      });
      if (res && res.ok) {
        if (res.duplicate) {
          kbPageToast("内容未变化，已跳过");
        } else {
          const suffix = failedImgs ? `（${failedImgs} 张图片未能保存）` : "";
          kbPageToast("已存入知识库 · 收件箱" + suffix, {
            id: res.id,
          });
        }
      } else {
        kbPageToast("保存失败：" + ((res && res.error) || "无响应"));
      }
    } finally {
      kbSaving = false;
    }
  }

  // ---- 页面内 toast（含 [整理] [撤销]） ----
  function kbPageToast(msg, saved) {
    document.getElementById("ds-kb-toast")?.remove();
    const box = document.createElement("div");
    box.id = "ds-kb-toast";
    box.style.cssText =
      "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
      "background:rgba(28,31,35,.94);color:#fff;font-size:13px;padding:9px 14px;border-radius:10px;" +
      "box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;align-items:center;gap:10px;" +
      "font-family:system-ui,sans-serif;animation:dsKbIn .2s ease";
    const t = document.createElement("span");
    t.textContent = msg;
    box.appendChild(t);
    const mkBtn = (label, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "border:none;background:rgba(255,255,255,.18);color:#fff;border-radius:6px;" +
        "padding:3px 10px;font-size:12px;cursor:pointer";
      b.onclick = fn;
      return b;
    };
    if (saved) {
      box.appendChild(
        mkBtn("整理", () =>
          chrome.runtime.sendMessage({ type: "DS_KB_OPEN", excerptId: saved.id }).catch(() => {})
        )
      );
      box.appendChild(
        mkBtn("撤销", () =>
          chrome.runtime
            .sendMessage({ type: "DS_KB_UNDO", id: saved.id })
            .then((r) => kbPageToast(r && r.ok ? "已撤销" : "撤销失败"))
            .catch(() => {})
        )
      );
    }
    const style = document.createElement("style");
    style.textContent = "@keyframes dsKbIn{from{opacity:0;transform:translateX(-50%) translateY(8px)}}";
    box.appendChild(style);
    document.documentElement.appendChild(box);
    setTimeout(() => {
      box.style.transition = "opacity .25s";
      box.style.opacity = "0";
      setTimeout(() => box.remove(), 260);
    }, 5000);
  }

  // ---- 入口 A：hover 回复浮现「存入知识库」 ----
  let kbBtn = null;
  let kbHoverTarget = null;
  function kbEnsureBtn() {
    if (kbBtn) return kbBtn;
    kbBtn = document.createElement("button");
    kbBtn.id = "ds-kb-save-btn";
    kbBtn.textContent = "存入知识库";
    kbBtn.title = "保存这条回复到知识库";
    kbBtn.style.cssText =
      "position:fixed;z-index:2147483646;display:none;align-items:center;gap:3px;" +
      "border:none;border-radius:14px;padding:4px 10px;font-size:12px;cursor:pointer;" +
      "background:rgba(28,31,35,.85);color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.2);" +
      "font-family:system-ui,sans-serif;transition:transform .15s";
    kbBtn.onmouseenter = () => (kbBtn.style.transform = "scale(1.08)");
    kbBtn.onmouseleave = () => (kbBtn.style.transform = "");
    kbBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = kbHoverTarget;
      hideKbBtn();
      if (!target) return;
      const parsed = kbParseBlocks(target);
      parsed.refs = collectRefsAround(target);
      kbSavePipeline({
        blocks: parsed.blocks,
        plainText: parsed.plainText,
        imgUrls: parsed.imgUrls,
        refs: parsed.refs,
        sourceUrl: location.href,
      });
    });
    document.documentElement.appendChild(kbBtn);
    return kbBtn;
  }
  function showKbBtn(container, x, y) {
    const b = kbEnsureBtn();
    kbHoverTarget = container;
    b.style.display = "flex";
    // 贴容器右上角；越界时收回视口内
    const r = container.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.right + scrollX - 60), innerWidth - 80);
    const top = Math.max(8, r.top + scrollY - 14);
    b.style.left = left + "px";
    b.style.top = Math.min(top, innerHeight + scrollY - 36) + "px";
    void x;
    void y;
  }
  function hideKbBtn() {
    kbHoverTarget = null;
    if (kbBtn) kbBtn.style.display = "none";
  }
  document.addEventListener("mouseover", (e) => {
    if (kbSavingHoverGuard()) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (kbBtn && (t === kbBtn || kbBtn.contains(t))) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.containsNode(t, true)) return; // 选区优先
    const container = findReplyContainer(t);
    if (container) showKbBtn(container, e.clientX, e.clientY);
    else hideKbBtn();
  });
  // 保存过程中按钮悬停不闪：hover 到按钮时不清 target
  function kbSavingHoverGuard() {
    return false;
  }
  document.addEventListener("scroll", hideKbBtn, { passive: true, capture: true });

  // ---- 入口 B：选区浮条 [存知识库][AI一下] ----
  let kbSelBar = null;
  document.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    if (kbSelBar && (kbSelBar.contains(e.target) || e.target === kbSelBar)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (!text || text.length < 2 || !sel.rangeCount) {
        hideSelBar();
        return;
      }
      // 限定正文选区（我们自己的 UI 除外）
      const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
      if (!anchor || anchor.id === "ds-kb-toast" || (kbSelBar && anchor && kbSelBar.contains(anchor))) {
        hideSelBar();
        return;
      }
      showSelBar(text);
    }, 10);
  });
  function showSelBar(text) {
    hideSelBar();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    kbSelBar = document.createElement("div");
    kbSelBar.id = "ds-kb-selbar";
    kbSelBar.style.cssText =
      "position:fixed;z-index:2147483647;display:flex;gap:2px;padding:3px;border-radius:10px;" +
      "background:rgba(28,31,35,.94);box-shadow:0 6px 20px rgba(0,0,0,.25);" +
      "font-family:system-ui,sans-serif;animation:dsKbIn .18s ease";
    const mk = (label, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "border:none;background:none;color:#fff;font-size:12px;padding:4px 10px;border-radius:7px;cursor:pointer;white-space:nowrap";
      b.onmouseenter = () => (b.style.background = "rgba(255,255,255,.15)");
      b.onmouseleave = () => (b.style.background = "none");
      b.onclick = (ev) => {
        ev.stopPropagation();
        hideSelBar();
        fn();
      };
      return b;
    };
    kbSelBar.appendChild(
      mk("存知识库", () => {
        const blocks = [{ t: "p", text }];
        kbSavePipeline({ blocks, plainText: text, imgUrls: [], sourceUrl: location.href });
      })
    );
    kbSelBar.appendChild(
      mk("AI 一下", () => {
        chrome.storage.local.set({
          aiPendingPrompt: { text: text + "\n", at: Date.now(), send: false },
        });
      })
    );
    document.documentElement.appendChild(kbSelBar);
    const left = Math.min(Math.max(8, r.left + r.width / 2 - 70), innerWidth - 150);
    kbSelBar.style.left = left + "px";
    kbSelBar.style.top = Math.max(8, r.top - 40) + "px";
  }
  function hideSelBar() {
    kbSelBar?.remove();
    kbSelBar = null;
  }
  document.addEventListener("mousedown", (e) => {
    if (kbSelBar && !kbSelBar.contains(e.target)) hideSelBar();
  });
  window.addEventListener("scroll", hideSelBar, { passive: true, capture: true });

  // ---- Alt+S（background commands 转发）: 有选区存选区，否则存 hover 的回复 ----
  function kbCaptureActive() {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    if (text.length >= 2) {
      kbSavePipeline({ blocks: [{ t: "p", text }], plainText: text, imgUrls: [], sourceUrl: location.href });
      return;
    }
    if (kbHoverTarget) {
      const parsed = kbParseBlocks(kbHoverTarget);
      parsed.refs = collectRefsAround(kbHoverTarget);
      kbSavePipeline({
        blocks: parsed.blocks,
        plainText: parsed.plainText,
        imgUrls: parsed.imgUrls,
        refs: parsed.refs,
        sourceUrl: location.href,
      });
      return;
    }
    kbPageToast("先悬停一条 AI 回复，或选中文字后按 Alt+S");
  }

  // ---- 入口 D：右键选中文字 → 存选区 ----
  // 纯文本直接存；选区覆盖富 DOM 时走 kbParseBlocks 保留代码块/列表/图片
  function kbCaptureSelection() {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    if (!sel || sel.isCollapsed || text.length < 2) {
      kbPageToast("先选中要保存的内容");
      return;
    }
    try {
      const range = sel.getRangeAt(0);
      let container = range.commonAncestorContainer;
      if (container.nodeType === 3) container = container.parentElement;
      // 选区整体落在同一个块级容器内 → 解析该容器（保留代码块/列表结构）
      // 跨块选区 → 按纯文本逐段存（更精确，不会把未选中内容带进来）
      const codeHost = container.closest && container.closest("pre");
      const blockish =
        (container.nodeType === 1 &&
          container.querySelector("p,pre,ul,ol,table,h1,h2,h3,h4,h5,h6,img")) ||
        codeHost;
      if (blockish) {
        const parsed = kbParseBlocks(container);
        // 容器内容远多于选区（如选了回复里一句话但容器是整条回复）→ 不采用
        if (
          parsed.plainText.trim() &&
          parsed.plainText.length <= text.length * 1.5 + 40
        ) {
          kbSavePipeline({
            blocks: parsed.blocks,
            plainText: parsed.plainText,
            imgUrls: parsed.imgUrls,
            refs: collectRefsAround(container),
            sourceUrl: location.href,
          });
          return;
        }
      }
      // 纯文本兜底：按空行分段，空行隔开的段落各成一块
      const paras = text.split(/\n\s*\n/).filter((s) => s.trim());
      const blocks = paras.map((s) => ({ t: "p", text: s.trim() }));
      kbSavePipeline({
        blocks,
        plainText: text,
        imgUrls: [],
        sourceUrl: location.href,
      });
    } catch (e) {
      warn("选区保存失败，降级纯文本：", e);
      kbSavePipeline({
        blocks: [{ t: "p", text }],
        plainText: text,
        imgUrls: [],
        sourceUrl: location.href,
      });
    }
  }

  // ---------- 监听页面变化 ----------

  const observer = new MutationObserver(() => scanCodeBlocks());
  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(scanCodeBlocks, 1000);
    if (location.hostname.endsWith("grok.com")) patchGrokSocket();
    // 侧边栏/小窗刚被打开时，投递可能先于本脚本就绪：补查 60 秒内的待填内容
    chrome.storage.local.get("aiPendingPrompt", (d) => {
      const item = d && d.aiPendingPrompt;
      if (item && Date.now() - item.at < 60000) handlePendingPrompt(item);
    });
    // Alt+S 快捷键指令（background commands → tabs.sendMessage）
    chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
      if (msg && msg.type === "DS_KB_CAPTURE") {
        kbCaptureActive();
        sendResponse({ ok: true });
      }
      // 入口 D：右键选中文字 → 存选区（富内容：选区所在 DOM 范围解析）
      if (msg && msg.type === "DS_KB_CAPTURE_SEL") {
        kbCaptureSelection();
        sendResponse({ ok: true });
      }
      // 入口 C：右键图片 → 抓图 → 单独一条摘录
      if (msg && msg.type === "DS_KB_CAPTURE_IMG" && msg.url) {
        (async () => {
          const r = await kbCaptureImage(msg.url);
          if (!r) {
            kbPageToast("图片保存失败");
            return;
          }
          let name = "图片摘录";
          try {
            const u = new URL(msg.url, location.href);
            name = decodeURIComponent(u.pathname.split("/").pop() || "").slice(0, 40) || name;
          } catch (_e) { /* 保持默认 */ }
          await kbSavePipeline({
            blocks: [{ t: "img", mi: 0, thumb: r.thumb }],
            plainText: name,
            imgUrls: [msg.url],
            sourceUrl: msg.pageUrl || location.href,
          });
        })();
        sendResponse({ ok: true });
      }
    });
    log("页面桥已就绪", location.href);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
