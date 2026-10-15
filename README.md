# AI Sider（原 DeepSeek Sider）

在浏览器侧边栏中使用多个 **AI 网页版**（DeepSeek / ChatGPT / Claude / Gemini / Grok / 豆包 / Kimi / 通义千问 / 腾讯元宝 / Perplexity / Le Chat / Copilot / Poe / Groq / HuggingChat / Pi / You.com），支持 **Ctrl 多选并排对比**，并支持一键把网页选中内容送进 AI 提问。

纯本地实现的 Chrome 扩展（MV3）：无后台服务、无账号体系、不收集任何数据。

## 功能

- **侧边栏多 AI**：点工具栏图标，右侧打开 AI 网页版，复用你的登录态，正常聊天
- **顶部图标栏切换**：侧边栏顶栏一排 AI 图标，点谁用谁；各站点会话分别保留，来回切换不丢上下文
- **多选对比**：**Ctrl + 点击**多个图标（2~4 个），它们并排展示在同一侧边栏里，一问多答；**拖动面板之间的分隔条可调整各栏宽度**（单栏最小 160px，双击分隔条恢复均分），布局和多选状态都会记住，重开侧边栏原样恢复
- **自定义站点**：顶栏 <kbd>＋</kbd> 打开管理面板，可新增任意 AI 网页版、修改名称/网址、删除；图标自动抓取站点 favicon（抓不到则显示首字母色块）；「恢复默认」一键还原出厂清单；**顶栏图标可直接拖拽排序**，顺序自动保存
- **弹出独立小窗**：某站点拒绝内嵌时，点顶栏 <kbd>⧉</kbd> 按钮把它弹出为独立小窗继续用
- **记忆偏好**：记住你上次用的是哪个 AI，下次打开侧边栏自动恢复
- **AI 一下**：在任意网页选中文字 → 右键 → 「AI 一下」→ 侧边栏自动打开，选中内容连同页面标题/URL 自动填入当前 AI 的输入框（不自动发送），接着输入你的问题即可
- **知识库**：看到好内容随手存——hover AI 回复点「⚡存」、选中文字弹浮条「存知识库」、右键图片「保存图片到知识库」、`Alt+S` 快捷键；默认静默存入「收件箱」（自动起标题、压缩图片、10 分钟内去重），toast 可一键 [整理]/[撤销]；侧边栏顶栏 📚 打开知识库，项目分组 + 搜索 + 卡片详情，可一键把摘录「发送给当前 AI」或「插入输入框」；全部数据存本地 IndexedDB，无任何上传

## 安装（Chrome / Edge 通用）

```bash
git clone https://github.com/1parado/deepseek-sider.git
```

