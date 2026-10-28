/* 宝哥工作台 · 备份/恢复机制端到端压力测试（node mock-wx 桩，无需真机/开发者工具）
 *
 * 目标：
 *   1. 备份功能：能否生成快照并完整保存"全部业务数据"（逐 key 深比对）
 *   2. 恢复功能：能否正确还原备份内容且状态一致（清空/脏化后恢复 → 与快照完全一致）
 *   3. 往返压力：连续 N 次 备份→脏化→恢复 循环，检查反复操作后是否出现
 *      数据遗漏 / 丢失 / 覆盖 / 状态不一致 / id 冲突
 *
 * 种子数据按各页面真实写入逻辑的形状构造（books/records、bookRead、skills/skillAchieved、
 * workouts/body、todos、countdown、templates、settings），贴近真实使用现场。
 *
 * 运行：node tests/backup-restore.e2e.test.js
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const U = p => path.join(ROOT, p);

// ==================== 内存存储 + wx 桩 ====================
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

// ==================== 加载真实模块 ====================
const util = require(U('utils/util'));
const storage = require(U('utils/storage'));
const backup = require(U('utils/backup'));
const KEYS = storage.KEYS;
// 注意：utils/storage.js 与 utils/backup.js 内部 require('./xxx') 走相对路径，天然命中真实文件

// ==================== 断言工具 ====================
let passCount = 0, failCount = 0;
const issues = [];                       // 发现的异常（非中断，汇总报告）
const results = [];                      // 结构化步骤结果

function ok(cond, msg) {
  if (cond) { passCount++; return true; }
  failCount++;
  const e = new Error('✗ 断言失败: ' + msg);
  console.error('   ' + e.message);
  throw e;                               // 断言失败即中断该阶段，便于定位
}
function section(t) {
  console.log('\n' + '='.repeat(74) + '\n' + t + '\n' + '='.repeat(74));
  results.push({ section: t, lines: [] });
}
function rec(line) {
  console.log('  ' + line);
  if (results.length) results[results.length - 1].lines.push(line);
}
function issue(tag, line) {
  issues.push({ tag, line });
  console.log('  ⚠ [' + tag + '] ' + line);
}

// 深度一致：JSON.stringify 顺序敏感，额外给出归一化比较（忽略键序）
function canon(o) { return JSON.stringify(sortKeys(o)); }
function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object') {
    const r = {};
    Object.keys(o).sort().forEach(k => { r[k] = sortKeys(o[k]); });
    return r;
  }
  return o;
}
function deepEq(a, b) {
  if (a === b) return true;
  return canon(a) === canon(b);
}
// 严格一致：连键序/数组顺序都要求完全一致（备份-恢复应做到无损）
function strictEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// 列表内 id 唯一（跨列表共用 _id 是设计行为：完本书 books↔bookRead、达成技能 skills↔skillAchieved 为同一实体）
function idsUniqWithinEachList() {
  let allOk = true;
  backup.DATA_KEYS.forEach(k => {
    const ids = storage.list(k).filter(it => it && it._id).map(it => it._id);
    if (ids.length !== new Set(ids).size) allOk = false;
  });
  return allOk;
}

// ==================== 种子：模拟"覆盖全部功能模块的真实使用现场" ====================
function reseed() {
  Object.keys(store).forEach(k => delete store[k]);   // 清空内存 store
  const today = util.todayISO();
  const iso = n => util.addDaysISO(today, n);
  const DAY = 86400000;
  const ts = n => Date.now() + n * DAY;               // 相对今天的时间戳

  /* --- 📚 读书模块：在读书籍（含本周翻阅 records）+ 完本书脊（本周/历史）--- */
  const b1 = storage.add('books', {
    title: '《认知觉醒》', author: '周岭', progressType: 'chapter',
    totalChapters: 8, currentChapter: 3, status: 'reading',
    startDate: iso(-20), color: '#534AB7', autoTodo: true,
    records: [
      { date: iso(-3), at: ts(-3), cur: 1 },
      { date: iso(-2), at: ts(-2), cur: 2 },          // 本周内翻阅
      { date: iso(-1), at: ts(-1), cur: 3 }
    ]
  });
  storage.add('books', {
    title: '《摄影构图学》', author: '本·克莱门茨', progressType: 'page',
    totalPages: 260, currentPage: 60, status: 'reading',
    startDate: iso(-40), color: '#2F9E8F', autoTodo: false, records: []
  });
  const bFin = storage.add('books', {
    title: '《轻断食》', author: '麦克尔·莫斯利', progressType: 'percent',
    progressPercent: 100, status: 'reading', startDate: iso(-15),
    color: '#E08A3C', autoTodo: false, records: [{ date: iso(-2), at: ts(-2), cur: 100 }]
  });
  // 标记完本 → 移入 bookRead（本周完成的权威集）
  const bookRead = storage.list('bookRead').filter(it => it._id !== bFin._id);
  bookRead.push(Object.assign({}, bFin, { finishedAt: ts(-2), finishedDate: iso(-2), tags: ['健康'], review: '值得实践' }));
  wx.setStorageSync(KEYS.bookRead, bookRead);
  // 历史完本（上月，用于验证周边界不误伤）
  wx.setStorageSync(KEYS.bookRead, bookRead.concat([{
    _id: 'id_oldfinish_1', createdAt: ts(-50), title: '《沉默的大多数》', author: '王小波',
    progressType: 'percent', progressPercent: 100, status: 'reading', startDate: iso(-60),
    color: '#5A6A9A', records: [], finishedAt: ts(-40), finishedDate: iso(-40), tags: [], rating: 5
  }]));

  /* --- 🎯 学习模块：技能（在学/达成）+ 图鉴徽章 --- */
  const sk1 = storage.add('skills', {
    name: '短视频运镜', goal: '掌握推拉摇移跟', icon: '🎬', cycleDays: 21,
    color: '#E08A3C', status: 'learning', createdAt: ts(-12),
    stages: [
      { name: '认识镜头语言', done: true, doneAt: ts(-5), doneDate: iso(-5), logs: [{ at: ts(-5), text: '看完基础篇' }] },
      { name: '手持稳定练习', done: true, doneAt: ts(-2), doneDate: iso(-2), logs: [] },
      { name: '运动镜头组接', done: false, logs: [] },
      { name: '成片节奏把控', done: false, logs: [] }
    ],
    records: []
  });
  const skAchieved = storage.add('skills', {
    name: '分镜脚本基础', goal: '独立产出分镜', icon: '📝', cycleDays: 14,
    color: '#534AB7', status: 'achieved', achievedAt: ts(-3), createdAt: ts(-30),
    stages: [
      { name: '景别与机位', done: true, doneAt: ts(-25), doneDate: iso(-25), logs: [] },
      { name: '分镜表结构', done: true, doneAt: ts(-6), doneDate: iso(-6), logs: [] },
      { name: '实战出片', done: true, doneAt: ts(-3), doneDate: iso(-3), logs: [{ at: ts(-3), text: '短片完成' }] }
    ],
    records: []
  });
  const achieved = storage.list('skillAchieved').filter(it => it._id !== skAchieved._id);
  achieved.push(Object.assign({}, skAchieved));
  wx.setStorageSync(KEYS.skillAchieved, achieved);

  /* --- 🏋 健身模块：训练计划(本周完成/未完成/历史/未来) + 身体记录 + 自定义模板 --- */
  const mkItems = (names) => names.map((n, i) => ({
    _id: 'it_' + n.slice(0, 2) + '_' + i, name: n, target: '3组×12次',
    sets: [{ reps: 12, weight: 20 }, { reps: 12, weight: 20 }, { reps: 10, weight: 20 }],
    done: false
  }));
  const mkSetsDone = items => items.map(it => Object.assign({}, it, {
    done: true, doneAt: ts(-1),
    sets: it.sets.map(s => Object.assign({}, s, { done: true }))
  }));

  // ① 本周已完成（含动作全部 done）
  const wDone = storage.add('workouts', {
    name: '🏋 上肢力量 · 胸推日', plan: 'custom', date: iso(-1), cycleDays: 7,
    items: mkSetsDone(mkItems(['杠铃卧推', '上斜哑铃', '俯卧撑'])),
    completed: true, completedAt: ts(-1), startedAt: ts(-1), volume: 1420
  });
  // ② 本周已完成第二条（同一天多练场景）
  storage.add('workouts', {
    name: '🏃 有氧 · 慢跑', plan: 'cardio', date: iso(-1), cycleDays: 7,
    items: mkSetsDone(mkItems(['匀速慢跑'])), completed: true, completedAt: ts(-1),
    startedAt: ts(-1), volume: 0, minutes: 32
  });
  // ③ 本周未完成（部分动作 done）
  const wPart = storage.add('workouts', {
    name: '🏋 下肢 · 深蹲日', plan: 'custom', date: iso(0), cycleDays: 7,
    items: [{ _id: 'it_sq_0', name: '杠铃深蹲', target: '4组×8次',
      sets: [{ reps: 8, weight: 60 }, { reps: 8, weight: 60 }], done: true, doneAt: ts(0) },
      { _id: 'it_sq_1', name: '腿举', target: '3组×12次',
        sets: [{ reps: 12, weight: 80 }, { reps: 12, weight: 80 }], done: false }],
    completed: false, startedAt: ts(0), volume: 0
  });
  // ④ 上周已完成（验证"历史不丢失、不被周边界误伤"）
  storage.add('workouts', {
    name: '🧘 拉伸 · 恢复', plan: 'stretch', date: iso(-9), cycleDays: 7,
    items: mkSetsDone(mkItems(['全身拉伸'])), completed: true, completedAt: ts(-9),
    startedAt: ts(-9), volume: 0
  });
  // ⑤ 未来计划（未到训练日）
  storage.add('workouts', {
    name: '🏋 肩部 · 推举日', plan: 'custom', date: iso(2), cycleDays: 7,
    items: mkItems(['站姿推举', '侧平举']), completed: false, startedAt: null
  });

  // 身体记录：同日更新合并、历史保留
  storage.add('body', { date: iso(-10), weight: 72.4, fat: 19.2 });
  storage.add('body', { date: iso(-2), weight: 71.8 });
  storage.add('body', { date: iso(0), weight: 71.6, fat: 18.7 });

  // 自定义模板（用户收藏/自建 —— 业务数据，验证是否被备份覆盖）
  storage.add('templates', {
    name: '我的胸推日', createdAt: ts(-6),
    items: [{ _id: 'tp_0', name: '杠铃卧推', target: '4组×10次',
      sets: [{ reps: 10, weight: 40 }, { reps: 10, weight: 40 }], done: false }]
  });
  storage.add('templates', {
    name: '我的练腿日', createdAt: ts(-4),
    items: [{ _id: 'tp_1', name: '保加利亚分腿蹲', target: '3组×10次',
      sets: [{ reps: 10, weight: 0 }, { reps: 10, weight: 0 }], done: false }]
  });

  /* --- ✅ 今日模块：待办（手动完成/未完成 + 读书/健身派生）+ 倒计时 --- */
  storage.add('todos', { date: iso(-1), source: 'manual', sourceKey: null, sourcePlanId: null,
    title: '整理客片交付', desc: '精修 20 张', done: true, completedAt: ts(-1), important: true });
  storage.add('todos', { date: iso(-1), source: 'manual', sourceKey: null, sourcePlanId: null,
    title: '给客户回访电话', desc: '手动添加', done: false, important: false });
  storage.add('todos', { date: iso(0), source: 'manual', sourceKey: null, sourcePlanId: null,
    title: '约拍踩点', desc: '看光线', done: true, completedAt: ts(0), important: false });
  storage.add('todos', { date: iso(0), source: 'manual', sourceKey: null, sourcePlanId: null,
    title: '修图备份', desc: '双硬盘', done: false, important: true });
  // 读书派生（源书 autoTodo=true → 派生当天翻阅待办）
  storage.add('todos', { date: iso(-1), source: 'reading', sourceKey: b1._id, sourcePlanId: b1._id,
    title: '📖 读《认知觉醒》', desc: '读到第 3/8 章', done: true, completedAt: ts(-1), planned: false });
  // 健身派生（planned：完成全部动作后由健身页自动同步）
  storage.add('todos', { date: iso(0), source: 'fitness', sourceKey: wPart._id, sourcePlanId: wPart._id,
    title: '🏋 训练：深蹲日', desc: '今日训练计划', done: false, planned: true });
  storage.add('todos', { date: iso(-1), source: 'fitness', sourceKey: wDone._id, sourcePlanId: wDone._id,
    title: '🏋 训练：胸推日', desc: '今日训练计划', done: true, completedAt: ts(-1), planned: true });

  storage.add('countdown', { name: '客户样片交付', date: iso(4), annual: false, cdType: 'solar', desc: '' });
  storage.add('countdown', { name: '老婆生日', date: '1990-05-20', annual: true, cdType: 'solar', desc: '农历可用 cdType=lunar' });

  // 设置（设备偏好对象，非数组 —— 备份范围的边界观察项）
  wx.setStorageSync(KEYS.settings, { dark: true, lastBackupAt: Date.now() });
}

