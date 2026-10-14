// ============================================================
// DeepSeek Browser Bridge - 页面执行器
// 注入到所有 http(s) 页面，负责真正执行 DOM 操作。
// 支持的 selector 特殊语法：
//   "text=登录"   -> 在可见的 button/a/[role=button]/[type=submit] 中按文本匹配
//   其余按标准 CSS selector 处理
// ============================================================

(() => {
  if (window.__dsBridgeInstalled) return;
  window.__dsBridgeInstalled = true;

  // ---------- 侧边栏 iframe 中的导航拦截 ----------
  // 本脚本也运行在侧边栏的 iframe 里（all_frames）。此时点击 <a>
  // 或 target=_blank 会让侧边栏面板整页跳走，会话就丢了。
  // 捕获阶段拦截：跨站链接 preventDefault 后交由 background 开真实
  // 标签页；同站导航（如切换会话）放行不动。
  if (window.self !== window.top) {
    const inFrame = () => {
      try {
        return window.self !== window.top;
      } catch (e) {
        return true;
      }
    };
    document.addEventListener(
      "click",
      (e) => {
        if (!inFrame()) return;
        const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
        if (!a) return;
        let url;
        try {
          url = new URL(a.href, location.href);
        } catch (_e) {
          return;
        }
        // 只拦 http(s)：javascript:/blob:/anchor 跳过
        if (!/^https?:$/i.test(url.protocol)) return;
        // 同站（含子域替换）放行：SPA 内部导航不该被劫到新标签页
        if (url.hostname === location.hostname) return;
        // 中键 / Ctrl / Cmd / Shift 修饰点击本来就是开新标签，不拦
        if (e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey) return;
        // target=_blank 或跨站链接 → 开真实标签页
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: "DS_OPEN_IN_TAB", url: url.href }).catch(() => {});
      },
      true
    );
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "DS_PING") {
      sendResponse({ ok: true });
      return;
    }
    if (msg && msg.type === "DS_BROWSER_CMD") {
      exec(msg.command)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
      return true; // 异步响应
    }
  });

  async function exec(cmd) {
    switch (cmd.action) {
      case "read":
        return doRead(cmd);
      case "click":
        return doClick(cmd);
      case "fill":
        return doFill(cmd);
      case "extract":
        return doExtract(cmd);
      case "scroll":
        return doScroll(cmd);
      case "select":
        return doSelect(cmd);
      case "get_interactive":
        return doGetInteractive(cmd);
      default:
        return { ok: false, error: "未知 action: " + cmd.action };
    }
  }

  // ---------- 元素定位 ----------

  function isVisible(el) {
    if (!el || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function findElement(selector) {
    if (!selector) return null;
    if (selector.startsWith("text=")) {
      const kw = selector.slice(5).trim();
      const candidates = document.querySelectorAll(
        'button, a, [role="button"], [role="tab"], [role="menuitem"], [type="submit"], summary, label'
      );
      let fallback = null;
      for (const el of candidates) {
        const txt = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
        if (!txt) continue;
        if (txt === kw) return el;
        if (!fallback && txt.includes(kw)) fallback = el;
      }
      return fallback;
    }
    return document.querySelector(selector);
  }

  // ---------- 各类操作 ----------

  function doRead(cmd) {
    const max = Math.min(cmd.maxLength || 6000, 20000);
    const text = (document.body ? document.body.innerText : "").trim();
    return {
      ok: true,
      title: document.title,
      url: location.href,
      textLength: text.length,
      text: text.slice(0, max),
      truncated: text.length > max,
    };
  }

  async function doClick(cmd) {
    const el = findElement(cmd.selector);
    if (!el) return { ok: false, error: "未找到元素：" + cmd.selector };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((r) => setTimeout(r, 150));
    try {
      // 一些框架依赖完整的鼠标事件序列
      const rect = el.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
    } catch (e) {
      /* 忽略事件派发失败，仍然执行 click */
    }
    el.click();
    return { ok: true, clicked: (el.innerText || el.tagName).slice(0, 60) };
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function doFill(cmd) {
    if (typeof cmd.value !== "string") return { ok: false, error: "fill 需要字符串 value" };
    const el = findElement(cmd.selector);
    if (!el) return { ok: false, error: "未找到元素：" + cmd.selector };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus();
    if (el.isContentEditable) {
      el.textContent = cmd.value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      setNativeValue(el, cmd.value);
    } else {
      return { ok: false, error: "目标元素不是输入框：" + el.tagName };
    }
    if (cmd.pressEnter) {
      await new Promise((r) => setTimeout(r, 100));
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true })
      );
    }
    return { ok: true, filled: cmd.value.length + " 字符" };
  }

  function doExtract(cmd) {
    const selector = cmd.selector || "body";
    const attr = cmd.attr || "text";
    const limit = Math.min(cmd.limit || 50, 200);
    const els = Array.from(document.querySelectorAll(selector)).filter(isVisible).slice(0, limit);
    const items = els.map((el) => {
      if (attr === "text") return (el.innerText || "").trim().slice(0, 500);
      if (attr === "html") return el.outerHTML.slice(0, 1000);
      return el.getAttribute(attr) || "";
    });
    return { ok: true, count: items.length, items };
  }

  function doScroll(cmd) {
    if (cmd.selector) {
      const el = findElement(cmd.selector);
      if (!el) return { ok: false, error: "未找到元素：" + cmd.selector };
      el.scrollIntoView({ block: "center", behavior: "instant" });
      return { ok: true };
    }
    if (cmd.to === "top") window.scrollTo({ top: 0 });
    else if (cmd.to === "bottom") window.scrollTo({ top: document.body.scrollHeight });
    else window.scrollBy({ top: cmd.pixels || 800 });
    return { ok: true, scrollY: window.scrollY };
  }

  function doSelect(cmd) {
    const el = findElement(cmd.selector);
    if (!(el instanceof HTMLSelectElement)) return { ok: false, error: "目标不是 <select> 元素" };
    let matched = false;
    for (const opt of el.options) {
      if (opt.value === cmd.value || opt.text.trim() === cmd.value) {
        el.value = opt.value;
        matched = true;
        break;
      }
    }
    if (!matched) return { ok: false, error: "没有匹配的选项：" + cmd.value };
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected: cmd.value };
  }

  // 给 LLM 用：列出当前页面可交互元素，方便它决定下一步点什么
  function doGetInteractive() {
    const nodes = document.querySelectorAll(
      'a[href], button, input, textarea, select, [role="button"], [role="tab"], [onclick]'
    );
    const items = [];
    let i = 0;
    for (const el of nodes) {
      if (!isVisible(el) || items.length >= 120) continue;
      const txt = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 60);
      items.push({
        i: i++,
        tag: el.tagName.toLowerCase(),
        text: txt,
        id: el.id || undefined,
        name: el.name || undefined,
        href: el.tagName === "A" ? el.href : undefined,
        type: el.type || undefined,
      });
    }
    return { ok: true, count: items.length, items };
  }
})();
