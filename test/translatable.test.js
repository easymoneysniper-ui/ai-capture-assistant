/* isTranslatableText 与 estimateOriginalFontSize 单元测试
 * 运行：node test/translatable.test.js
 *
 * isTranslatableText 决定"一段 OCR 文本值不值得送去翻译"。
 * 判错的代价是双向的：
 *   - 该拦没拦 → 用户看到乱码译文（"IIl1O0" 被硬翻）
 *   - 该放没放 → 正常内容被静默丢弃（"Hello World 123" 被当噪声）
 * 后者更危险，因为用户不会察觉"少翻了什么"。
 */
'use strict';
const { loadPureFunctions } = require('./load-functions');

const { isTranslatableText, estimateOriginalFontSize } =
  loadPureFunctions(['isTranslatableText', 'estimateOriginalFontSize']);

let pass = 0;
let fail = 0;
const failures = [];

function check(name, actual, expected) {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    failures.push({ name, expected, actual });
  }
}

// ---- 应当保留 ----
const keep = [
  ['Hello World 123', '含数字但每词正常，不能当噪声'],
  ['Crash 404 error', '带状态码的正常句子'],
  ['A4 paper', '型号 + 单词'],
  ['Version 2.0', '版本号'],
  ['Settings', '普通单词'],
  ['你好', '中文'],
  ['OK', '短但正常'],
];
for (const [text, note] of keep) {
  check(note + ' | ' + text, isTranslatableText(text), true);
}

// ---- 应当拦掉 ----
const drop = [
  ['IIl1O0', '易混字符拼成的噪声串'],
  ['1O0l', '同上'],
  ['x1y2', '字母数字混杂无元音'],
  ['12345', '纯数字'],
  ['——＝≡', '纯符号'],
  ['A', '孤立单字母'],
  ['', '空串'],
];
for (const [text, note] of drop) {
  check(note + ' | ' + text, isTranslatableText(text), false);
}

// ---- 字号估算 ----
// 只验证边界行为，不锁死具体像素值：公式微调时测试不该失败
const boxTall = { x0: 0, x1: 200, y0: 0, y1: 24 };
check('空文本返回 0', estimateOriginalFontSize('', boxTall), 0);
check('估算值不超过框高', estimateOriginalFontSize('Hello World', boxTall) <= 24, true);
check('估算值为正数', estimateOriginalFontSize('Hello World', boxTall) > 0, true);
check('窄框字号更小',
  estimateOriginalFontSize('Hello World', { x0: 0, x1: 100, y0: 0, y1: 24 }) <
  estimateOriginalFontSize('Hello World', boxTall),
  true
);

console.log('isTranslatableText / estimateOriginalFontSize 测试');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) {
  console.log('');
  for (const f of failures) {
    console.log('  ✗ ' + f.name);
    console.log('    期望 ' + f.expected + '，实际 ' + f.actual);
  }
  process.exit(1);
}
