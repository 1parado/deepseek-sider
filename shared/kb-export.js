// ============================================================
// AI Sider - 知识库导出（Markdown）
// 依赖 shared/kb-db.js（kbListExcerpts / kbListProjects / kbGetMedia /
//                      kbClearAll / kbKvGet / kbKvSet / kbKvDel）
// 可运行在两处：
//   - sidepanel（File System Access API：选目录 + 直接写文件）
//   - service worker（chrome.alarms 触发，用持久化的目录句柄写文件）
// 导出结构：
//   <目录>/AI-Sider-导出-<YYYY-MM-DD>/
//     ├── 收件箱.md  <项目名>.md ...
//     └── images/    （图片按 摘录id-N.ext 命名）
// 导出成功后由调用方决定是否 kbClearAll()。
// ============================================================

const KB_EXPORT_DIR_KEY = "kbExportDirHandle";
const KB_EXPORT_AUTO_KEY = "kbAutoExport";

function kbExportFolderName(now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return `AI-Sider-导出-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// dataURL → { blob, ext }
function kbExportDataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(dataUrl || "");
  if (!m) return null;
  const mime = m[1] || "image/png";
  const extMap = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };
  const ext = extMap[mime] || "png";
  let blob;
  if (m[2]) {
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: mime });
  } else {
    blob = new Blob([decodeURIComponent(m[3])], { type: mime });
  }
  return { blob, ext };
}

function kbExportSafeName(name) {
  const n = String(name || "").replace(/[\\/:*?"<>|\n\r]/g, "_").trim();
  return n.slice(0, 60) || "无标题";
}

// 单条摘录 → markdown 文本
function kbExcerptToMarkdown(x) {
  const parts = [];
  parts.push(`## ${x.title || "无标题"}`);
  const meta = [];
  if (x.sourceModel) meta.push(x.sourceModel);
  if (x.createdAt) meta.push(new Date(x.createdAt).toLocaleString("zh-CN"));
  if (meta.length) parts.push(`> ${meta.join(" · ")}`);
  (x.blocks || []).forEach((b) => {
    if (b.t === "img" && typeof b.mi === "number") {
      parts.push(`![图片](images/${x.id}-${b.mi}.png)`);
    } else if (b.t === "code") {
      const lang = b.lang || "";
      const fence = (b.text || "").includes("```") ? "````" : "```";
      parts.push(fence + lang + "\n" + (b.text || "") + (b.text && b.text.endsWith("\n") ? "" : "\n") + fence);
    } else {
      parts.push(b.text || "");
    }
  });
  if ((x.tags || []).length) parts.push(`\`#${x.tags.map((t) => t.replace(/\s+/g, "-")).join("# #")}\``);
  if (x.sourceUrl) parts.push(`来源：${x.sourceUrl}`);
  if ((x.refs || []).length) {
    parts.push("参考资料：");
    x.refs.forEach((r) => parts.push(`- [${r.title || r.url}](${r.url})`));
  }
  return parts.join("\n\n");
}

// 全量导出为待写文件集合（不落盘）。返回 { files: [{path, blob}], count }
async function kbExportCollect() {
  const [projects, excerpts] = await Promise.all([kbListProjects(), kbListExcerpts()]);
  if (!excerpts.length) return { files: [], count: 0 };
  const files = [];
  const projName = {};
  projects.forEach((p) => (projName[p.id] = kbExportSafeName(p.name)));
  const byProj = {};
  excerpts.forEach((x) => ((byProj[x.projectId] = byProj[x.projectId] || []).push(x)));
  Object.keys(byProj).forEach((pid) => {
    const name = projName[pid] || "未分组";
    const body = byProj[pid]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((x) => kbExcerptToMarkdown(x))
      .join("\n\n---\n\n");
    const head = `# ${name}\n\n> 共 ${byProj[pid].length} 条 · 导出于 ${new Date().toLocaleString("zh-CN")}\n\n`;
    files.push({ path: `${name}.md`, text: head + body });
  });
  // 图片统一在此解析（media 数据不在 block 上）
  const mediaNeeded = [];
  excerpts.forEach((x) => {
    (x.blocks || []).forEach((b) => {
      if (b.t === "img" && typeof b.mi === "number") mediaNeeded.push({ x, mi: b.mi });
    });
  });
  const seen = new Set();
  for (const { x, mi } of mediaNeeded) {
    const id = (x.mediaIds || [])[mi];
    const key = x.id + "-" + mi;
    if (!id || seen.has(key)) continue;
    seen.add(key);
    const m = await kbGetMedia(id);
    if (!m || !m.dataUrl) continue;
    const conv = kbExportDataUrlToBlob(m.dataUrl);
    if (!conv) continue;
    files.push({ path: `images/${key}.${conv.ext}`, blob: conv.blob });
  }
  return { files, count: excerpts.length };
}

// ---- File System Access API：目录句柄持久化 ----
async function kbExportPickDir() {
  if (typeof window === "undefined" || !window.showDirectoryPicker) {
    throw new Error("当前环境不支持选择目录（需 Chrome 86+ 且为扩展页面）");
  }
  const handle = await window.showDirectoryPicker({ id: "ai-sider-export", mode: "readwrite", startIn: "documents" });
  await kbKvSet(KB_EXPORT_DIR_KEY, handle);
  return handle;
}
async function kbExportGetDir() {
  const handle = await kbKvGet(KB_EXPORT_DIR_KEY);
  if (!handle) return null;
  // 句柄可能因目录被移动/删除而失效；查询权限不弹窗
  try {
    const q = await handle.queryPermission({ mode: "readwrite" });
    if (q !== "granted") return handle; // 句柄还在但权限待用户确认（自动导出时 attemptPermission 会尝试）
    return handle;
  } catch (e) {
    await kbKvDel(KB_EXPORT_DIR_KEY);
    return null;
  }
}
async function kbExportSetAuto(on) {
  await kbKvSet(KB_EXPORT_AUTO_KEY, !!on);
}
async function kbExportGetAuto() {
  return !!(await kbKvGet(KB_EXPORT_AUTO_KEY));
}

// 写一批文件到目录句柄（SW 与 sidepanel 通用）
async function kbExportWriteFiles(dirHandle, files) {
  // images 子目录
  const imgDir = await dirHandle.getDirectoryHandle("images", { create: true });
  for (const f of files) {
    if (f.path.startsWith("images/")) {
      const fh = await imgDir.getFileHandle(f.path.slice(7), { create: true });
      const w = await fh.createWritable();
      await w.write(f.blob != null ? f.blob : new Blob([f.text], { type: "text/markdown" }));
      await w.close();
    } else {
      const fh = await dirHandle.getFileHandle(f.path, { create: true });
      const w = await fh.createWritable();
      await w.write(new Blob([f.text], { type: "text/markdown" }));
      await w.close();
    }
  }
}

// 完整导出流程：收集 → 写盘。clear=true 时成功后清空 IndexedDB。
// 返回 { count, files }；无内容返回 { count: 0, skipped: true }
async function kbExportRun(dirHandle, clear) {
  const { files, count } = await kbExportCollect();
  if (!count) return { count: 0, skipped: true };
  await kbExportWriteFiles(dirHandle, files);
  if (clear) await kbClearAll();
  return { count, files };
}
