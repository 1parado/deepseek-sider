// ============================================================
// AI Sider - 知识库数据层（IndexedDB）
// 数据库名 kb-v1，三个 store：
//   projects  项目（含内置「收件箱」isInbox）
//   excerpts  摘录（索引：projectId / createdAt / sourceModel / hasImages / tags multiEntry）
//   media     图片 Blob（keyPath id；excerpt 存 mediaIds 引用）
// 设计约束：
//   - 纯 Promise 封装，无外部依赖；本文件同时被
//     background/service-worker.js（importScripts）与
//     sidepanel/index.html（<script>）加载，两处均可读写
//   - schema 升级走 onupgradeneeded 线性迁移，DB_VERSION 递增
//   - 写摘录前先写 media，摘录删除后清理孤儿 media
// ============================================================

const KB_DB_NAME = "kb-v1";
const KB_DB_VERSION = 2;
let _kbDbPromise = null;

const KB_INBOX_ID = "inbox";
const KB_INBOX_NAME = "收件箱";

function kbOpen() {
  if (_kbDbPromise) return _kbDbPromise;
  _kbDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(KB_DB_NAME, KB_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 2) {
        // kv：导出目录句柄等小设置（value 可为结构化克隆值，含 FileSystemDirectoryHandle）
        db.createObjectStore("kv", { keyPath: "key" });
      }
      if (e.oldVersion < 1) {
        const projects = db.createObjectStore("projects", { keyPath: "id" });
        const excerpts = db.createObjectStore("excerpts", { keyPath: "id" });
        excerpts.createIndex("projectId", "projectId", { unique: false });
        excerpts.createIndex("createdAt", "createdAt", { unique: false });
        excerpts.createIndex("sourceModel", "sourceModel", { unique: false });
        excerpts.createIndex("hasImages", "hasImages", { unique: false });
        excerpts.createIndex("tags", "tags", { unique: false, multiEntry: true });
        db.createObjectStore("media", { keyPath: "id" });
        // 内置收件箱：静默保存的默认落点
        projects.put({
          id: KB_INBOX_ID,
          name: KB_INBOX_NAME,
          isInbox: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _kbDbPromise;
}

function kbTx(store, mode, fn) {
  return kbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const os = tx.objectStore(store);
        let result;
        try {
          result = fn(os);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = () => resolve(result && result._req ? result._req.result : result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("事务中止"));
      })
  );
}
// 在 tx 里发起的 request：resolve 其结果
function kbReq(req) {
  return { _req: req };
}

// ---------- 项目 ----------
async function kbEnsureInbox() {
  const db = await kbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("projects", "readwrite");
    tx.objectStore("projects").get(KB_INBOX_ID).onsuccess = (e) => {
      if (!e.target.result) {
        tx.objectStore("projects").put({
          id: KB_INBOX_ID,
          name: KB_INBOX_NAME,
          isInbox: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}
const kbListProjects = () => kbTx("projects", "readonly", (os) => kbReq(os.getAll()));
const kbPutProject = (p) => kbTx("projects", "readwrite", (os) => os.put(p));
const kbDeleteProject = (id) => kbTx("projects", "readwrite", (os) => os.delete(id));

// ---------- 摘录 ----------
const kbListExcerpts = () => kbTx("excerpts", "readonly", (os) => kbReq(os.getAll()));
const kbGetExcerpt = (id) => kbTx("excerpts", "readonly", (os) => kbReq(os.get(id)));
const kbPutExcerpt = (x) => kbTx("excerpts", "readwrite", (os) => os.put(x));
const kbDeleteExcerpt = (id) => kbTx("excerpts", "readwrite", (os) => os.delete(id));

// 去重：同 sourceModel + plainText 全等 且 时间差 < 10 分钟 → 视为重复
async function kbIsDuplicate(sourceModel, plainText) {
  const all = await kbListExcerpts();
  const now = Date.now();
  return all.some(
    (x) => x.sourceModel === sourceModel && x.plainText === plainText && now - x.createdAt < 10 * 60 * 1000
  );
}

// 写入摘录（含 media 引用完整性：先 media 后 excerpt）
async function kbSaveExcerpt(excerpt, mediaList) {
  const db = await kbOpen();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(["media", "excerpts"], "readwrite");
    const mos = tx.objectStore("media");
    (mediaList || []).forEach((m) => mos.put(m));
    tx.objectStore("excerpts").put(excerpt);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// 删除摘录并清理其独占 media（先查出引用方，只删无他人引用的）
async function kbRemoveExcerpt(id) {
  const db = await kbOpen();
  const ex = await kbGetExcerpt(id);
  if (!ex) return null;
  await kbDeleteExcerpt(id);
  const all = await kbListExcerpts();
  const referenced = new Set();
  all.forEach((x) => (x.mediaIds || []).forEach((m) => referenced.add(m)));
  const orphans = (ex.mediaIds || []).filter((m) => !referenced.has(m));
  if (orphans.length) {
    await new Promise((resolve) => {
      const tx = db.transaction("media", "readwrite");
      orphans.forEach((m) => tx.objectStore("media").delete(m));
      tx.oncomplete = resolve;
      tx.onerror = resolve; // 媒体清理失败不阻断
    });
  }
  return ex;
}

// 删除项目：默认把其下摘录移入收件箱；cascade=true 时连摘录（及孤儿媒体）一起删
async function kbDeleteProjectDeep(id, cascade) {
  if (id === KB_INBOX_ID) throw new Error("收件箱不可删除");
  const all = await kbListExcerpts();
  const mine = all.filter((x) => x.projectId === id);
  await kbEnsureInbox();
  for (const x of mine) {
    if (cascade) await kbRemoveExcerpt(x.id);
    else {
      x.projectId = KB_INBOX_ID;
      x.updatedAt = Date.now();
      await kbPutExcerpt(x);
    }
  }
  await kbDeleteProject(id);
  return mine.length;
}

// ---------- 媒体 ----------
const kbGetMedia = (id) => kbTx("media", "readonly", (os) => kbReq(os.get(id)));
const kbPutMedia = (m) => kbTx("media", "readwrite", (os) => os.put(m));

// ---------- kv（目录句柄等小设置） ----------
const kbKvGet = (key) =>
  kbTx("kv", "readonly", (os) => kbReq(os.get(key))).then((r) => (r ? r.value : undefined));
const kbKvSet = (key, value) => kbTx("kv", "readwrite", (os) => os.put({ key, value }));
const kbKvDel = (key) => kbTx("kv", "readwrite", (os) => os.delete(key));

// ---------- 一键清空（导出后释放空间） ----------
async function kbClearAll() {
  const db = await kbOpen();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(["excerpts", "media"], "readwrite");
    tx.objectStore("excerpts").clear();
    tx.objectStore("media").clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- 容量水位 ----------
async function kbStorageUsage() {
  try {
    const est = await navigator.storage.estimate();
    return { usage: est.usage || 0, quota: est.quota || 0 };
  } catch (e) {
    return { usage: 0, quota: 0 };
  }
}

// ---------- id ----------
function kbId(prefix) {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
