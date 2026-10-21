/* 从 ai-capture-assistant.html 中抽取指定纯函数，供单元测试使用。
 *
 * 为什么需要这个加载器：项目是单文件 HTML，业务逻辑都内联在 <script> 里，
 * 没法直接 require。但 cleanOcrText / isTranslatableText /
 * estimateOriginalFontSize 这几个函数不碰 DOM、不碰浏览器 API，
 * 是纯字符串/数值计算，完全可以脱离浏览器测试。
 *
 * 做法：按名字定位函数起始行，用花括号配平找到结束行，取出源码后
 * 用 new Function 求值。这样测试跑的是"页面里真正在用的那份代码"，
 * 而不是复制一份容易和实现走散的副本。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'ai-capture-assistant.html');

function extractFn(lines, name) {
  const start = lines.findIndex(l => l.startsWith('function ' + name + '('));
  if (start < 0) throw new Error('在 ai-capture-assistant.html 中找不到函数: ' + name);

  let depth = 0;
  let started = false;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; }
    }
    if (started && depth === 0) break;
  }
  if (depth !== 0) throw new Error('函数 ' + name + ' 的花括号不配平，HTML 可能损坏');
  return out.join('\n');
}

/**
 * 加载指定的一组纯函数。
 * @param {string[]} names 函数名列表
 * @returns {Object} 以函数名为键的对象
 */
function loadPureFunctions(names) {
  const lines = fs.readFileSync(HTML, 'utf8').split(/\r?\n/);
  const src = names.map(n => extractFn(lines, n)).join('\n\n');
  const factory = new Function(src + '\nreturn {' + names.join(',') + '};');
  return factory();
}

module.exports = { loadPureFunctions };
