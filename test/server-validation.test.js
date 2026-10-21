/* serve.js 输入校验测试
 * 运行：node test/server-validation.test.js
 *
 * serve.js 暴露了三个会"接收外部输入"的接口：
 *   POST /api/save-tessdata?lang=xxx   把语言包写到 tessdata/
 *   POST /api/hotkey                   把热键写进 hotkey.ini
 *   POST /api/shot                     暂存一张截图
 *
 * 前两个会落盘，所以输入校验一旦被削弱，就可能变成任意文件写入。
 * 这里直接测它们背后的正则——这两个正则就是防线本身。
 *
 * 做法与 load-functions.js 一致：从 serve.js 源码里按行抽取常量定义，
 * 跑的是线上真正生效的那两个正则，不是抄一份。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SERVE = path.join(__dirname, '..', 'serve.js');

function extractConst(name) {
  const text = fs.readFileSync(SERVE, 'utf8');
  // 形如：const XXX = /.../;   （单行定义）
  const re = new RegExp('^const ' + name + '\\s*=\\s*(/.*?/);\\s*$', 'm');
  const m = text.match(re);
  if (!m) throw new Error('在 serve.js 中找不到常量: ' + name);
  return new Function('return ' + m[1])();
}

const TESS_LANG_RE = extractConst('TESS_LANG_RE');
const HOTKEY_RE = extractConst('HOTKEY_RE');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, actual, expected) {
  if (actual === expected) pass++;
  else {
    fail++;
    failures.push({ name, expected, actual });
  }
}

// ============ 语言包名 ============
// 合法：Tesseract 的语言代码
for (const s of ['chi_sim', 'eng', 'jpn', 'kor', 'chi_tra', 'fra', 'osd']) {
  check('语言名放行 | ' + s, TESS_LANG_RE.test(s), true);
}

// 非法：这些一旦放行就能写出 tessdata/ 之外
const badLangs = [
  ['../evil', '目录穿越'],
  ['..', '上级目录'],
  ['chi_sim/..', '路径拼接'],
  ['%2e%2e', '编码后的穿越（未经解码时）'],
  ['a', '过短'],
  ['ENG', '大写不在白名单'],
  ['chi-sim', '连字符不允许'],
  ['chi sim', '空格不允许'],
  ['\n', '换行符'],
  ['a'.repeat(21), '超长'],
];
for (const [s, note] of badLangs) {
  check('语言名拦截 | ' + note + ' | ' + JSON.stringify(s), TESS_LANG_RE.test(s), false);
}

// ============ 热键串 ============
// 合法：修饰键 + 主键
const goodHotkeys = [
  ['Ctrl+Alt+S', '最常见组合'],
  ['Alt+F1', '功能键'],
  ['Ctrl+Shift+F9', '连按两次的 F 键'],
  ['Win+Alt+A', 'Win 键'],
  ['Ctrl+Alt+1', '数字键'],
  ['Ctrl+Alt+Shift+Z', '三个修饰键'],
];
for (const [s, note] of goodHotkeys) {
  check('热键放行 | ' + note + ' | ' + s, HOTKEY_RE.test(s), true);
}

// 非法：写进 ini 会破坏配置或注入内容
const badHotkeys = [
  ['A', '缺修饰键'],
  ['Ctrl', '只有修饰键'],
  ['Ctrl+', '结尾多余加号'],
  ['rm -rf /', '命令注入'],
  ['Ctrl+Alt+AA', '主键长度不对'],
  ['Ctrl+Alt+F13', '超出 F1-F12'],
  ['Ctrl+Alt+A B', '中间带空格'],
  ['ctrl+alt+s', '小写修饰键'],
];
for (const [s, note] of badHotkeys) {
  check('热键拦截 | ' + note + ' | ' + JSON.stringify(s), HOTKEY_RE.test(s), false);
}

console.log('serve.js 输入校验测试');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) {
  console.log('');
  for (const f of failures) {
    console.log('  ✗ ' + f.name);
    console.log('    期望 ' + f.expected + '，实际 ' + f.actual);
  }
  process.exit(1);
}
