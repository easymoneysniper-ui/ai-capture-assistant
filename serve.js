/*
 * AI 截屏录屏助手 - 零依赖本地静态服务器
 *
 * 为什么不用 `npx http-server`：
 *   npx 每次要联网下载包，断网、npm 缓存被占用、公司代理受限时都会失败，
 *   用户会看到「服务没起来、页面打不开」。这个脚本只用 Node 内置模块，
 *   不需要任何下载，双击启动助手.bat 就能用。
 *
 * 用法:  node serve.js [端口] [绑定地址]
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = parseInt(process.argv[2], 10) || 8787;
const HOST = process.argv[3] || '127.0.0.1';
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.gz':   'application/gzip',
  '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
  '.txt':  'text/plain; charset=utf-8',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm'
};

// 允许写入的语言包名：只接受 Tesseract 既有的语言代码，杜绝用 lang 参数写任意文件
const TESS_LANG_RE = /^[a-z_]{2,20}$/;
const TESSDATA_DIR = path.join(ROOT, 'tessdata');
const MAX_PACK = 80 * 1024 * 1024;   // 单个语言包上限，防止有人往这里灌大文件

function handleSaveTessdata(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    return;
  }
  let lang = '';
  try {
    lang = (url.parse(req.url, true).query.lang || '').toString();
  } catch (e) {}
  if (!TESS_LANG_RE.test(lang)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'bad lang' }));
    return;
  }

  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_PACK) {
      aborted = true;
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'too large' }));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('error', () => { aborted = true; });
  req.on('end', () => {
    if (aborted) return;
    const buf = Buffer.concat(chunks);
    if (!buf.length) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'empty body' }));
      return;
    }
    const target = path.join(TESSDATA_DIR, lang + '.traineddata.gz');
    // 双保险：拼出来的路径必须仍在 tessdata/ 内
    if (!path.normalize(target).startsWith(TESSDATA_DIR + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
      return;
    }
    fs.mkdir(TESSDATA_DIR, { recursive: true }, (mkErr) => {
      if (mkErr) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: mkErr.message }));
        return;
      }
      // 先写临时文件再改名：中途失败不会留下半个损坏的语言包让 OCR 读崩
      const tmp = target + '.tmp' + process.pid;
      fs.writeFile(tmp, buf, (wErr) => {
        if (wErr) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: wErr.message }));
          return;
        }
        fs.rename(tmp, target, (rErr) => {
          if (rErr) {
            try { fs.unlinkSync(tmp); } catch (e) {}
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: rErr.message }));
            return;
          }
          console.log(`[语言包] 已保存 ${lang}.traineddata.gz (${(buf.length / 1048576).toFixed(1)} MB)`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, lang: lang, bytes: buf.length }));
        });
      });
    });
  });
}

/*
 * 保存全局热键：把网页上选好的组合写进 hotkey.ini，
 * 由「全局热键.ps1」读取并注册为系统级热键。
 * 只改配置里的 Hotkey 行，其余注释与设置原样保留。
 */