// ==================== 阶段一：备份功能 ====================
function stageBackup() {
  section('阶段一 · 备份功能：快照生成与完整性');
  const text = backup.snapshotToText();
  rec('快照字符数 = ' + text.length);
  const snap = JSON.parse(text);

  ok(snap.app === 'baoge-workbench', '快照 app 标识正确');
  ok(snap.version === backup.SNAPSHOT_VERSION, '快照 version 正确 = ' + backup.SNAPSHOT_VERSION);
  ok(typeof snap.exportedAt === 'number' && snap.exportedAt > 0, '快照 exportedAt 时间戳存在');

  // DATA_KEYS 覆盖范围扫描（模块级审计：数组型业务表缺失=缺陷；对象型设备偏好=已知边界）
  const moduleOf = { books: '读书·书架', bookRead: '读书·完本', skills: '学习·技能', skillAchieved: '学习·徽章', workouts: '健身·训练', body: '健身·身体', todos: '今日·待办', countdown: '今日·倒计时', templates: '健身·自定义模板', settings: '设置' };
  const notCovered = Object.keys(KEYS).filter(k => !backup.DATA_KEYS.includes(k));
  notCovered.forEach(k => {
    const v = wx.getStorageSync(KEYS[k]);
    const isArr = Array.isArray(v);
    issue(isArr ? '备份缺陷' : '已知边界',
      '存储 key「' + k + '」(' + moduleOf[k] + ') ' + (isArr
        ? '是数组型业务数据却不在 backup.DATA_KEYS 内 → 不被备份/恢复，存在丢失风险'
        : '为对象型设备偏好，按设计不入快照（换设备后主题需重设、备份提醒自然重置）'));
  });

  // counts 与 data 一致性
  let countsOk = true;
  backup.DATA_KEYS.forEach(k => {
    if (snap.counts[k] !== storage.list(k).length) countsOk = false;
  });
  ok(countsOk, '快照 counts 与各 key 实际条数一致：' + JSON.stringify(snap.counts));

  // 逐 key 深比对：快照 data 与当前存储完全一致（内容 + 顺序）
  let fullEq = true, eqList = [];
  backup.DATA_KEYS.forEach(k => {
    const s = strictEq(snap.data[k], storage.list(k));
    eqList.push(k + '=' + (s ? '一致' : '✗不一致'));
    if (!s) { fullEq = false; ok(false, k + ' 快照与源数据不一致'); }
  });
  rec('逐 key 比对：' + eqList.join('  '));
  ok(fullEq, '备份快照完整保存了 DATA_KEYS 内全部业务数据（内容+顺序无损）');

  // counts 总和
  const total = backup.DATA_KEYS.reduce((a, k) => a + (snap.counts[k] || 0), 0);
  rec('快照覆盖业务条目合计 = ' + total + ' 条（' + backup.DATA_KEYS.length + ' 个 key）');
  results[results.length - 1].total = total;
}

