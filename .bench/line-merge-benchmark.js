/* 行归并算法 A/B 对照基准
 *
 * 用途：验证 mergeWordBoxes 的两次重构（中线基准 + OCR 原始词序）是否真的
 * 修正了错行问题，而不是主观感觉"好像好点了"。
 *
 * 原理：同一份 OCR 词框，分别用「改造前」和「改造后」两个函数归并，
 * 再与人工标注的标准答案比对，按行计算命中率。
 *
 * 用法：
 *   1. 启动本地服务   node serve.js 8787
 *   2. 运行基准       node .bench/line-merge-benchmark.js
 *      （若服务不是 8787，用 BASE=http://127.0.0.1:端口 覆盖）
 *   3. 结果写入       .bench/final-report.txt
 *
 * 依赖：本机已安装 Edge（用于跑真实 Tesseract 识别）。
 * 说明：样本量为 3 张图 / 13 行，属于回归验证而非学术评测，
 *       用于确保这次重构没有引入回退，不作为普适准确率声明。
 */
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const PORT = 9486;
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
function get(u){ return new Promise((res,rej)=>{ http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej); }); }
const sleep = ms => new Promise(r=>setTimeout(r,ms));

const OLD_SRC = `
function mergeOldImpl(words){
  var items = (words||[]).filter(function(w){
    return w && w.bbox && w.text && w.text.trim() && (w.conf==null || w.conf>=25);
  });
  if(!items.length) return [];
  var sorted = items.slice().sort(function(a,b){
    return (a.bbox.y0-b.bbox.y0) || (a.bbox.x0-b.bbox.x0);
  });
  var lines = [];
  var hOf = function(b){ return Math.max(1, b.y1-b.y0); };
  for(var si=0; si<sorted.length; si++){
    var w = sorted[si];
    var b = w.bbox, h = hOf(b), cy = (b.y0+b.y1)/2;
    var target = null;
    for(var li=0; li<lines.length; li++){
      var ln = lines[li];
      var ov = Math.min(b.y1, ln.box.y1) - Math.max(b.y0, ln.box.y0);
      if(ov > 0.4*Math.min(h, hOf(ln.box)) &&
         Math.abs(cy - (ln.box.y0+ln.box.y1)/2) < 0.6*Math.max(h, hOf(ln.box))){
        target = ln; break;
      }
    }
    if(target){
      target.words.push(w);
      target.box = {
        x0:Math.min(target.box.x0,b.x0), y0:Math.min(target.box.y0,b.y0),
        x1:Math.max(target.box.x1,b.x1), y1:Math.max(target.box.y1,b.y1)
      };
    }else{
      lines.push({ box:{x0:b.x0,y0:b.y0,x1:b.x1,y1:b.y1}, words:[w] });
    }
  }
  for(var k=0; k<lines.length; k++){
    var L = lines[k];
    L.words.sort(function(a,b){ return a.bbox.x0 - b.bbox.x0; });
    var text = '';
    for(var i=0;i<L.words.length;i++){
      var t = L.words[i].text.trim();
      if(i>0){
        var prev = L.words[i-1].text.trim();
        var gap = L.words[i].bbox.x0 - L.words[i-1].bbox.x1;
        var cjk = /[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff]$/.test(prev);
        if(!cjk && gap > 0.28*hOf(L.box)) text += ' ';
      }
      text += t;
    }
    L.text = text.trim();
    L.conf = L.words.length ? L.words.reduce(function(a,x){return a+(x.conf||0);},0)/L.words.length : 0;
  }
  return lines.filter(function(l){ return l.text && l.conf >= 45; });
}
window.mergeOldImpl = mergeOldImpl;
`;

const CASES = [
  {
    name: '聊天界面（小字姓名 15px + 正文 19px 交替）',
    expect: ['朱子翔', '再来几针我就摔了', '朱子翔', '这个亭子还记得吗', '朱子翔', '可惜了'],
    lang: 'chi_sim',
    draw: `
      cv.width=560; cv.height=460;
      c.fillStyle='#12151c'; c.fillRect(0,0,560,460);
      c.fillStyle='#7d8fa8'; c.font='15px Microsoft YaHei,sans-serif';
      c.fillText('朱子翔', 80, 44);
      c.fillStyle='#e8eaed'; c.font='19px Microsoft YaHei,sans-serif';
      c.fillText('再来几针我就摔了', 80, 78);
      c.fillStyle='#7d8fa8'; c.font='15px Microsoft YaHei,sans-serif';
      c.fillText('朱子翔', 80, 164);
      c.fillStyle='#e8eaed'; c.font='19px Microsoft YaHei,sans-serif';
      c.fillText('这个亭子还记得吗', 80, 198);
      c.fillStyle='#7d8fa8'; c.font='15px Microsoft YaHei,sans-serif';
      c.fillText('朱子翔', 80, 284);
      c.fillStyle='#e8eaed'; c.font='19px Microsoft YaHei,sans-serif';
      c.fillText('可惜了', 80, 318);
    `
  },
  {
    name: '设置页（标题 26px + 标签 20px 混排）',
    expect: ['隐私与安全', '管理应用权限与数据共享', '清除本地缓存记录', '导出个人数据副本'],
    lang: 'chi_sim',
    draw: `
      cv.width=760; cv.height=280;
      c.fillStyle='#ffffff'; c.fillRect(0,0,760,280);
      c.fillStyle='#111'; c.font='bold 26px Microsoft YaHei,sans-serif';
      c.fillText('隐私与安全', 36, 58);
      c.font='20px Microsoft YaHei,sans-serif'; c.fillStyle='#555';
      c.fillText('管理应用权限与数据共享', 36, 108);
      c.fillText('清除本地缓存记录', 36, 148);
      c.fillText('导出个人数据副本', 36, 188);
    `
  },
  {
    name: '英文段落（粗标题 + 常规正文）',
    expect: ['Product Overview', 'This device supports wireless', 'connectivity and battery life'],
    lang: 'eng',
    draw: `
      cv.width=760; cv.height=220;
      c.fillStyle='#ffffff'; c.fillRect(0,0,760,220);
      c.fillStyle='#111'; c.font='bold 26px Arial';
      c.fillText('Product Overview', 40, 56);
      c.font='20px Arial'; c.fillStyle='#444';
      c.fillText('This device supports wireless', 40, 112);
      c.fillText('connectivity and battery life', 40, 146);
    `
  },
];