1. 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`）
2. 右上角开启 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择克隆出来的 `deepseek-sider` 文件夹（含 `manifest.json` 的那层）
4. 点工具栏图标打开侧边栏，顶栏里选一个 AI 并登录（共用 cookie，登录一次即可）

> 需要 Chrome 114+（sidePanel API 要求）。

## 使用

1. 在任意网页选中一段文字
2. 右键 → **AI 一下**
3. 原生侧边栏自动打开，内容已自动填入当前 AI 的输入框，光标就位——继续输入你的问题，回车发送
4. 想换别的 AI？点顶栏的对应图标即切换
5. 想对比多个 AI 的回答？按住 **Ctrl** 依次点 2~4 个图标，侧边栏自动分成网格并排展示；再次 Ctrl 点击或点面板 ✕ 移出

### 支持的站点

| AI | 地址 | 备注 |
|---|---|---|
| DeepSeek | chat.deepseek.com | 支持 browser 协议执行 |
| ChatGPT | chatgpt.com | 风控常拒绝内嵌，默认直接弹独立小窗 |
| Claude | claude.ai | |
| Gemini | gemini.google.com | Google IP 风控可能拦人机验证，见下文 |
| Grok | grok.com | |
| 豆包 | doubao.com | |
| Kimi | kimi.com | |
| 智谱清言 | chatglm.cn | |
| 通义千问 | qianwen.com | 通义已从 tongyi.com 迁移至该域名 |
| 腾讯元宝 | yuanbao.tencent.com | |
| Perplexity | perplexity.ai | |
| Le Chat | chat.mistral.ai | |
| Copilot | copilot.microsoft.com | |
| Poe | poe.com | |
| Groq | chat.groq.com | |
| HuggingChat | huggingface.co/chat | |
| Pi | pi.ai/talk | |
| You.com | you.com | |

以上为出厂清单。通过顶栏 <kbd>＋</kbd> 可添加任意 AI 网页版（如智谱清言、文心一言、Poe 上的某个 bot 页等），自定义站点图标自动从站点抓取 favicon。

> 各站点是否允许 iframe 内嵌由其自身策略决定，插件通过 declarativeNetRequest 剥除响应头中的 `X-Frame-Options` / `Content-Security-Policy` 来启用侧边栏内嵌。但**站点自身的风控**（人机验证、异常流量拦截）发生在页面内部，插件无法也不应绕过。若某站点改版导致输入框定位失效，欢迎提 issue。

### 关于 Gemini / ChatGPT 的人机验证

- **Gemini**（截图中的「检测到异常流量」）是 Google 对数据中心/代理 IP 的风控，与插件无关。侧边栏里遇到时点 <kbd>⧉</kbd> 弹出独立小窗，在真实标签页中完成验证后，登录态会共享回侧边栏
- **ChatGPT** 对内嵌场景风控更严，插件将其标记为「仅独立小窗」：首次点选时直接弹出小窗，避免空白页
- 这类站点在侧边栏中保持可用性的唯一可靠路径是：先在普通标签页登录一次，cookie 共享后侧边栏/小窗内即为已登录状态

### 实现链路（对齐 Chrome 官方模式）

```
右键菜单（contextMenus）
  → onClicked 回调【同步】调 sidePanel.open()   ← 用户手势内第一行，不能先 await
  → storage.local.aiPendingPrompt → ai-bridge.js（侧边栏 iframe / 停靠小窗中）
      监听 storage 变化 → 按站点适配器填入输入框（不自动发送）→ 你补充问题后手动发送
```

关键点：

- `sidePanel.open()` 必须在用户手势上下文中同步调用（右键菜单点击、图标点击都算）；若在它之前 `await` 了异步操作，手势丢失、打开被拒绝——这是常见的坑
- 侧边栏 iframe 中 content script 可以运行，但无法被 `tabs.sendMessage` 直达，所以用 storage 做通信桥梁
- 顶部图标栏与多选对比的交互参考了 [OrbitShot](https://github.com/1parado/OrbitShot) 的多 AI 设计（Ctrl 多选 → 确认 → 并排网格）
- 若侧边栏打不开（部分 Chrome 版本对右键手势的判定差异），自动弹出/复用**贴边停靠小窗**（430px 宽、贴当前窗口右缘、全高）兜底，内容照常自动填入

## 项目结构

```
deepseek-sider/
├── manifest.json                 # MV3：sidePanel + DNR + content_scripts
├── rules.json                    # 剥掉各 AI 站点的 XFO/CSP，允许 iframe 内嵌
├── shared/ai-sites.js            # 出厂站点清单 + 站点工具函数（用户列表存 storage）
├── background/service-worker.js  # 右键菜单 + 协议指令路由 + 弹出小窗
├── content/bridge.js             # 页面执行器：注入所有页面，执行 DOM 操作
├── content/ai-bridge.js          # AI 页面桥：按站点适配输入框 / 心跳 / 协议代码块解析
├── icons/ai/                     # 内置站点 logo（OrbitShot 图标库 + lobehub icons）
└── sidepanel/                    # 侧边栏：index.html + sidepanel.js（切换栏/多选网格/站点管理）
```

## 隐私与安全 ⚠️

- 所有操作均在本地完成，插件本身不联网、不上传数据，没有任何遥测
- 插件声明了 `<all_urls>` + `scripting` 权限（页面执行器需要），请自行评估后使用
- 若 DeepSeek 回复中出现符合 `{"tool":"browser",...}` 协议的代码块，插件会尝试执行——日常聊天不会触发，无需担心（协议执行目前仅在 DeepSeek 页启用）

## 免责声明

本项目为个人开发的工具，与文中提及的各 AI 服务官方均无任何关联；相关商标归其所有者所有。

## 路线图

- [ ] 整页正文一键发送（不只是选区）
- [ ] 多轮问答上下文自动带上页面内容
- [ ] 多选对比时一键把同一问题群发给所有选中 AI（参考 OrbitShot 批量派发）

---

学AI，上[L站](https://linux.do/)
