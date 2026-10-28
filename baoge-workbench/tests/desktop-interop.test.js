// tests/desktop-interop.test.js
// 验证：桌面版 HTML 与小程序的备份格式 100% 互通
//   1) checksum 算法逐字节一致（FNV-1a）
//   2) 小程序 backup.js 生成的快照，能被桌面版的导入规则完整吃下
//   3) 桌面版导出的快照，能被小程序的 applySnapshotObject 完整吃下（反向）
//   4) 校验和篡改 -> 双向都应能识别（告警）而非静默通过
//
// 运行：node tests/desktop-interop.test.js

const fs = require('fs');
const path = require('path');

// ---------- 1. 建 wx 桩，让小程序代码可在 Node 里跑 ----------
const store = {};
let ID = 0;
global.wx = {
  getStorageSync: k => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v; },
  removeStorageSync: k => { delete store[k]; },
  showToast: () => {}, showModal: () => {}, setClipboardData: () => {},
  getClipboardData: () => ({ data: '' }),
  getFileSystemManager: () => ({ writeFileSync(){}, readFileSync(){ return ''; } })
};
global.getApp = () => ({ globalData: { cloudSync: false } });
global.getCurrentPages = () => [];

const ROOT = path.join(__dirname, '..');
const backup = require(path.join(ROOT, 'utils/backup.js'));
const guard = require(path.join(ROOT, 'utils/backupGuard.js'));
const storage = require(path.join(ROOT, 'utils/storage.js'));

// ---------- 2. 从桌面版 HTML 里抠出 checksum 实现（保持"同一份代码"的测试意义） ----------
const html = fs.readFileSync(path.join(ROOT, '宝哥工作台_桌面版.html'), 'utf8');
const m = html.match(/function checksum\(str\)\{[\s\S]*?\n\}/);
if (!m) { console.error('✗ 未能在桌面版 HTML 中找到 checksum 实现'); process.exit(1); }
const checksumDesktop = new Function(m[0] + '; return checksum;')();

// ---------- 断言工具 ----------
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }

// ---------- 3. 造一份覆盖 9 张表的数据 ----------
function seed() {
  Object.keys(store).forEach(k => delete store[k]);
  const now = Date.now();
  storage.set('books', [
    { _id: 'b1', title: '置身事内', author: '兰小欢', progressType: 'percent', status: 'reading',
      startDate: '2026-01-02', deadline: null, color: '#534AB7', autoTodo: true,
      records: [{ at: now, percent: 42 }], progressPercent: 42, createdAt: now },
    { _id: 'b2', title: 'Emoji 📚 测试 / 多语言 Тест テスト', author: '测试者', progressType: 'page',
      status: 'reading', startDate: '', deadline: null, color: '#534AB7', autoTodo: false,
      records: [], progressPercent: 7, createdAt: now }
  ]);
  storage.set('bookRead', [
    { _id: 'r1', title: '活着', author: '余华', progressType: 'percent', status: 'reading',
      startDate: '2025-06-01', color: '#534AB7', records: [], finishedAt: now,
      finishedDate: '2025-06-20', tags: ['文学'], review: '好书', rating: 5, progressPercent: 100, createdAt: now }
  ]);
  storage.set('skills', [
    { _id: 's1', name: '摄影基础', goal: '会拍人像', icon: '', cycleDays: 21, color: '#534AB7',
      status: 'learning', stages: [], records: [{ at: now }], achievedAt: null, createdAt: now }
  ]);
  storage.set('skillAchieved', [
    { _id: 'a1', name: '游泳 1000 米', goal: '', icon: '', cycleDays: 30, color: '#534AB7',
      status: 'achieved', stages: [], achievedAt: now, createdAt: now }
  ]);
  storage.set('workouts', [
    { _id: 'w1', name: '胸 + 三头', plan: 'custom', date: '2026-09-05', cycleDays: 7, items: [],
      completed: true, completedAt: now, startedAt: now, volume: 3200, minutes: 55, createdAt: now }
  ]);
  storage.set('body', [
    { _id: 'bd1', date: '2026-09-05', weight: 72.5, fat: 19.2, createdAt: now }
  ]);
  storage.set('todos', [
    { _id: 't1', title: '读完第三章', desc: '', date: '2026-09-06', source: 'reading', sourceKey: 'b1',
      sourcePlanId: null, done: false, completedAt: null, important: true, planned: false, createdAt: now }
  ]);
  storage.set('countdown', [
    { _id: 'c1', name: '春节', date: '2027-02-17', annual: true, cdType: 'lunar', desc: '', createdAt: now }
  ]);
  storage.set('templates', [
    { _id: 'tp1', name: '推日模板', items: [{ name: '卧推', sets: 4 }], createdAt: now }
  ]);
}

console.log('\n=== 桌面版 × 小程序 备份互通验证 ===\n');