// ==================== 阶段二：恢复功能 ====================
function stageRestore() {
  section('阶段二 · 恢复功能：清空/脏化后还原一致性');
  // 先记下"干净现场"快照
  const text = backup.snapshotToText();
  const snap = JSON.parse(text);
  const expect = JSON.parse(text);                     // 期望 = 快照副本
  rec('已生成恢复基准快照（exportedAt=' + snap.exportedAt + '）');

  // 模拟灾难现场：① 全部业务 key 清空 ② 混入脏数据 ③ 篡改部分字段
  backup.DATA_KEYS.forEach(k => wx.removeStorageSync(KEYS[k]));
  wx.setStorageSync(KEYS.todos, [{ _id: 'junk_1', title: '脏数据-幽灵待办', date: '2099-01-01', source: 'manual', done: false }]);
  wx.setStorageSync(KEYS.workouts, []);
  const dirtyBooks = storage.list('books');            // 已被清空 → []
  rec('灾难现场已就绪：8 个业务 key 清空，todos 注入 1 条幽灵记录，workouts 置空');

  const applied = backup.applySnapshot(snap);
  ok(applied && typeof applied === 'object', 'applySnapshot 返回统计对象');
  const expectCounts = JSON.parse(text).counts;
  let appliedOk = true;
  backup.DATA_KEYS.forEach(k => { if (applied[k] !== expectCounts[k]) appliedOk = false; });
  ok(appliedOk, 'applySnapshot 返回的 applied 计数与快照 counts 一致：' + JSON.stringify(applied));

  // 恢复后：逐 key 与快照严格一致（顺序也一致）→ 证明"状态一致"
  let allEq = true;
  const diffs = [];
  backup.DATA_KEYS.forEach(k => {
    const cur = storage.list(k), exp = expect.data[k];
    const eq = strictEq(cur, exp);
    const canonEq = deepEq(cur, exp);
    if (!eq) {
      allEq = false;
      diffs.push(k + ':' + (canonEq ? '仅键序差异' : '内容不一致(len ' + cur.length + ' vs ' + exp.length + ')'));
    }
  });
  ok(allEq, '恢复后 DATA_KEYS 全部与快照一致' + (diffs.length ? '，差异=' + diffs.join(', ') : ''));

  // 脏数据是否被彻底覆盖（无幽灵残留）
  const junk = storage.list('todos').filter(t => String(t._id).indexOf('junk_') === 0);
  ok(junk.length === 0, '恢复后无幽灵/脏数据残留（覆盖式恢复正确清场）');

  // 状态一致性关键点：每个列表内 _id 唯一（跨列表共用 _id 属设计，如完本书在 books+bookRead）
  ok(idsUniqWithinEachList(), '恢复后各列表内 _id 均唯一，无 id 冲突/覆盖');

  // 恢复边界：settings（对象型设备偏好）不受恢复影响 —— 已在阶段一审计记录
  const settings = wx.getStorageSync(KEYS.settings) || null;
  rec('settings 边界 = ' + (settings ? '保留原值(设备偏好不随备份覆盖，lastBackupAt 缺失会自然触发备份提醒)' : '无 settings'));
}

