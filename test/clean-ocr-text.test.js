/* cleanOcrText 单元测试
 * 运行：node test/clean-ocr-text.test.js
 *
 * 覆盖的都是实际踩过坑的场景，不是凭空设想：
 *   - "7|朱子翔"  聊天界面左侧序号条被读成前缀
 *   - "總理已已授权" Tesseract 对中文偶发叠字
 *   - "Sett1ngs"   1 被认成 l/i 的混淆
 *   - "1. 第一项"  不能误删正常有序列表编号
 */
'use strict';
const { loadPureFunctions } = require('./load-functions');

const { cleanOcrText } = loadPureFunctions(['cleanOcrText']);

let pass = 0;
let fail = 0;
const failures = [];

function eq(input, expected, note) {
  const actual = cleanOcrText(input);
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    failures.push({
      input, expected, actual, note
    });
  }
}

// ---- 界面装饰前缀 ----
eq('7|朱子翔', '朱子翔', '序号条竖线前缀应剥离');
eq('3｜可惜了', '可惜了', '全角竖线同样处理');
eq('2¥本', '本', '货币符号前缀应剥离');

// ---- 叠字 ----
eq('總理已已授权', '總理已授权', '中文叠字应合并');
eq('已已已', '已', '多个叠字应压成一个');
eq('the the settings', 'the settings', '英文重复词应合并');

// ---- 混淆字符还原 ----
eq('Sett1ngs', 'Settings', '1→i 的词表还原');
eq('EditE', 'Edit', '词尾粘连字符应剥离');

// ---- 不应误伤 ----
eq('1. 第一项', '1. 第一项', '有序列表编号必须保留');
eq('5月3日', '5月3日', '日期中的数字必须保留');
eq('再 来 几 针', '再来几针', '中文逐字识别产生的空格应合并');

// ---- 边界 ----
eq('', '', '空串返回空串');
eq('   ', '', '纯空白返回空串');

// ---- 输出 ----
console.log('cleanOcrText 测试');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) {
  console.log('');
  for (const f of failures) {
    console.log('  ✗ ' + (f.note || ''));
    console.log('    输入   : ' + JSON.stringify(f.input));
    console.log('    期望   : ' + JSON.stringify(f.expected));
    console.log('    实际   : ' + JSON.stringify(f.actual));
  }
  process.exit(1);
}
