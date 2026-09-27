# DeepSeek Sider

在浏览器侧边栏中使用 **DeepSeek 网页版（chat.deepseek.com）**，并支持一键把网页选中内容送进 DeepSeek 提问。

纯本地实现的 Chrome 扩展（MV3）：无后台服务、无账号体系、不收集任何数据。

## 功能

- **侧边栏 DeepSeek**：点工具栏图标，右侧打开 DeepSeek 网页版，复用你的登录态，正常聊天
- **DeepSeek 一下**：在任意网页选中文字 → 右键 → 「DeepSeek 一下」→ 侧边栏自动打开，选中内容连同页面标题/URL 自动填入输入框（不自动发送），接着输入你的问题即可

## 安装（Chrome / Edge 通用）

```bash
git clone https://github.com/1parado/deepseek-sider.git
```

1. 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`）
2. 右上角开启 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择克隆出来的 `deepseek-sider` 文件夹（含 `manifest.json` 的那层）
4. 点工具栏的 DeepSeek 鲸鱼图标打开侧边栏，登录 chat.deepseek.com（共用 cookie，登录一次即可）

> 需要 Chrome 114+（sidePanel API 要求）。

## 使用

1. 在任意网页选中一段文字
2. 右键 → **DeepSeek 一下**
3. 原生侧边栏自动打开，内容已自动填入 DeepSeek 输入框，光标就位——继续输入你的问题，回车发送

### 实现链路（对齐 Chrome 官方模式）

```
右键菜单（contextMenus）
  → onClicked 回调【同步】调 sidePanel.open()   ← 用户手势内第一行，不能先 await
  → storage.local.dsPendingPrompt → deepseek-bridge.js（侧边栏 iframe / 停靠小窗中）
      监听 storage 变化 → 填入输入框（不自动发送）→ 你补充问题后手动发送
```

关键点：

- `sidePanel.open()` 必须在用户手势上下文中同步调用（右键菜单点击、图标点击都算）；若在它之前 `await` 了异步操作，手势丢失、打开被拒绝——这是常见的坑
- 侧边栏 iframe 中 content script 可以运行，但无法被 `tabs.sendMessage` 直达，所以用 storage 做通信桥梁
- 若侧边栏打不开（部分 Chrome 版本对右键手势的判定差异），自动弹出/复用**贴边停靠小窗**（430px 宽、贴当前窗口右缘、全高）兜底，内容照常自动填入

## 项目结构

```
deepseek-sider/
├── manifest.json                 # MV3：sidePanel + DNR + content_scripts
├── rules.json                    # 剥掉 chat.deepseek.com 的 XFO/CSP，允许 iframe 内嵌
├── background/service-worker.js  # 右键菜单 + 协议指令路由
├── content/bridge.js             # 页面执行器：注入所有页面，执行 DOM 操作
├── content/deepseek-bridge.js    # DeepSeek 页面桥：填输入框 / 心跳 / 协议代码块解析
└── sidepanel/index.html          # 侧边栏：纯 DeepSeek iframe，零附加 UI
```

## 隐私与安全 ⚠️

- 所有操作均在本地完成，插件本身不联网、不上传数据，没有任何遥测
- 插件声明了 `<all_urls>` + `scripting` 权限（页面执行器需要），请自行评估后使用
- 若 DeepSeek 回复中出现符合 `{"tool":"browser",...}` 协议的代码块，插件会尝试执行——日常聊天不会触发，无需担心

## 免责声明

本项目为个人开发的工具，与 DeepSeek 官方无任何关联；DeepSeek 相关商标归其所有者所有。

## 路线图

- [ ] 整页正文一键发送（不只是选区）
- [ ] 多轮问答上下文自动带上页面内容