// 校验热键写法：修饰键(可多个) + 主键。
// 只允许 Ctrl/Alt/Shift/Win 与 A-Z、0-9、F1-F12，
// 既保证 PowerShell 那边能解析，也避免把任意内容写进 ini。
const HOTKEY_RE = /^(?:(?:Ctrl|Alt|Shift|Win)\+)+(?:[A-Za-z0-9]|F(?:[1-9]|1[0-2]))$/;
function handleHotkeyConfig(req, res){
  const send = (code, obj)=>{
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (req.method !== 'POST') return send(405, { ok:false, error:'method not allowed' });

  let body = '';
  let over = false;
  req.on('data', (c)=>{
    body += c;
    if (body.length > 4096 && !over){ over = true; req.destroy(); }
  });
  req.on('error', ()=>{});
  req.on('end', ()=>{
    if (over) return;
    let spec;
    try { spec = JSON.parse(body).hotkey; } catch (e) { return send(400, { ok:false, error:'无效的请求' }); }
    if (typeof spec !== 'string' || !HOTKEY_RE.test(spec.trim())) {
      return send(400, { ok:false, error:'热键格式不合法，需形如 Ctrl+Alt+A' });
    }
    spec = spec.trim();

    const ini = path.join(ROOT, 'hotkey.ini');
    let content;
    try {
      content = fs.existsSync(ini) ? fs.readFileSync(ini, 'utf8') : '';
    } catch (e) {
      return send(500, { ok:false, error:'读取 hotkey.ini 失败：' + e.message });
    }
    if (!content) {
      content = [
        '# AI 截图助手 - 全局热键配置',
        'Hotkey = Ctrl+Alt+A',
        'Mode = region',
        'Url = http://127.0.0.1:8787/ai-capture-assistant.html',
        ''
      ].join('\n');
    }
    // 有 Hotkey 行就替换，没有就追加
    if (/^\s*Hotkey\s*=.*$/im.test(content)) {
      content = content.replace(/^\s*Hotkey\s*=.*$/im, 'Hotkey = ' + spec);
    } else {
      content += '\nHotkey = ' + spec + '\n';
    }
    const tmp = ini + '.tmp' + process.pid;
    fs.writeFile(tmp, content, 'utf8', (wErr)=>{
      if (wErr) return send(500, { ok:false, error:'写入失败：' + wErr.message });
      fs.rename(tmp, ini, (rErr)=>{
        if (rErr) { try { fs.unlinkSync(tmp); } catch (e) {} return send(500, { ok:false, error: rErr.message }); }
        console.log('[热键] 已更新为 ' + spec);
        send(200, { ok:true, hotkey: spec });
      });
    });
  });
}

/*
 * 截图投递中转站。
 * 本地热键脚本截完图后 POST 到这里，已打开着的网页轮询 GET 取走并自动翻译。
 * 这样"按快捷键截图 → 网页出译文"可以连起来，不用手动拖图片。
 *
 * 只保留最近一张，且带时效：拿走后立刻清空，避免网页反复拿到同一张图。
 */
let pendingShot = null;   // { dataUrl, ts }
const SHOT_TTL = 30000;   // 30 秒内有效

function handleShotPost(req, res){
  const send = (code, obj)=>{
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (req.method !== 'POST') return send(405, { ok:false, error:'method not allowed' });

  const chunks = [];
  let size = 0, over = false;
  const MAX = 40 * 1024 * 1024;          // 高分辨率截图可能较大
  req.on('data', (c)=>{
    if (over) return;
    size += c.length;
    if (size > MAX){ over = true; send(413, { ok:false, error:'图片过大' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('error', ()=>{ over = true; });
  req.on('end', ()=>{
    if (over) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (e) { return send(400, { ok:false, error:'无效的 JSON' }); }
    const dataUrl = body && body.image;
    // 只接受 data:image/... 形式，杜绝写入任意内容
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)){
      return send(400, { ok:false, error:'image 必须是 data:image/... 的 base64' });
    }
    pendingShot = { dataUrl: dataUrl, ts: Date.now() };
    console.log('[截图] 收到一张截图 (' + Math.round(dataUrl.length/1024) + ' KB)');
    send(200, { ok:true });
  });
}

function handleShotGet(req, res){
  const send = (obj)=>{
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  // 取出即清空：保证一张图只被消费一次
  if (pendingShot && Date.now() - pendingShot.ts < SHOT_TTL){
    const d = pendingShot.dataUrl;
    pendingShot = null;
    return send({ ok:true, image: d });
  }
  if (pendingShot) pendingShot = null;   // 过期丢弃
  send({ ok:true, image: null });
}


const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(url.parse(req.url).pathname || '/');
  } catch (e) {
    res.writeHead(400); res.end('Bad Request'); return;
  }

  // 语言包落盘：前端从 CDN 抓到 .traineddata.gz 后回传，存进 tessdata/。
  // 存下来之后 OCR 走同源读取，断网也能用（前端 fetch 同源不触发 CORS）。
  if (pathname === '/api/save-tessdata') {
    handleSaveTessdata(req, res);
    return;
  }

  // 全局热键配置：网页改完写进 hotkey.ini
  if (pathname === '/api/hotkey') {
    handleHotkeyConfig(req, res);
    return;
  }

  // 截图投递：本地截图脚本放到这里，已打开的网页取走去翻译
  if (pathname === '/api/shot') {
    if (req.method === 'POST') handleShotPost(req, res);
    else handleShotGet(req, res);
    return;
  }

  if (pathname === '/') pathname = '/ai-capture-assistant.html';

  // 目录穿越防护：解析后必须仍在 ROOT 之内
  const target = path.normalize(path.join(ROOT, pathname));
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + pathname);
      return;
    }
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    // 关掉缓存，改完 HTML 刷新就能看到最新效果
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(target);
    stream.on('error', () => { try { res.destroy(); } catch (e) {} });
    stream.pipe(res);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[错误] 端口 ${PORT} 已被占用。请换一个端口：node serve.js 8792`);
  } else {
    console.error('[错误] 服务启动失败：', e.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('============================================');
  console.log('  AI 截屏录屏助手 - 本地服务已启动');
  console.log('============================================');
  console.log(`  访问地址: http://${HOST}:${PORT}/ai-capture-assistant.html`);
  console.log(`  服务目录: ${ROOT}`);
  console.log('');
  console.log('  关闭本窗口即可停止服务。');
});
