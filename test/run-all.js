/* 运行全部单元测试
 * 用法：node test/run-all.js
 *
 * 项目零依赖，不需要 npm install，也不需要任何测试框架。
 * 每个测试文件自身就是一个 Node 脚本，成功退出码 0、失败非 0。
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.test.js'))
  .sort();

if (!files.length) {
  console.error('没有找到任何 *.test.js');
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  console.log('');
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed++;
    console.log('  [失败] ' + f);
  }
}

console.log('');
console.log('='.repeat(50));
if (failed === 0) {
  console.log('全部测试通过（' + files.length + ' 个测试文件）');
  process.exit(0);
} else {
  console.log(failed + ' / ' + files.length + ' 个测试文件失败');
  process.exit(1);
}
