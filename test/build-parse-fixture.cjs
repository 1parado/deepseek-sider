// 生成浏览器 fixture：加载 ai-bridge.js 抽取的解析函数，模拟千问 + DeepSeek 思考容器 DOM 跑解析
// 用法：node build-parse-fixture.cjs  → 浏览器打开 test/kb-parse-fixture.html 查看 window.__result
const fs = require("fs");

// 1. 从 ai-bridge.js 抽取 kbParseBlocks / collectRefsAround 及其依赖常量
const src = fs.readFileSync("E:/deepseek_sider/content/ai-bridge.js", "utf8");
const rs = src.indexOf("const KB_REPLY_SELECTORS = [");
const re = src.indexOf("];", rs) + 2;
const replySel = src.slice(rs, re);
const us = src.indexOf("const KB_SITE_ADAPTERS");
const ue = src.indexOf("  // ---- 图片抓取");
if (rs < 0 || us < 0 || ue < 0) throw new Error("markers not found in ai-bridge.js");
let code = src.slice(us, ue);
code += "\nwindow.kbParseBlocks = kbParseBlocks;\nwindow.collectRefsAround = collectRefsAround;\n";
fs.writeFileSync(__dirname + "/kb-parse-extract.js", code);

// 2. 构造 fixture 页面：两种消息结构（千问参考卡片 + DeepSeek 思考容器）
const script = `
(function(){
  const host = document.getElementById('host');
  host.innerHTML = [
    '<div class="qwen-msg">',
    '  <div data-message-author-role="user"><p>我想要了解一下大模型的机制</p></div>',
    '  <div class="search-panel">',
    '    <a href="https://zhihu.com/a"><img src="data:image/gif;base64,R0" width="24" height="24"><span>深入 Transformer:大语言模型底层架构全解析</span></a>',
    '    <a href="https://zhihu.com/b"><img src="data:image/gif;base64,R0" width="24" height="24"><span>大模型进阶之路:预训练与微调技术深度解析</span></a>',
    '    <a href="https://z.q7.com/c"><span>查看全部</span></a>',
    '  </div>',
    '  <div class="markdown-body" data-message-author-role="assistant">',
    '    <p>大模型的机制可以拆成四块来理解,这是正文。</p>',
    '    <p>注意力公式 <span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}\\\\left(\\\\frac{QK^T}{\\\\sqrt{d_k}}\\\\right)V</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">Attention(Q,K,V)=softmaxQKTdkV</span></span> 输出加权。</p>',
    '    <a href="https://example.com/inline-ref">正文内引用:一文讲透AI大模型架构与原理流程详解</a>',
    '  </div>',
    '</div>',
    '<div class="ds-msg">',
    '  <div class="_think-container"><p>我们需要回答用户中文。需要解释大模型机制。这是推理内容。</p></div>',
    '  <div class="ds-markdown">',
    '    <p>大模型（LLM）的机制可以拆成:架构、训练、推理、对齐四块。这是正文。</p>',
    '  </div>',
    '</div>'
  ].join('\\n');
  const qwen = host.querySelector('.qwen-msg .markdown-body');
  // 模拟千问 host → 适配器路径生效（user/think/panels 选择器走声明值）
  const origHost = Object.getOwnPropertyDescriptor(window, 'location');
  try { Object.defineProperty(window, 'location', { value: { hostname: 'chat.qwen.ai' }, configurable: true }); } catch(e) {}
  const qParsed = kbParseBlocks(qwen);
  const qAround = collectRefsAround(qwen);
  try { Object.defineProperty(window, 'location', { value: { hostname: 'chat.deepseek.com' }, configurable: true }); } catch(e) {}
  const dsMd = host.querySelector('.ds-msg .ds-markdown');
  const dsParsed = kbParseBlocks(dsMd);
  try { if (origHost) Object.defineProperty(window, 'location', origHost); } catch(e) {}
  window.__result = {
    qwen: {
      plainText: qParsed.plainText,
      blocks: qParsed.blocks.map(function(b){ return b.t === 'p' ? b.text : b.t + ':' + (b.url || ''); }),
      refs: qParsed.refs.concat(qAround),
    },
    deepseek: {
      plainText: dsParsed.plainText,
      blocks: dsParsed.blocks.map(function(b){ return b.t === 'p' ? b.text : b.t + ':' + (b.url || ''); }),
    },
  };
})();
`;

const html = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>parse fixture</title></head>\n'
  + '<body><div id="host"></div>\n<script src="./kb-parse-extract.js"></script>\n<script>'
  + script
  + '</script></body></html>';
fs.writeFileSync(__dirname + "/kb-parse-fixture.html", html);
console.log("fixture written");