function norm(s){ return String(s||'').replace(/[\s\p{P}\p{S}]+/gu,'').toLowerCase(); }

function score(actual, expect){
  const got = actual.map(norm).filter(Boolean);
  const want = expect.map(norm);
  let hit=0; const detail=[];
  for(const w of want){
    const i = got.indexOf(w);
    if(i>=0){ hit++; got.splice(i,1); detail.push(`✓ ${w}`); }
    else detail.push(`✗ ${w}  → ${actual.find(a=>norm(a).includes(w.slice(0,2))) || '缺失'}`);
  }
  return { hit, total: want.length, detail };
}

(async()=>{
  const prof = path.join(process.env.TEMP,'fin-'+Date.now());
  const ch = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port='+PORT,'--user-data-dir='+prof,'about:blank'],{stdio:'ignore'});
  let ws,id=0; const pending=new Map();
  const send=(m,p={})=>new Promise((r,j)=>{ const i=++id; pending.set(i,{res:r,rej:j}); ws.send(JSON.stringify({id:i,method:m,params:p})); });
  try{
    let t=null;
    for(let i=0;i<40;i++){ try{ const l=await get(`http://127.0.0.1:${PORT}/json/list`); t=(l||[]).find(x=>x.type==='page'&&x.webSocketDebuggerUrl); if(t)break; }catch(e){} await sleep(250); }
    ws=new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r,j)=>{ ws.onopen=r; ws.onerror=j; });
    ws.onmessage=e=>{ const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){ const{res,rej}=pending.get(m.id); pending.delete(m.id); m.error?rej(new Error(JSON.stringify(m.error))):res(m.result); } };
    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.navigate',{url:BASE+'/ai-capture-assistant.html'});
    await sleep(3500);
    await send('Runtime.evaluate',{expression:`(async function(){ for(let i=0;i<60 && !window.Tesseract;i++) await new Promise(r=>setTimeout(r,500)); return !!window.Tesseract; })()`,awaitPromise:true,returnByValue:true});
    await send('Runtime.evaluate',{expression: OLD_SRC, returnByValue:true});

    const results=[];
    for(const cs of CASES){
      const expr = `
        (async function(){
          const cv=document.createElement('canvas');
          const c=cv.getContext('2d');
          ${cs.draw}
          // 跑 3 次，取一致结果（避免单次抖动）
          const runs=[];
          for(let i=0;i<3;i++){
            const w = await ocrWithLang(cv, ${JSON.stringify(cs.lang)}, {maxSide:1600, retryInverted:false, recoverMissing:false});
            runs.push({
              old: window.mergeOldImpl(w.words).map(function(l){return l.text;}),
              neu: mergeWordBoxes(w.words, cv.width).map(function(l){return l.text;})
            });
          }
          return runs;
        })()
      `;
      const r = await send('Runtime.evaluate',{expression:expr, awaitPromise:true, returnByValue:true});
      if(r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      results.push({ name: cs.name, runs: r.result.value, expect: cs.expect });
    }

    const L=[];
    L.push('='.repeat(78));
    L.push('行归并 A/B 对照（每图跑 3 次）');
    L.push('='.repeat(78));
    let oh=0,nh=0,tot=0;
    for(const r of results){
      L.push('');
      L.push(`【${r.name}】`);
      const first = r.runs[0];
      const so = score(first.old, r.expect);
      const sn = score(first.neu, r.expect);
      L.push(`  旧算法 ${so.hit}/${so.total}   实际: ${JSON.stringify(first.old)}`);
      so.detail.filter(d=>d.startsWith('✗')).forEach(d=>L.push('     ' + d));
      L.push(`  新算法 ${sn.hit}/${sn.total}   实际: ${JSON.stringify(first.neu)}`);
      sn.detail.filter(d=>d.startsWith('✗')).forEach(d=>L.push('     ' + d));
      // 稳定性
      const oldStable = new Set(r.runs.map(x=>JSON.stringify(x.old))).size;
      const newStable = new Set(r.runs.map(x=>JSON.stringify(x.neu))).size;
      L.push(`  3次结果差异数: 旧 ${oldStable} 种 / 新 ${newStable} 种`);
      oh+=so.hit; nh+=sn.hit; tot+=so.total;
    }
    L.push('');
    L.push('='.repeat(78));
    L.push(`合计    旧 ${oh}/${tot}    新 ${nh}/${tot}`);
    L.push(`准确率  旧 ${(oh/tot*100).toFixed(1)}%  →  新 ${(nh/tot*100).toFixed(1)}%   (+${((nh-oh)/tot*100).toFixed(1)}pp)`);
    L.push('='.repeat(78));

    const txt=L.join('\n');
    fs.writeFileSync(path.join(__dirname,'final-report.txt'), txt, 'utf-8');
    console.log(txt);
  } finally { try{ ws&&ws.close(); }catch(e){} try{ ch.kill(); }catch(e){} }
})().catch(e=>{ console.error('失败:', e.message); process.exit(1); });