// ==================== 阶段三：多轮往返压力 ====================
function stageRoundTrip(N) {
  section('阶段三 · 往返压力：连续 ' + N + ' 次 备份→脏化→恢复 循环');
  const DAY = 86400000;
  let lost = 0, corrupt = 0, idDup = 0;
  let roundDetail = [];

  for (let i = 1; i <= N; i++) {
    // ① 模拟两轮备份之间的"正常使用"：各 key 增/删/改
    const today = util.todayISO();
    if (i % 2 === 1) storage.add('todos', { date: today, source: 'manual', sourceKey: null, sourcePlanId: null, title: '往返新增待办#' + i, desc: '', done: i % 3 === 0, important: false, completedAt: i % 3 === 0 ? Date.now() : null });
    if (i % 2 === 0) {
      const t = storage.list('todos')[0];
      if (t) storage.update('todos', t._id, { desc: '往返修改#' + i });
    }
    if (i % 3 === 0) storage.add('body', { date: today, weight: 71 + i / 10 });
    if (i % 4 === 0) {
      const w = storage.list('workouts').find(x => !x.completed);
      if (w) storage.update('workouts', w._id, { completed: true, completedAt: Date.now(), items: (w.items || []).map(it => Object.assign({}, it, { done: true })) });
    }
    if (i % 5 === 0) { const b = storage.list('books')[0]; if (b) storage.update('books', b._id, { currentChapter: (b.currentChapter || 0) + 1 }); }
    if (i % 6 === 0) { const t = storage.list('todos'); if (t.length > 1) storage.remove('todos', t[1]._id); }

    // ② 备份当前现场
    const snap = JSON.parse(backup.snapshotToText());
    const expected = snap.data;                          // 期望恢复结果 = 快照 data

    // ③ 制造破坏现场（脏化全部业务 key）
    backup.DATA_KEYS.forEach(k => {
      wx.removeStorageSync(KEYS[k]);
      wx.setStorageSync(KEYS[k], [{ _id: 'junk_r' + i + '_' + k, hacked: true }]);  // 注入伪条目
    });

    // ④ 恢复
    backup.applySnapshot(snap);

    // ⑤ 一致性校验：恢复结果 === 备份现场（逐 key 严格一致，含数组顺序）
    let roundOk = true, why = [];
    backup.DATA_KEYS.forEach(k => {
      if (!strictEq(storage.list(k), expected[k])) { roundOk = false; why.push(k); }
    });
    if (!roundOk) { corrupt++; roundDetail.push('第' + i + '轮 key 不一致: ' + why.join(',')); }
    // ⑥ 列表内 id 唯一性（跨列表共用 _id 是设计：books↔bookRead、skills↔skillAchieved 同实体）
    let dup = 0; const dupWhere = [];
    backup.DATA_KEYS.forEach(k => {
      const items = storage.list(k).filter(it => it && it._id);
      const ids = items.map(it => it._id);
      const n = ids.length - new Set(ids).size;
      if (n > 0) { dup += n; dupWhere.push(k + '=' + JSON.stringify(ids.filter((x, i) => ids.indexOf(x) !== i))); }
    });
    if (dup > 0) { idDup += dup; roundDetail.push('第' + i + '轮列表内重复 id(' + dup + ') @ ' + dupWhere.join(',')); }

    // ⑦ 汇总本轮
    if (roundOk && dup === 0) rec('第 ' + i + ' 轮 ✓  现场' + JSON.stringify(snap.counts) + ' → 恢复逐 key 一致、id 无冲突');
    else rec('第 ' + i + ' 轮 ✗  异常见下方清单');
  }
  if (roundDetail.length) roundDetail.forEach(d => rec('  · ' + d));
  ok(corrupt === 0 && lost === 0 && idDup === 0, '往返 ' + N + ' 次全程无数据丢失/覆盖/不一致（不一致=' + corrupt + ' id冲突=' + idDup + '）');
  results[results.length - 1].lines.push('异常计数：丢失=' + lost + ' 不一致=' + corrupt + ' id冲突=' + idDup);
  results[results.length - 1].roundDetail = roundDetail;
}

