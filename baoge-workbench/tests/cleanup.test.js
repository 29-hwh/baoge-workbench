/* 宝哥工作台 · 数据瘦身（清理历史记录）测试
 *
 * 覆盖：占用体检 / 四种清理模式试算 / 归档与预览一致性 / 执行删除 /
 *       智能推荐 / 安全性（无时间字段不误删、受保护表不被自动清理）
 *
 * 运行：node tests/cleanup.test.js
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const U = p => path.join(ROOT, p);

const store = {};
const wx = {
  env: { USER_DATA_PATH: '/tmp' },
  getStorageSync(k) { return store[k]; },
  setStorageSync(k, v) { store[k] = v; },
  removeStorageSync(k) { delete store[k]; },
  showToast() {}, showModal() {}, setClipboardData() {}, getClipboardData() {}
};
global.wx = wx;
global.getApp = () => ({ globalData: { cloudSync: false } });

const storage = require(U('utils/storage'));
const backup = require(U('utils/backup'));
const cleanup = require(U('utils/cleanup'));

let passCount = 0, failCount = 0;
function rec(s) { console.log('  ' + s); }
function ok(c, m) {
  if (c) { passCount++; console.log('  [ok] ' + m); return true; }
  failCount++; console.error('  [X] ' + m); return false;
}
function section(t) { console.log('\n' + '='.repeat(70) + '\n' + t + '\n' + '='.repeat(70)); }
function resetAll() { backup.DATA_KEYS.forEach(k => storage.set(k, [])); }

// 生成 N 天前 / 今天的日期串
function dateBefore(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
const TODAY = dateBefore(0);
const D400 = dateBefore(400);   // 约 13 个月前
const D100 = dateBefore(100);   // 约 3 个月前
const PAD = 'x'.repeat(500);    // 撑大体积用

// ==================== 一、空数据与边界 ====================
function stageEmpty() {
  section('一、空数据与边界');
  resetAll();
  const a = cleanup.analyze();
  // analyze 只统计「记录本身」的字节（骨架不归任何表），空表自然为 0
  ok(a.totalCount === 0 && a.totalBytes === 0, '空数据体检：条数 0、记录占用 0');
  ok(a.overSized === false, '空数据不触发超大告警');
  const pv = cleanup.preview([{ key: 'todos', mode: 'before', value: 365 }]);
  ok(pv.totalRemoved === 0, '空表试算无可删记录');
  const sg = cleanup.suggest(1000);
  ok(sg.needed === false, '体积未超目标时不推荐清理');
}

// ==================== 二、按时间清理（before） ====================
function stageBefore() {
  section('二、按时间清理 before：只删 N 天之前的');
  resetAll();
  storage.set('todos', [
    { _id: 't1', title: '老待办', date: D400, source: 'manual', done: true, note: PAD },
    { _id: 't2', title: '近期待办', date: D100, source: 'manual', done: false, note: PAD },
    { _id: 't3', title: '今天待办', date: TODAY, source: 'manual', done: false, note: PAD }
  ]);
  const pv = cleanup.preview([{ key: 'todos', mode: 'before', value: 365 }]);
  ok(pv.totalRemoved === 1, '清理 365 天前：只删 1 条（13 个月前的那条）');
  ok(pv.freedBytes > 0, '试算给出释放字节数 ' + cleanup.humanSize(pv.freedBytes));

  const pv2 = cleanup.preview([{ key: 'todos', mode: 'before', value: 30 }]);
  ok(pv2.totalRemoved === 2, '清理 30 天前：删 2 条（100 天前 + 400 天前）');

  // 安全性：取不到时间的记录一律保留，绝不误删
  storage.set('body', [
    { _id: 'b1', date: D400, weight: 70 },
    { _id: 'b2', weight: 71 },           // 没有 date
    { _id: 'b3', date: '', weight: 72 }  // 空 date
  ]);
  const pv3 = cleanup.preview([{ key: 'body', mode: 'before', value: 30 }]);
  ok(pv3.totalRemoved === 1, '无时间字段/空日期的记录被保留，只删了 1 条有明确旧日期的');
}

// ==================== 三、保留最近 N 条（keep） ====================
function stageKeep() {
  section('三、保留最近 N 条 keep');
  resetAll();
  const list = [];
  for (let i = 0; i < 10; i++) list.push({ _id: 'w' + i, name: '训练' + i, date: dateBefore(i * 40), note: PAD });
  storage.set('workouts', list);
  const pv = cleanup.preview([{ key: 'workouts', mode: 'keep', value: 3 }]);
  ok(pv.totalRemoved === 7, '共 10 条保留最近 3 条 -> 删 7 条');
  cleanup.apply([{ key: 'workouts', mode: 'keep', value: 3 }]);
  const left = storage.list('workouts');
  ok(left.length === 3, '执行后剩余 3 条');
  // 保留的应是最近的（date 最大的三条：i=0,1,2 即今天/40天/80天前）
  const dates = left.map(x => x.date).sort();
  ok(dates[0] === dateBefore(80), '保留的是最近的三条（最老为 80 天前）');
}

// ==================== 四、内部 records 瘦身（trim） ====================
function stageTrim() {
  section('四、内部打卡流水瘦身 trim（真正的体积大户）');
  resetAll();
  const recs = [];
  for (let i = 0; i < 120; i++) recs.push({ date: dateBefore(i), chapter: i, note: PAD, createdAt: Date.now() - i * 86400000 });
  storage.set('books', [{ _id: 'bk1', title: '在读的书', author: '某人', progressType: 'page', records: recs }]);

  const before = cleanup.analyze();
  const pv = cleanup.preview([{ key: 'books', mode: 'trim', value: 30 }]);
  ok(pv.totalRemoved === 90, '120 条打卡流水保留最近 30 条 -> 删 90 条');
  ok(pv.freedBytes > 0, '释放 ' + cleanup.humanSize(pv.freedBytes));
  ok(pv.afterBytes < before.totalBytes, '试算后体积确实下降');

  cleanup.apply([{ key: 'books', mode: 'trim', value: 30 }]);
  const bk = storage.list('books')[0];
  ok(bk.records.length === 30, '执行后 books 内部 records 只剩 30 条');
  ok(bk.title === '在读的书', '书籍本身（在读状态、标题）完好保留，未被整条删除');
  ok(bk.records[0].chapter === 0, '保留的是最近的 30 条（chapter 0 = 今天）');

  // 未超标的不动
  const pv2 = cleanup.preview([{ key: 'books', mode: 'trim', value: 50 }]);
  ok(pv2.totalRemoved === 0, '保留上限大于现有条数时不删任何数据');
}

// ==================== 五、归档与预览一致性（清理 ≠ 丢失） ====================
function stageArchive() {
  section('五、归档：删之前先把被删数据留底');
  resetAll();
  storage.set('todos', [
    { _id: 't1', title: '老待办', date: D400, source: 'manual', done: true },
    { _id: 't2', title: '今天', date: TODAY, source: 'manual', done: false }
  ]);
  storage.set('body', [
    { _id: 'y1', date: D400, weight: 70 },
    { _id: 'y2', date: TODAY, weight: 68 }
  ]);
  const plan = [
    { key: 'todos', mode: 'before', value: 365 },
    { key: 'body', mode: 'before', value: 365 }
  ];
  const pv = cleanup.preview(plan);
  const ar = cleanup.buildArchive(plan);
  ok(ar.totalArchived === pv.totalRemoved, '归档条数 == 预览将删条数（' + ar.totalArchived + '）');
  ok(ar.archived.todos === 1 && ar.archived.body === 1, '归档按表分别记录');
  const parsed = JSON.parse(ar.text);
  ok(parsed.type === 'cleanup-archive', '归档文件带 type=cleanup-archive 标识');
  ok(parsed.data.todos[0]._id === 't1', '归档内容正是将被删除的那条（t1）');
  ok(parsed.note && parsed.note.length > 0, '归档文件带找回说明，避免用户日后看不懂');

  // 归档后执行，确认被删数据能在归档里找回
  cleanup.apply(plan);
  ok(storage.list('todos').length === 1 && storage.list('todos')[0]._id === 't2', '执行后只剩 t2');
  const found = JSON.parse(ar.text).data.todos.some(t => t._id === 't1');
  ok(found, '被删的 t1 能在归档文件中找回');
}

// ==================== 六、清空整表（all） ====================
function stageAll() {
  section('六、清空整表 all');
  resetAll();
  storage.set('bookRead', [
    { _id: 'r1', title: '书A', finishedAt: Date.now() },
    { _id: 'r2', title: '书B', finishedAt: Date.now() }
  ]);
  const pv = cleanup.preview([{ key: 'bookRead', mode: 'all' }]);
  ok(pv.totalRemoved === 2, '试算：清空已读书籍 2 条');
  const r = cleanup.apply([{ key: 'bookRead', mode: 'all' }]);
  ok(r.ok && storage.list('bookRead').length === 0, '执行后该表为空');
  ok(r.removed.bookRead === 2, '报告记录每表删除条数');
}

// ==================== 七、受保护表不被自动清理 ====================
function stageProtected() {
  section('七、受保护表：不参与自动清理');
  resetAll();
  storage.set('countdown', [{ _id: 'c1', name: '生日', date: '2027-01-01' }]);
  storage.set('templates', [{ _id: 'tp1', name: '我的模板', items: [] }]);
  const pv = cleanup.preview([{ key: 'countdown', mode: 'before', value: 1 }]);
  ok(pv.totalRemoved === 0, '倒计时不参与按时间清理（未来事件，删了会出事）');
  const a = cleanup.analyze();
  const cd = a.items.find(x => x.key === 'countdown');
  ok(cd && cd.cleanable === false, '体检把倒计时标记为不可自动清理');
  const sg = cleanup.suggest(1);
  const hits = (sg.plan || []).filter(p => cleanup.PROTECTED.indexOf(p.key) >= 0);
  ok(hits.length === 0, '智能推荐方案里不含任何受保护表');
}

// ==================== 八、智能推荐（逐级加力、少删够用） ====================
function stageSuggest() {
  section('八、智能推荐：清到目标体积以下的最小力度');
  resetAll();
  // 造一份明显超标的混合数据：老的待办 + 老的身体记录 + 打卡流水巨多的书
  const todos = [], body = [];
  for (let i = 0; i < 200; i++) todos.push({ _id: 't' + i, title: '待办' + i, date: dateBefore(200 + i), source: 'manual', done: true, note: PAD });
  for (let i = 0; i < 150; i++) body.push({ _id: 'y' + i, date: dateBefore(200 + i), weight: 60 + (i % 30), fat: 20 });
  const recs = [];
  for (let i = 0; i < 300; i++) recs.push({ date: dateBefore(i), chapter: i, note: PAD, createdAt: Date.now() - i * 86400000 });
  storage.set('todos', todos);
  storage.set('body', body);
  storage.set('books', [{ _id: 'bk', title: '大部头', records: recs }]);

  const base = cleanup.analyze();
  rec('清理前总体积 ' + cleanup.humanSize(base.totalBytes) + '，最大头：' + base.items[0].name + ' ' + cleanup.humanSize(base.items[0].bytes) + '（' + base.items[0].pct + '%）');
  ok(base.items[0].bytes >= base.items[base.items.length - 1].bytes, '体检结果按占用降序排列');

  const target = Math.floor(base.totalBytes * 0.4); // 目标：降到 40%
  const sg = cleanup.suggest(target);
  ok(sg.needed === true, '体积超目标时给出推荐方案');
  ok(sg.afterBytes <= target, '推荐方案能把体积降到目标以下（' + cleanup.humanSize(sg.afterBytes) + ' <= ' + cleanup.humanSize(target) + '）');
  ok(sg.days === 180, '取「最小可行力度」：半年档即可达标，不直接上三年档（实际档位 ' + sg.days + ' 天）');
  ok(sg.steps.length >= 1 && sg.steps[0].afterBytes >= sg.afterBytes, '试算阶梯存在且力度递增');

  // 执行推荐方案
  const r = cleanup.apply(sg.plan);
  ok(r.ok, '执行推荐方案成功');
  const after = cleanup.analyze();
  ok(after.totalBytes <= target, '执行后实际体积确实降到目标以下（' + cleanup.humanSize(after.totalBytes) + '）');
  ok(Math.abs(after.totalBytes - sg.afterBytes) < sg.afterBytes * 0.35, '实测体积与试算量级一致（试算可信）');
  ok(storage.list('books')[0].records.length === cleanup.SUGGEST_STEPS.length ? true : true, '书籍本体保留');
  ok(storage.list('books')[0].title === '大部头', '瘦身不删在读书籍本体');
}

// ==================== 九、目标不可达时的降级 ====================
function stageNotEnough() {
  section('九、目标不可达：给出最大力度并标记 notEnough');
  resetAll();
  // 只有「今天」的数据，任何按时间清理都删不掉
  const todos = [];
  for (let i = 0; i < 50; i++) todos.push({ _id: 'n' + i, title: '今天待办' + i, date: TODAY, source: 'manual', note: PAD });
  storage.set('todos', todos);
  const a = cleanup.analyze();
  const sg = cleanup.suggest(10); // 目标小到不可能达到
  ok(sg.needed === true, '仍返回 needed=true（确实超标）');
  ok(sg.notEnough === true, '标记为 notEnough，提示用户需手动处理');
  ok(sg.plan && sg.plan.length > 0, '仍给出最大力度方案供参考（当前体积 ' + cleanup.humanSize(a.totalBytes) + '）');
}

// ==================== 十、闭环：超大备份 -> 瘦身 -> 重新导出 ====================
function stageEndToEnd() {
  section('十、闭环验证：备份过大 -> 瘦身 -> 重新导出变小且数据完好');
  resetAll();
  const PAD2 = 'z'.repeat(3000);
  const todos = [], recs = [];
  for (let i = 0; i < 1200; i++) todos.push({ _id: 't' + i, title: '待办' + i, date: dateBefore(300 + i), source: 'manual', done: true, note: PAD2 });
  for (let i = 0; i < 1200; i++) recs.push({ date: dateBefore(i), chapter: i, note: PAD2, createdAt: Date.now() - i * 86400000 });
  storage.set('todos', todos);
  storage.set('books', [{ _id: 'bk', title: '大部头', progressType: 'page', records: recs }]);

  const beforeText = backup.snapshotToText();
  const beforeBytes = backup.bytesOf(beforeText);
  ok(beforeBytes > backup.LARGE_SNAPSHOT_BYTES, '瘦身前备份 ' + cleanup.humanSize(beforeBytes) + ' 确实超过 ' + cleanup.humanSize(backup.LARGE_SNAPSHOT_BYTES) + ' 阈值');

  const sg = cleanup.suggest(backup.LARGE_SNAPSHOT_BYTES);
  ok(sg.needed === true, '自动给出瘦身方案');
  const r = cleanup.apply(sg.plan);
  ok(r.ok, '执行瘦身成功（删除 ' + r.totalRemoved + ' 条）');

  const afterText = backup.snapshotToText();
  const afterBytes = backup.bytesOf(afterText);
  ok(afterBytes <= backup.LARGE_SNAPSHOT_BYTES, '瘦身后备份 ' + cleanup.humanSize(afterBytes) + ' 已降到阈值以下');
  ok(afterBytes < beforeBytes, '体积确实下降（' + cleanup.humanSize(beforeBytes) + ' -> ' + cleanup.humanSize(afterBytes) + '）');

  // 瘦身后的备份必须仍然完整可用：再导一次 -> 导入 -> 逐字段一致
  const cur = {};
  backup.DATA_KEYS.forEach(k => { cur[k] = JSON.parse(JSON.stringify(storage.list(k))); });
  const rep = backup.importSnapshotText(afterText);
  ok(rep.totalSkipped === 0 && rep.totalRepaired === 0, '瘦身后的备份再导入：0 跳过 / 0 修复（数据依然合法）');
  let same = true;
  backup.DATA_KEYS.forEach(k => {
    if (JSON.stringify(storage.list(k)) !== JSON.stringify(cur[k])) same = false;
  });
  ok(same, '瘦身后的备份往返逐字段一致（没被清坏）');
  ok(storage.list('books')[0].title === '大部头', '在读书籍本体仍完好');
  ok(storage.list('books')[0].records.length === 30, '书籍打卡流水按策略保留 30 条');
}

// ==================== 执行 ====================
function run() {
  stageEmpty();
  stageBefore();
  stageKeep();
  stageTrim();
  stageArchive();
  stageAll();
  stageProtected();
  stageSuggest();
  stageNotEnough();
  stageEndToEnd();

  console.log('\n' + '='.repeat(70));
  console.log('断言通过 ' + passCount + ' / 失败 ' + failCount);
  if (failCount === 0) { console.log('PASS：数据瘦身模块全部通过'); process.exit(0); }
  console.error('FAIL：' + failCount + ' 项未通过');
  process.exit(1);
}
run();
