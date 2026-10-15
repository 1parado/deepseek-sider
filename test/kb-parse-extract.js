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


window.kbParseBlocks = kbParseBlocks;
window.collectRefsAround = collectRefsAround;