// ---------- 测试 A：checksum 算法一致 ----------
console.log('[A] checksum 算法一致性（FNV-1a）');
{
  const samples = ['', 'abc', '{"a":1}', '中文 · Emoji 📚 · Тест テスト', 'x'.repeat(10000)];
  let allSame = true;
  samples.forEach(s => { if (guard.checksum(s) !== checksumDesktop(s)) allSame = false; });
  ok(allSame, '小程序 guard.checksum 与桌面版 checksum 在 5 组样本上完全一致');
}

// ---------- 测试 B：小程序导出 -> 桌面版导入 ----------
console.log('[B] 小程序导出 -> 桌面版导入规则');
{
  seed();
  const text = backup.snapshotToText();          // 小程序侧生成
  const snap = JSON.parse(text);
  eq(snap.app, 'baoge-workbench', 'app 标识一致');
  eq(snap.version, 1, 'version 一致');
  ok(Array.isArray(Object.keys(snap.counts)), '含 counts');
  // 桌面版导入规则：app / version / data 校验 + checksum 比对
  const actual = checksumDesktop(JSON.stringify(snap.data));
  eq(actual, snap.checksum, '桌面版重算 checksum 与小程序写入的一致（不会误报篡改）');
  // 逐表条数对齐
  const DATA_KEYS = ['books','bookRead','skills','skillAchieved','workouts','body','todos','countdown','templates'];
  let shapeOk = DATA_KEYS.every(k => Array.isArray(snap.data[k]));
  ok(shapeOk, '9 张业务表在快照里都是数组');
  eq(DATA_KEYS.reduce((a,k)=>a+snap.data[k].length,0), 10, '总条数 10 条全部在快照内');
}

// ---------- 测试 C：桌面版导出 -> 小程序导入 ----------
console.log('[C] 桌面版导出格式 -> 小程序导入');
{
  // 用与桌面版完全相同的构造逻辑生成一份快照
  const DATA_KEYS = ['books','bookRead','skills','skillAchieved','workouts','body','todos','countdown','templates'];
  const data = {}, counts = {};
  DATA_KEYS.forEach(k => { data[k] = storage.list(k); counts[k] = data[k].length; });
  const snap = { app:'baoge-workbench', version:1, exportedAt:Date.now(), counts:counts, data:data };
  snap.checksum = checksumDesktop(JSON.stringify(data));   // 桌面版算法签的校验和

  let report = null, err = null;
  try { report = backup.applySnapshotObject(snap, {}); } catch (e) { err = e; }
  ok(!err, '小程序 applySnapshotObject 接受桌面版快照（无异常）' + (err ? '：' + err.message : ''));
  if (report) {
    eq(report.totalApplied, 10, '小程序成功写入 10 条');
    eq(report.totalSkipped, 0, '无跳过');
    eq(report.checksumOk, true, '小程序侧校验和通过（桌面版签的 checksum 被认可）');
    const b1 = storage.list('books').find(x => x._id === 'b1');
    eq(b1 && b1.records.length, 1, '嵌套 records 完整还原');
    const t = storage.list('books').find(x => x._id === 'b2');
    eq(t && t.title, 'Emoji 📚 测试 / 多语言 Тест テスト', '多语言 + emoji 标题无乱码');
  }
}

// ---------- 测试 D：篡改校验和应被识别 ----------
console.log('[D] 篡改检测');
{
  seed();
  const snap = JSON.parse(backup.snapshotToText());
  snap.data.todos[0].title = '被偷偷改过的内容';
  const actual = checksumDesktop(JSON.stringify(snap.data));
  ok(actual !== snap.checksum, '内容改动后桌面版重算 checksum 与文件内 checksum 不一致 -> 会给出告警');

  // 小程序侧同样识别
  let warn = false;
  try {
    const r = backup.applySnapshotObject(snap, {});
    warn = (r.warnings || []).some(w => w.code === 'CHECKSUM_MISMATCH') || r.checksumOk === false;
  } catch (e) { warn = true; }
  ok(warn, '小程序侧也识别出校验和不一致（双向都能发现篡改）');
}

// ---------- 测试 E：BOM / 首尾空白容错 ----------
console.log('[E] BOM 与空白容错');
{
  seed();
  const text = '\uFEFF\n  ' + backup.snapshotToText() + '  \n';
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  let okParse = true;
  try { JSON.parse(cleaned); } catch (e) { okParse = false; }
  ok(okParse, '桌面版剥离 BOM 与首尾空白后可正常解析');

  // 小程序 parseSnapshotText 同样处理
  let okMini = true;
  try { backup.parseSnapshotText(text); } catch (e) { okMini = false; }
  ok(okMini, '小程序 parseSnapshotText 对同一文本也能解析');
}

// ---------- 汇总 ----------
console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' / ' + (pass + fail) + (fail ? '  ✗ 失败 ' + fail : '  ✓ 全绿'));
console.log('----------------------------------------\n');
process.exit(fail ? 1 : 0);