// ==================== 执行 ====================
function runStage(label, fn, resetCounters) {
  if (resetCounters) { passCount = 0; failCount = 0; }
  const p0 = passCount, f0 = failCount, i0 = issues.length;
  try {
    fn();
  } catch (e) {
    failCount++;
    console.error('  ✗ 阶段中断于断言失败：' + e.message);
  }
  return { label, pass: passCount - p0, fail: failCount - f0, newIssues: issues.slice(i0) };
}

function printTable(stages) {
  console.log('\n' + '■'.repeat(74));
  console.log('■  备份/恢复端到端压力测试 · 结果汇总');
  console.log('■'.repeat(74));
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('阶段', 26) + pad('断言通过', 10) + pad('失败', 6) + '本阶段发现异常');
  stages.forEach(s => {
    console.log(pad('· ' + s.label, 26) + pad(s.pass, 10) + pad(s.fail, 6) + (s.newIssues.length ? s.newIssues.map(i => i.tag + '(' + i.line.slice(0, 22) + '…)').join('；') : '无'));
  });
  const tPass = stages.reduce((a, s) => a + s.pass, 0);
  const tFail = stages.reduce((a, s) => a + s.fail, 0);
  console.log('-'.repeat(74));
  console.log('合计断言：通过 ' + tPass + ' / 失败 ' + tFail);
  if (issues.length) {
    console.log('\n⚠ 完整异常/边界清单（' + issues.length + ' 条）：');
    issues.forEach((it, i) => console.log('  [' + (i + 1) + '] ' + it.tag + '：' + it.line));
  } else {
    console.log('\n✓ 全程未发现数据遗漏/丢失/覆盖/状态不一致等异常');
  }
  console.log('（说明：本测试在 node 内存桩上驱动真实 utils 层；settings 为设备偏好对象，按设计不入快照）');
  const allPass = tFail === 0;
  process.exit(allPass ? 0 : 1);
}

