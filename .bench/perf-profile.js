/* 翻译性能剖析：分阶段计时，定位瓶颈。
 *
 * 用法：
 *   node serve.js 8787
 *   node .bench/perf-profile.js
 *   （服务不在 8787 时用 BASE=http://127.0.0.1:端口 覆盖）
 *
 * 测三件事：
 *   1. 单次网络请求耗时（判断是否网络问题）
 *   2. 批量 vs 逐条的效率差
 *   3. 完整 translateTexts 流程耗时
 * 以及 OCR 耗时作对照，便于区分"翻译慢"和"识别慢"。
 */
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 9520;
const BASE = process.env.BASE || 'http://127.0.0.1:8787';

function get(u) { return new Promise((res, rej) => { http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const prof = path.join(process.env.TEMP, 'perf-' + Date.now());
  const ch = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });

  let ws, id = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((r, j) => { const i = ++id; pending.set(i, { res: r, rej: j }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });

  try {
    let t = null;
    for (let i = 0; i < 40; i++) { try { const l = await get(`http://127.0.0.1:${PORT}/json/list`); t = (l || []).find(x => x.type === 'page' && x.webSocketDebuggerUrl); if (t) break; } catch (e) { } await sleep(250); }
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: BASE + '/ai-capture-assistant.html' });
    await sleep(4000);
    await send('Runtime.evaluate', { expression: `(async function(){ for(let i=0;i<60 && !window.Tesseract;i++) await new Promise(r=>setTimeout(r,500)); return !!window.Tesseract; })()`, awaitPromise: true, returnByValue: true });

    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
      return r.result.value;
    };

    console.log('=== 1. 网络探测（单次请求耗时）===');
    const netProbe = await ev(`
      (async function(){
        const out = [];
        for(let i=0;i<3;i++){
          const t0 = performance.now();
          try{
            const r = await fetch('https://translate.googleapis.com/translate_a/single', {
              method:'POST',
              headers:{'Content-Type':'application/x-www-form-urlencoded;charset=utf-8'},
              body:'client=gtx&sl=en&tl=zh-CN&dt=t&q=hello'
            });
            const j = await r.json();
            out.push({ ms: Math.round(performance.now()-t0), ok: true, text: j[0][0][0] });
          }catch(e){
            out.push({ ms: Math.round(performance.now()-t0), ok: false, err: String(e.message).slice(0,60) });
          }
        }
        return out;
      })()
    `);
    console.log(JSON.stringify(netProbe, null, 2));

    console.log('\n=== 2. 批量 vs 逐条对比 ===');
    const batchTest = await ev(`
      (async function(){
        const texts = ['Account Settings','Save changes','Privacy policy','Clear cache',
                       'Export data','Delete account','Notification settings','About this app',
                       'Version 2.0','Terms of service','Privacy settings','Manage permissions'];
        // 批量
        const t1 = performance.now();
        let batchOk = false, batchErr = '';
        try{
          const parts = await gtTranslateBatch(texts, 'en', 'zh-CN');
          batchOk = parts.length === texts.length;
        }catch(e){ batchErr = String(e.message).slice(0,80); }
        const batchMs = Math.round(performance.now()-t1);

        // 逐条
        const t2 = performance.now();
        let oneCount = 0;
        for(const t of texts.slice(0,4)){   // 只测 4 条，避免太慢
          try{ await gtTranslateOne(t, 'en', 'zh-CN'); oneCount++; }catch(e){}
        }
        const oneMs = Math.round(performance.now()-t2);

        return { batchMs, batchOk, batchErr, onePerItemMs: oneCount ? Math.round(oneMs/oneCount) : null, oneCount };
      })()
    `);
    console.log(JSON.stringify(batchTest, null, 2));

    console.log('\n=== 3. 完整 translateTexts 计时 ===');
    const fullTest = await ev(`
      (async function(){
        const texts = ['Account Settings','Save changes','Privacy policy','Clear cache',
                       'Export data','Delete account','Notification settings','About this app'];
        const t0 = performance.now();
        let err = '';
        try{ await translateTexts(texts, {from:'en', to:'zh-CN', engine:'free'}); }
        catch(e){ err = String(e.message).slice(0,100); }
        return { ms: Math.round(performance.now()-t0), err };
      })()
    `);
    console.log(JSON.stringify(fullTest, null, 2));

    console.log('\n=== 4. OCR 耗时（对照）===');
    const ocrTest = await ev(`
      (async function(){
        const cv=document.createElement('canvas'); cv.width=720; cv.height=400;
        const c=cv.getContext('2d');
        c.fillStyle='#fff'; c.fillRect(0,0,720,400);
        c.fillStyle='#111'; c.font='24px Arial';
        for(let i=0;i<10;i++) c.fillText('Line '+(i+1)+' sample text here', 30, 50+i*34);
        const t0=performance.now();
        const w = await ocrWithLang(cv,'eng',{maxSide:1400,retryInverted:false,recoverMissing:false});
        return { ocrMs: Math.round(performance.now()-t0), wordCount: w.words.length };
      })()
    `);
    console.log(JSON.stringify(ocrTest, null, 2));

  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { ch.kill(); } catch (e) { }
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
