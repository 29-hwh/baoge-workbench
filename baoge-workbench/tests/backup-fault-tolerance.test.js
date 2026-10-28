/* 宝哥工作台 · 导入导出 容错机制测试 */
/* 覆盖：文件格式校验 / 字段缺失 / 类型错误 / 非法值 / 跳过并汇总 / 失败回滚 /
        空数据导出 / 写入重试与读回校验 / 降级 / 日志 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const U = p => path.join(ROOT, p);

const store = {};
let fsMock = null;
let clipboard = '';
const toasts = [];
const modals = [];
const wx = {
  env: { USER_DATA_PATH: '/tmp' },
  getStorageSync(k) { return store[k]; },
  setStorageSync(k, v) { store[k] = v; },
  removeStorageSync(k) { delete store[k]; },
  showToast(o) { toasts.push(o); },
  showModal(o) { modals.push(o); },
  setClipboardData(o) { clipboard = o.data; if (o.success) o.success(); },
  getClipboardData(o) { o.success({ data: clipboard }); },
  getFileSystemManager() { return fsMock; }
};
global.wx = wx;
global.getApp = () => ({ globalData: { cloudSync: false } });

const storage = require(U('utils/storage'));
const backup = require(U('utils/backup'));
const guard = require(U('utils/backupGuard'));

let passCount = 0, failCount = 0;
function rec(s) { console.log('  ' + s); }
function ok(c, m) {
  if (c) { passCount++; rec('  [ok] ' + m); return true; }
  failCount++; console.error('  [X] ' + m); return false;
}
function section(t) { console.log('\n' + '='.repeat(70) + '\n' + t + '\n' + '='.repeat(70)); }
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function resetAll() { backup.DATA_KEYS.forEach(k => storage.set(k, [])); }
function snapOf(data, extra) {
  const s = { app: 'baoge-workbench', version: 1, data: data };
  if (extra) Object.keys(extra).forEach(k => { s[k] = extra[k]; });
  return s;
}
function snapshotOfStore() {
  const o = {};
  backup.DATA_KEYS.forEach(k => { o[k] = JSON.parse(JSON.stringify(storage.list(k))); });
  return o;
}

// ==================== 一、文件格式校验（失败即整体拒绝，不动数据） ====================
function stageFileFormat() {
  section('一、文件格式校验：损坏/非本应用/缺 data 一律整体拒绝');
  resetAll();
  storage.set('books', [{ _id: 'keep1', title: '原有书' }]);
  const before = snapshotOfStore();

  const cases = [
    { name: '截断的 JSON', text: '{ "app": "baoge-workbench", "data": ' },
    { name: '完全不是 JSON', text: '这不是备份' },
    { name: '空内容', text: '' },
    { name: 'JSON 但不是对象', text: '[1,2,3]' }
  ];
  cases.forEach(c => {
    let msg = '';
    try { backup.importSnapshotText(c.text); } catch (e) { msg = e.message; }
    ok(msg.length > 0, c.name + ' -> 明确报错：' + msg);
  });

  let msg = '';
  try { backup.importSnapshotText(JSON.stringify({ app: 'other-app', data: {} })); }
  catch (e) { msg = e.message; }
  ok(msg.indexOf('宝哥工作台') >= 0, '非本应用备份被拒绝：' + msg);

  msg = '';
  try { backup.importSnapshotText(JSON.stringify({ app: 'baoge-workbench' })); }
  catch (e) { msg = e.message; }
  ok(msg.indexOf('data') >= 0, '缺少 data 字段被拒绝：' + msg);

  ok(deepEq(snapshotOfStore(), before), '以上所有失败均未改动任何本地数据（拒绝即不动数据）');
}

// ==================== 二、记录级异常：跳过 + 汇总，不中断整批 ====================
function stageSkipAndReport() {
  section('二、异常记录：跳过并汇总，整批继续');
  resetAll();
  const r = backup.applySnapshotObject(snapOf({
    books: ['非法字符串', 42, null, true, { _id: 'b1', title: '正常的书' }]
  }));
  ok(r.applied.books === 1, '4 条非对象记录被跳过，1 条合法记录保留');
  ok(r.totalSkipped === 4, '跳过计数正确（skipped=' + r.totalSkipped + '）');
  ok(r.issues.some(i => i.code === 'NOT_OBJECT'), '跳过原因记入 issues 汇总');
  ok(r.issues.every(i => i.msg && i.msg.length > 0), '每条 issue 都有可读的错误提示');
  ok(deepEq(storage.list('books').map(b => b.title), ['正常的书']), '落库结果只剩合法记录');
}

// ==================== 三、字段缺失 / 类型错误 / 非法值 ====================
function stageFieldIssues() {
  section('三、字段缺失 / 类型错误 / 非法值：能修就修，修不了告警');
  resetAll();

  // 3.1 缺失必填字段：只告警，不臆造默认值
  const r1 = backup.applySnapshotObject(snapOf({
    todos: [{ _id: 't1', date: '2026-01-01' }]
  }));
  ok(r1.issues.some(i => i.code === 'MISSING_REQUIRED'), '缺失必填字段 title 被记为 MISSING_REQUIRED');
  ok(storage.list('todos')[0].title === undefined, '缺失必填字段不臆造默认值（保持原样）');
  ok(r1.applied.todos === 1, '该记录仍被导入（不因缺字段整条丢弃）');

  // 3.2 类型错误纠正
  resetAll();
  const r2 = backup.applySnapshotObject(snapOf({
    books: [{ _id: 'b1', title: 123, records: '不是数组', autoTodo: 'yes' }]
  }));
  const b = storage.list('books')[0];
  ok(b.title === '123', '数字 title 被纠正为字符串「123」');
  ok(Array.isArray(b.records) && b.records.length === 0, '非数组的 records 被纠正为空数组');
  ok(b.autoTodo === true, '字符串 autoTodo 被纠正为布尔 true');
  ok(r2.totalRepaired === 1, '该条被记为已修复（repaired=' + r2.totalRepaired + '）');

  // 3.3 非法值收敛到合法区间
  resetAll();
  backup.applySnapshotObject(snapOf({
    books: [{ _id: 'b1', title: '进度异常', progressPercent: 500 }],
    bookRead: [{ _id: 'r1', title: '评分异常', rating: 99 }],
    body: [{ _id: 'y1', date: '2026-01-01', weight: -20 }]
  }));
  ok(storage.list('books')[0].progressPercent === 100, '进度 500% 收敛为 100');
  ok(storage.list('bookRead')[0].rating === 5, '评分 99 收敛为 5');
  ok(storage.list('body')[0].weight === 1, '体重 -20 收敛为下限 1');

  // 3.4 非法枚举值
  resetAll();
  backup.applySnapshotObject(snapOf({
    todos: [{ _id: 't1', title: '来源异常', date: '2026-01-01', source: 'unknown-source' }]
  }));
  ok(storage.list('todos')[0].source === 'manual', '非法 source 被置为默认值 manual');

  // 3.5 _id 缺失 / 重复 自动修复
  resetAll();
  const r5 = backup.applySnapshotObject(snapOf({
    books: [{ title: '没有 id' }, { _id: 'dup', title: 'A' }, { _id: 'dup', title: 'B' }]
  }));
  const ids = storage.list('books').map(x => x._id);
  ok(ids.length === 3 && ids.every(x => typeof x === 'string' && x.length > 0), '3 条记录都有非空字符串 _id');
  ok(new Set(ids).size === 3, '重复 _id 已被重新生成，列表内唯一');
  ok(r5.issues.some(i => i.code === 'ID_INVALID'), '缺失 _id 记为 ID_INVALID');
  ok(r5.issues.some(i => i.code === 'ID_DUPLICATE'), '重复 _id 记为 ID_DUPLICATE');
}

// ==================== 四、分组级异常 + 校验和 ====================
function stageKeyLevel() {
  section('四、分组级异常与校验和');
  resetAll();
  storage.set('todos', [{ _id: 'keep', title: '原待办', date: '2026-01-01', source: 'manual', done: false }]);
  const r = backup.applySnapshotObject(snapOf({ todos: 'not-an-array' }));
  ok(r.warnings.some(w => w.code === 'KEY_NOT_ARRAY'), '非数组分组被跳过并告警');
  ok(storage.list('todos').length === 1, '被跳过的分组保留原有数据，未被清空');

  resetAll();
  storage.set('templates', [{ _id: 'tp', name: '我的模板' }]);
  const r2 = backup.applySnapshotObject(snapOf({ books: [] }));
  ok(r2.skippedKeys.indexOf('templates') >= 0, '老备份缺少的表记为 skippedKeys');
  ok(storage.list('templates').length === 1, '缺失表的原有数据被保留（不误清空）');

  resetAll();
  const snap = backup.buildSnapshot();
  snap.data.books.push({ _id: 'tampered', title: '注入的脏数据' });
  const r3 = backup.applySnapshotObject(snap);
  ok(r3.warnings.some(w => w.code === 'CHECKSUM_MISMATCH'), '内容被篡改/截断时校验和检出并告警');
  ok(r3.checksumOk === false, '报告 checksumOk=false');
  ok(Array.isArray(r3.logTail), '报告附带最近日志（logTail）便于排查');
}

// ==================== 五、写入失败回滚 ====================
function stageRollback() {
  section('五、写入失败回滚：绝不留半截状态');
  resetAll();
  backup.DATA_KEYS.forEach(k => storage.set(k, [{ _id: 'cur_' + k, title: '导入前-' + k }]));
  const before = snapshotOfStore();

  const snap = snapOf({});
  backup.DATA_KEYS.forEach(k => { snap.data[k] = [{ _id: 'new_' + k, title: '导入后-' + k }]; });

  // 只让第一次写 workouts 抛错（保证回滚阶段能正常写回）
  const orig = wx.setStorageSync;
  let thrown = false;
  wx.setStorageSync = function (k, v) {
    if (k === storage.KEYS.workouts && !thrown) { thrown = true; throw new Error('磁盘写入失败'); }
    orig(k, v);
  };
  let msg = '';
  try { backup.applySnapshotObject(snap); } catch (e) { msg = e.message; }
  wx.setStorageSync = orig;

  ok(msg.length > 0, '写入失败时抛出异常：' + msg);
  ok(msg.indexOf('回滚') >= 0, '错误提示明确说明已回滚');
  ok(deepEq(snapshotOfStore(), before), '回滚后全部数据恢复到导入前状态');
  ok(backup.getLog().some(e => e.code === 'IMPORT_ROLLBACK'), '回滚事件已记入日志');
}

// ==================== 六、导出容错：空数据 ====================
function stageExportEmpty() {
  section('六、导出容错：空数据');
  resetAll();
  let text = '', err = '';
  try { text = backup.snapshotToText(); } catch (e) { err = e.message; }
  ok(err === '' && text.length > 0, '空数据仍能正常导出（不阻断）');
  const snap = JSON.parse(text);
  ok(typeof snap.checksum === 'string', '空快照同样带 checksum');
  ok(backup.getLog().some(e => e.code === 'EMPTY_DATA'), '空数据写入 EMPTY_DATA 告警日志');
}

// ==================== 七、导出容错：写入重试 + 读回校验 ====================
function stageExportRetry() {
  section('七、导出容错：写入重试 + 读回校验 + 降级');
  let calls = 0, stored = '';
  const fs1 = {
    writeFileSync(p, d) { calls++; if (calls <= 2) throw new Error('EBUSY'); stored = d; },
    readFileSync() { return stored; }
  };
  const r1 = backup.writeFileWithRetry(fs1, '/tmp/a.json', 'hello', 3);
  ok(r1.ok === true && r1.attempts === 3, '前 2 次失败后第 3 次成功（attempts=' + r1.attempts + '）');

  const fs2 = { writeFileSync() { throw new Error('ENOSPC'); }, readFileSync() { return ''; } };
  const r2 = backup.writeFileWithRetry(fs2, '/tmp/b.json', 'hello', 3);
  ok(r2.ok === false && r2.attempts === 3, '连续失败时耗尽重试次数并返回失败');

  const fs3 = { writeFileSync() {}, readFileSync() { return 'truncated'; } };
  const r3 = backup.writeFileWithRetry(fs3, '/tmp/c.json', 'hello', 3);
  ok(r3.ok === false, '读回内容不一致（文件不完整）判定为失败');

  // 整体降级：写文件始终失败 -> 剪贴板
  resetAll();
  storage.set('books', [{ _id: 'b1', title: '有数据' }]);
  fsMock = { writeFileSync() { throw new Error('ENOSPC'); }, readFileSync() { return ''; } };
  clipboard = '';
  return backup.exportAndShare({ tries: 2 }).then(res => {
    ok(res.channel === 'clipboard', '写文件失败时降级为剪贴板导出');
    ok(res.reason === 'write-failed', '降级原因标记为 write-failed');
    ok(clipboard.length > 0, '降级后剪贴板确实拿到完整备份文本');
    ok(res.warnings.length > 0, '降级原因写入 warnings 供上层提示用户');
  });
}

// 无文件系统能力时的降级
function stageExportNoFs() {
  fsMock = null;
  clipboard = '';
  return backup.exportAndShare({ tries: 1 }).then(res => {
    ok(res.channel === 'clipboard' && res.reason === 'no-fs', '无文件写入能力时降级剪贴板');
    ok(clipboard.length > 0, 'no-fs 场景也拿到了备份文本');
  });
}

// ==================== 执行 ====================
async function run() {
  stageFileFormat();
  stageSkipAndReport();
  stageFieldIssues();
  stageKeyLevel();
  stageRollback();
  stageExportEmpty();
  await stageExportRetry();
  await stageExportNoFs();

  section('结果汇总');
  rec('断言通过=' + passCount + ' 失败=' + failCount + ' 日志条数=' + backup.getLog().length);
  if (failCount === 0) { console.log('\nPASS: 导入导出容错机制全部通过'); process.exit(0); }
  console.error('\nFAIL: ' + failCount + ' 项未通过');
  process.exit(1);
}
run();
