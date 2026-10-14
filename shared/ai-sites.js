// ============================================================
// DeepSeek Sider - AI 站点清单与通用工具
// 侧边栏（站点切换栏 / iframe 池 / 多选对比 / 管理面板）与
// background 共用。
//
// 站点数据流向：BUILTIN_AI_SITES 是出厂默认；用户增删改后的完整
// 列表持久化在 storage.local.aiSites，侧边栏启动时读取，读不到
// 或结构不合法时回落内置清单。两个列表的条目结构一致：
//   id / name / url    必填（id 用 url origin + 路径哈希生成）
//   icon               可选，扩展内图标路径（内置站点才有）
//   chat               可选，ai-bridge.js 适配键（内置站点才有）
//   noEmbed            可选，已知风控会拒绝 iframe 内嵌
// ============================================================

const BUILTIN_AI_SITES = [
  { id: "deepseek", name: "DeepSeek", url: "https://chat.deepseek.com/", icon: "/icons/ai/deepseek.svg", chat: "deepseek" },
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/", icon: "/icons/ai/chatgpt.svg", chat: "chatgpt", noEmbed: true },
  { id: "claude", name: "Claude", url: "https://claude.ai/new", icon: "/icons/ai/claude.svg", chat: "claude" },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com/app", icon: "/icons/ai/gemini.svg", chat: "gemini", noEmbed: true },
  { id: "grok", name: "Grok", url: "https://grok.com/", icon: "/icons/ai/grok.svg", chat: "grok" },
  { id: "doubao", name: "豆包", url: "https://www.doubao.com/chat/", icon: "/icons/ai/doubao.svg", chat: "doubao" },
  { id: "kimi", name: "Kimi", url: "https://www.kimi.com/", icon: "/icons/ai/kimi.svg", chat: "kimi" },
  { id: "zhipu", name: "智谱清言", url: "https://chatglm.cn/", icon: "/icons/ai/zhipu.svg", chat: "zhipu" },
  { id: "qianwen", name: "通义千问", url: "https://www.qianwen.com/", icon: "/icons/ai/qianwen.png", chat: "qwen" },
  { id: "yuanbao", name: "腾讯元宝", url: "https://yuanbao.tencent.com/chat", icon: "/icons/ai/yuanbao.png", chat: "yuanbao" },
  { id: "perplexity", name: "Perplexity", url: "https://www.perplexity.ai/", icon: "/icons/ai/perplexity.svg", chat: "perplexity" },
  { id: "mistral", name: "Le Chat", url: "https://chat.mistral.ai/chat", icon: "/icons/ai/mistral.svg", chat: "mistral" },
  { id: "copilot", name: "Copilot", url: "https://copilot.microsoft.com/", icon: "/icons/ai/copilot.svg", chat: "copilot" },
  { id: "poe", name: "Poe", url: "https://poe.com/", icon: "/icons/ai/poe.svg", chat: "poe" },
  { id: "groq", name: "Groq", url: "https://chat.groq.com/", icon: "/icons/ai/groq.svg", chat: "groq" },
  { id: "huggingchat", name: "HuggingChat", url: "https://huggingface.co/chat/", icon: "/icons/ai/huggingchat.svg", chat: "huggingchat" },
  { id: "pi", name: "Pi", url: "https://pi.ai/talk", icon: "/icons/ai/pi.svg", chat: "pi" },
  { id: "youcom", name: "You.com", url: "https://you.com/", icon: "/icons/ai/youcom.svg", chat: "youcom" },
];

// ---------- 站点数据工具（storage 列表 / 内置列表通用） ----------

function normalizeSiteUrl(url) {
  url = (url || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    const u = new URL(url);
    // 统一以 / 结尾，保证 origin+path 形态一致
    return u.origin + (u.pathname === "/" ? "/" : u.pathname.replace(/\/+$/, "") + "/");
  } catch (e) {
    return "";
  }
}

// 稳定 id：origin + path 的 djb2 哈希。同一网址重复添加得到同一 id，
// 天然去重；内置站点保留手写的短 id。
function siteIdFor(url) {
  const h = url.split("").reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 5381);
  return "site_" + (h >>> 0).toString(36);
}

function isValidSite(s) {
  return s && typeof s.id === "string" && typeof s.name === "string" && !!normalizeSiteUrl(s.url);
}

// 用户自定义站点的 favicon 候选链（参照 OrbitShot：主源失败依次换下一源）
function faviconCandidates(url) {
  try {
    const host = new URL(normalizeSiteUrl(url)).hostname;
    return ["https://favicon.im/" + host + "?larger=true", "https://" + host + "/favicon.ico", "https://www.google.com/s2/favicons?domain=" + host + "&sz=64"];
  } catch (e) {
    return [];
  }
}

// 兼容旧引用：侧边栏/SW 里的运行时列表统一叫 AI_SITES（由启动逻辑赋值）
const AI_SITES = BUILTIN_AI_SITES;
