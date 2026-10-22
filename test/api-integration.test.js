/* /api 接口集成测试
 * 运行：node test/api-integration.test.js
 *
 * 前面的单元测试只覆盖了正则和纯函数，但接口是否真的按预期工作
 * （状态码、返回体、方法限制、输入校验）此前完全没有验证。
 *
 * 做法：起一个临时 serve.js 实例（用 0 让系统分配空闲端口，避免和
 * 正在跑的服务撞端口），再发真实 HTTP 请求。全程只读，不修改仓库里的
 * hotkey.ini 与 tessdata/。
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const SERVE = path.join(__dirname, '..', 'serve.js');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    failures.push({ name, expected: e, actual: a });
  }
}

function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
      timeout: 5000,
      headers: Object.assign({}, headers || {})
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    if (body) req.write(body);
    req.end();
  });
}

function waitForServer(port, tries) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, () => {
        resolve();
      });
      req.on('error', () => {
        if (++n >= tries) return reject(new Error('服务启动超时'));
        setTimeout(tick, 200);
      });
      req.on('timeout', () => { req.destroy(); });
    };
    tick();
  });
}

(async () => {
  // 端口 0 = 让系统分配，避免与正在运行的服务冲突
  const child = spawn(process.execPath, [SERVE, '0', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('未从输出中解析到端口')), 8000);
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(timer); resolve(parseInt(m[1], 10)); }
    });
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('服务进程退出, code=' + code)); });
  });

  try {
    await waitForServer(port, 30);

    // ---- 页面 ----
    let r = await request(port, 'GET', '/ai-capture-assistant.html');
    check('首页返回 200', r.status, 200);
    check('首页带安全头', r.headers['x-frame-options'], 'DENY');
    check('首页带 nosniff', r.headers['x-content-type-options'], 'nosniff');
    check('首页是 HTML', /text\/html/.test(r.headers['content-type'] || ''), true);

    r = await request(port, 'GET', '/');
    check('根路径重定向到首页', r.status, 200);

    // ---- 静态资源 ----
    r = await request(port, 'GET', '/serve.js');
    check('静态 JS 可读', r.status, 200);
    check('静态 JS 也带安全头', r.headers['x-frame-options'], 'DENY');

    r = await request(port, 'GET', '/not-exist-file.xyz');
    check('不存在的文件返回 404', r.status, 404);
    check('404 也带安全头', r.headers['x-frame-options'], 'DENY');

    // ---- 目录穿越 ----
    r = await request(port, 'GET', '/../../../windows/win.ini');
    check('目录穿越被拦截', r.status !== 200, true);

    // ---- /api/shot ----
    r = await request(port, 'GET', '/api/shot');
    check('GET /api/shot 返回 200', r.status, 200);
    check('/api/shot 初始无图片', r.json && r.json.image, null);

    // 投递非法内容应被拒
    r = await request(port, 'POST', '/api/shot', JSON.stringify({ image: 'not-a-data-url' }),
      { 'Content-Type': 'application/json' });
    check('投递非法图片格式被拒', r.status, 400);

    // 投递合法图片应成功
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    r = await request(port, 'POST', '/api/shot', JSON.stringify({ image: 'data:image/png;base64,' + tinyPng }),
      { 'Content-Type': 'application/json' });
    check('投递合法图片成功', r.status, 200);
    check('投递返回 ok', r.json && r.json.ok, true);

    // 取出后应立即清空（一张图只消费一次）
    r = await request(port, 'GET', '/api/shot');
    check('投递后可取出', r.json && r.json.image ? r.json.image.slice(0, 22) : null, 'data:image/png;base64,');
    r = await request(port, 'GET', '/api/shot');
    check('取出后立即清空', r.json && r.json.image, null);

    // ---- /api/hotkey ----
    r = await request(port, 'GET', '/api/hotkey');
    check('GET /api/hotkey 方法不允许', r.status, 405);

    r = await request(port, 'POST', '/api/hotkey', JSON.stringify({ hotkey: 'rm -rf /' }),
      { 'Content-Type': 'application/json' });
    check('非法热键被拒', r.status, 400);

    r = await request(port, 'POST', '/api/hotkey', JSON.stringify({ hotkey: 'A' }),
      { 'Content-Type': 'application/json' });
    check('缺修饰键的热键被拒', r.status, 400);

    // ---- /api/save-tessdata ----
    r = await request(port, 'GET', '/api/save-tessdata?lang=eng');
    check('GET /api/save-tessdata 方法不允许', r.status, 405);

    r = await request(port, 'POST', '/api/save-tessdata?lang=../evil', 'x',
      { 'Content-Type': 'application/octet-stream' });
    check('语言包路径穿越被拒', r.status, 400);

    r = await request(port, 'POST', '/api/save-tessdata?lang=ENG', 'x',
      { 'Content-Type': 'application/octet-stream' });
    check('非法语言名被拒', r.status, 400);

  } finally {
    child.kill();
  }

  console.log('/api 接口集成测试');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  if (fail > 0) {
    console.log('');
    for (const f of failures) {
      console.log('  ✗ ' + f.name);
      console.log('    期望 ' + f.expected + '，实际 ' + f.actual);
    }
    process.exit(1);
  }
})().catch((e) => {
  console.error('集成测试异常:', e.message);
  process.exit(1);
});