function run() {
  // ---- 阶段零：种子就绪审计 ----
  reseed();
  section('准备 · 全模块种子数据就绪');
  const seedReport = {};
  Object.keys(KEYS).forEach(k => {
    const v = wx.getStorageSync(KEYS[k]);
    const n = Array.isArray(v) ? v.length : (v ? 'object:' + Object.keys(v).length + '键' : 0);
    seedReport[k] = n;
  });
  rec('各存储 key 就绪：' + JSON.stringify(seedReport));
  ok(Object.keys(KEYS).length === 10, 'storage.KEYS 共 10 个业务 key 全部被种子覆盖');
  const expectSeed = { books: 3, bookRead: 2, skills: 2, skillAchieved: 1, workouts: 5, body: 3, todos: 7, countdown: 2, templates: 2 };
  Object.keys(expectSeed).forEach(k => ok(wx.getStorageSync(KEYS[k]).length === expectSeed[k], k + ' 种子条数 = ' + expectSeed[k]));

  const stages = [];
  stages.push(runStage('阶段一 · 备份完整性', stageBackup, true));
  stages.push(runStage('阶段二 · 恢复一致性', stageRestore, true));
  const rounds = parseInt(process.env.ROUNDS || '10', 10);
  stages.push(runStage('阶段三 · 往返压力 ×' + rounds, () => stageRoundTrip(rounds), true));
  printTable(stages);
}

run();
