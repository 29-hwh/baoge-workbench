/* 宝哥工作台 · 回归 + 随机卡死专项测试（node mock-wx 桩，无需真机/开发者工具）
 *
 * 设计：
 *   - 用内存 store 模拟 wx.setStorageSync/getStorageSync
 *   - 用自动确认模拟 showModal/showActionSheet，跑通 happy path
 *   - setData 支持点号路径(a.b.c)合并，并带「单次 handler 调用上限」守卫，
 *     一旦 setData 调用超过阈值即抛错 —— 这正是"随机卡死/递归刷新"的探测器
 *   - 随机模拟 300+ 次交互，排查偶发卡死
 *
 * 运行：node tests/regression.test.js
 */
'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const U = p => path.join(ROOT, p);

// ---------- 内存存储 + 全局 wx 桩 ----------
const store = {};
let clipboard = '';
let setDataCalls = 0;           // 单次 handler 内的 setData 计数（卡死守卫）
const SETDATA_HARD_LIMIT = 500; // 真实代码单次 handler 不会超过 ~5

const noopFn = function () { return noopProxy; };
const noopProxy = new Proxy({}, { get: () => noopFn, apply: () => noopProxy });

const wx = {
  env: { USER_DATA_PATH: '/tmp' },
  getStorageSync(k) { return store[k]; },
  setStorageSync(k, v) { store[k] = v; },
  removeStorageSync(k) { delete store[k]; },
  showToast() {},
  showLoading() {},
  hideLoading() {},
  showModal(opts) {
    const r = { confirm: true, cancel: false, content: '', tapIndex: 0 };
    if (opts && opts.editable) r.content = 'auto';
    if (opts && opts.success) opts.success(r);
  },
  showActionSheet(opts) {
    if (opts && opts.success) opts.success({ tapIndex: 0 });
  },
  setClipboardData(o) { clipboard = o && o.data; if (o && o.success) o.success({}); },
  getClipboardData(o) { if (o && o.success) o.success({ data: clipboard }); },
  chooseMessageFile(o) { if (o && o.fail) o.fail({ errMsg: '已取消' }); },
  shareFileMessage(o) { if (o && o.success) o.success({}); },
  getFileSystemManager() {
    return {
      writeFile(o) { if (o && o.success) o.success({}); },
      readFile(o) { if (o && o.success) o.success({ data: '' }); }
    };
  },
  createCanvasContext() { return noopProxy; },
  setBackgroundColor() {},
  setNavigationBarColor() {},
  vibrateShort() {},
  switchTab() {},
  navigateTo() {}
};

// 云备份 mock：内存集合，支撑链式 where/orderBy/limit/get/add/update/doc
(function installCloudMock() {
  const tables = {};                            // collName -> [doc]
  function getTable(name) { if (!tables[name]) tables[name] = []; return tables[name]; }
  function filterDocs(arr, f) {
    if (!f) return arr.slice();
    return arr.filter(d => Object.keys(f).every(k => d[k] === f[k]));
  }
  function makeCollection(name) {
    const table = getTable(name);
    let pendingWhere = null;
    const c = {
      _reset() { pendingWhere = null; },
      where(f) { pendingWhere = f; return c; },
      orderBy() { return c; },
      limit() { return c; },
      get() {
        const arr = filterDocs(table, pendingWhere);
        c._reset();
        return Promise.resolve({ data: arr.slice() });
      },
      add(o) {
        const doc = Object.assign({ _id: 'cloud_' + (table.length + 1) }, o.data || {});
        table.push(doc);
        return Promise.resolve({ _id: doc._id });
      },
      update(o) {
        const arr = filterDocs(table, pendingWhere);
        arr.forEach(d => Object.assign(d, o.data));
        c._reset();
        return Promise.resolve({ updated: arr.length });
      },
      doc(id) {
        return { get() { return Promise.resolve({ data: table.find(d => d._id === id) || null }); } };
      }
    };
    return c;
  }
})();


const appStub = {
  globalData: { cloudSync: false, themeDark: false },
  applyTheme(page) { if (page && page.setData) page.setData({ themeDark: '' }); }
};

let captured = null;
global.wx = wx;
global.getApp = () => appStub;
global.Page = (cfg) => { captured = cfg; };
global.App = () => {};

// ---------- 加载真实工具与页面代码 ----------
const util = require(U('utils/util'));
const storage = require(U('utils/storage'));
const derive = require(U('utils/derive'));
const backup = require(U('utils/backup'));
const color = require(U('utils/color'));

function loadPage(rel) {
  captured = null;
  require(U(rel));
  if (!captured) throw new Error('Page() 未被调用: ' + rel);
  return captured;
}
const readingCfg = loadPage('pages/reading/reading.js');
const fitnessCfg = loadPage('pages/fitness/fitness.js');
const learningCfg = loadPage('pages/learning/learning.js');
const indexCfg = loadPage('pages/index/index.js');
const profileCfg = loadPage('pages/profile/profile.js');

// ---------- 测试基础设施 ----------
let pass = 0, fail = 0;
const failures = [];
const pendingAsync = [];   // 异步(promise)测试链路，结束后统一等待再汇总
function assert(cond, msg) {
  if (cond) { pass++; } else { fail++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function section(name) { console.log('\n=== ' + name + ' ==='); }

function applySetData(ctx, patch) {
  Object.keys(patch).forEach(k => {
    const v = patch[k];
    if (k.indexOf('.') >= 0) {
      const parts = k.split('.');
      let o = ctx.data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (typeof o[parts[i]] !== 'object' || o[parts[i]] === null) o[parts[i]] = {};
        o = o[parts[i]];
      }
      o[parts[parts.length - 1]] = v;
    } else {
      ctx.data[k] = v;
    }
  });
}

function makeCtx(cfg) {
  const ctx = { data: JSON.parse(JSON.stringify(cfg.data || {})) };
  Object.keys(cfg).forEach(k => {
    if (k === 'data') return;
    if (typeof cfg[k] === 'function') ctx[k] = cfg[k].bind(ctx);
  });
  ctx.setData = (patch, cb) => {
    setDataCalls++;
    if (setDataCalls > SETDATA_HARD_LIMIT) throw new Error('setData 次数超阈值，疑似递归刷新/死循环');
    applySetData(ctx, patch || {});
    if (cb) cb();
  };
  return ctx;
}

function call(fn, arg) {
  setDataCalls = 0; // 每个 handler 调用重置计数
  try {
    fn(arg);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e };
  }
}

function clearStore() { Object.keys(store).forEach(k => delete store[k]); clipboard = ''; }

// =====================================================================
// 测试 1：FAB / 关键 handler 不抛异常 + setData 不超阈值
// =====================================================================
section('1. 各页 onShow/refresh 与关键 handler 基本可用（无异常/无递归）');
{
  const reading = makeCtx(readingCfg);
  let r = call(reading.onShow);
  assert(r.ok, 'reading.onShow 抛错: ' + (r.err && r.err.message));
  assert(setDataCalls <= SETDATA_HARD_LIMIT, 'reading.onShow setData 疑似递归');

  const fitness = makeCtx(fitnessCfg);
  r = call(fitness.onShow);
  assert(r.ok, 'fitness.onShow 抛错: ' + (r.err && r.err.message));

  const learning = makeCtx(learningCfg);
  r = call(learning.onShow);
  assert(r.ok, 'learning.onShow 抛错: ' + (r.err && r.err.message));

  const index = makeCtx(indexCfg);
  r = call(index.onShow);
  assert(r.ok, 'index.onShow 抛错: ' + (r.err && r.err.message));
  // index.refresh 连跑 30 次，确认没有越跑越慢/递归
  let okRefresh = true;
  for (let i = 0; i < 30; i++) { const rr = call(index.refresh); if (!rr.ok) { okRefresh = false; break; } }
  assert(okRefresh, 'index.refresh 连跑 30 次出现抛错');

  const profile = makeCtx(profileCfg);
  r = call(profile.onShow);
  assert(r.ok, 'profile.onShow 抛错: ' + (r.err && r.err.message));
}

// =====================================================================
// 测试 2：健身 #4 单日训练 + 默认今天 + 自动进今日待办（计划预览仅未来日）
// =====================================================================
section('2. 健身：单日训练 + 默认今天 + 仅计划日当天进今日待办(planned) + 完成态同步');
{
  clearStore();
  const fitness = makeCtx(fitnessCfg);
  // 打开新建 → 默认今天
  call(fitness.addWorkout);
  assert(fitness.data.tmpl.date === util.todayISO(), '新建训练默认日期应为今天');
  // 选模板建卡（ppl-push）
  call(fitness.pickTemplate, { currentTarget: { dataset: { key: 'ppl-push' } } });
  const ws = storage.list('workouts');
  assert(ws.length === 1, '应创建 1 条训练');
  assert(ws[0].cycleDays === undefined, '新建训练应为单日，不应有 cycleDays 字段，实际=' + ws[0].cycleDays);
  assert(ws[0].date === util.todayISO(), '新建训练起始日应为今天');

  // 派生：今天训练 → 应出现 1 条「计划预览(planned)」健身待办，且落库（不可手动勾选、由健身页自动同步）
  const todos = derive.deriveDailyTodos();
  const fitPlanned = todos.filter(t => t.source === 'fitness' && t.planned);
  const fitActive = todos.filter(t => t.source === 'fitness' && !t.planned);
  assert(fitPlanned.length === 1, '今天训练应派生 1 条 planned 待办，实际=' + fitPlanned.length);
  assert(fitActive.length === 0, '今天训练不应派生可手动勾选的待办');
  assert(fitPlanned[0].title.indexOf('推日') >= 0, '待办应显示计划名称（推日），实际=' + fitPlanned[0].title);
  // planned 待办应写入存储（供健身页完成后回写 done 自动同步）
  const stored = storage.list('todos');
  assert(stored.some(t => t.source === 'fitness' && t.planned && t.title.indexOf('推日') >= 0), '今天训练 planned 待办应落库');
  assert(stored.some(t => t.planned), 'planned 健身待办应持久化');

  // 非当天（未来）计划：今天不应进今日待办（修复"非计划日也进今日待办"）
  storage.add('workouts', { name: '🌱 新手训练', plan: 'beginner', date: util.addDaysISO(util.todayISO(), 2), items: [], completed: false, createdAt: Date.now() });
  const todos2 = derive.deriveDailyTodos();
  const nwId = storage.list('workouts').find(w => w.name === '🌱 新手训练')._id;
  const np = todos2.find(t => t.source === 'fitness' && t.sourcePlanId === nwId);
  assert(!np, '非计划日(未来)计划今天不应进今日待办(planned)');
  assert(np === undefined || np.done === false, '未完成计划不应已勾选');

  // 在计划日当天打开小程序 → 应派生该训练待办（仅计划日当天出现）
  const plannedDay = util.addDaysISO(util.todayISO(), 2);
  const realToday = util.todayISO;
  util.todayISO = () => plannedDay;
  const todos3 = derive.deriveDailyTodos();
  const np3 = todos3.find(t => t.source === 'fitness' && t.sourcePlanId === nwId);
  assert(np3 && np3.planned, '计划日当天应派生该训练待办(planned)');
  // 完成该计划（在计划日）→ doComplete 按 sourcePlanId + 计划日回写 done
  const nw = storage.list('workouts').find(w => w._id === nwId);
  call(fitness.doComplete, nw, 30);
  const after = storage.list('todos').find(t => t.source === 'fitness' && t.sourcePlanId === nwId);
  assert(after && after.done === true, 'doComplete 应按 sourcePlanId + 计划日把 today planned 待办置 done');
  util.todayISO = realToday;   // 复原 today，避免影响后续测试

  // index 待办计数应排除 planned（恢复真实 today 后仅"今天"训练参与展示）
  const index = makeCtx(indexCfg);
  call(index.onShow);
  const plannedPending = index.data.todos.filter(t => t.planned && !t.done).length;
  assert(plannedPending === 1, '应有 1 条未完成的 planned 待办参与展示（但不计入 pending）');
}

// =====================================================================
// 测试 2b：健身 #4 完成全部阶段 → 今日待办训练任务自动标记完成（缺陷修复）
// =====================================================================
section('2b. 健身：勾满全部阶段自动同步今日待办为已完成（缺陷修复）');
{
  clearStore();
  const fitness = makeCtx(fitnessCfg);
  call(fitness.addWorkout);
  call(fitness.pickTemplate, { currentTarget: { dataset: { key: 'ppl-push' } } });
  const w = storage.list('workouts')[0];
  assert(w && w.items.length > 0, '模板应含训练阶段');
  // 派生今天的 planned 待办
  derive.deriveDailyTodos();
  const before = storage.list('todos').find(t => t.source === 'fitness' && t.sourcePlanId === w._id);
  assert(before && !before.done, '开始前今日待办训练任务应未完成');
  // 逐条勾完所有阶段
  w.items.forEach(it => call(fitness.toggleItem, { currentTarget: { dataset: { w: w._id, i: it._id } } }));
  const wAfter = storage.list('workouts').find(x => x._id === w._id);
  assert(wAfter.completed === true, '勾满全部阶段后训练应标记 completed=true');
  const todoDone = storage.list('todos').some(t => t.source === 'fitness' && t.sourcePlanId === w._id && t.done);
  assert(todoDone, '勾满全部阶段后今日待办的训练任务应自动标记已完成（无需手动勾选首页待办）');
}

// =====================================================================
// 测试 3：学习 #29 图标重设计 + 图鉴删除 + 详情时间
// =====================================================================
section('3. 学习：图标 14 个 + 两排(知识/生活)去图书/健身 + 图鉴长按删除 + 详情含创建/完成时间');
{
  clearStore();
  const learning = makeCtx(learningCfg);
  assert(learning.data.iconOptions.length === 14, '图标应重设计为 14 个（去掉图书/健身），实际=' + learning.data.iconOptions.length);
  assert(Array.isArray(learning.data.iconRows) && learning.data.iconRows.length === 2, '图标应分两排');
  assert(learning.data.iconRows[0].length === 7 && learning.data.iconRows[1].length === 7, '每排应为 7 个图标');
  assert(learning.data.iconOptions.indexOf('📖') < 0, '不应含图书图标📖');
  assert(learning.data.iconOptions.indexOf('🏋') < 0, '不应含健身图标🏋');
  // 建技能
  learning.data.form = { show: true, editId: '', icon: '🌐', name: '学英语', goal: '', cycleDays: '', stages: ['发音', '对话'], error: '' };
  call(learning.saveForm);
  let skills = storage.list('skills');
  assert(skills.length === 1, '应创建 1 个技能');
  const sid = skills[0]._id;
  const createdAt = skills[0].createdAt;
  assert(typeof createdAt === 'number' && createdAt > 0, '技能应有 createdAt');

  // 完成两个阶段 → 进图鉴
  call(learning.toggleStage, { currentTarget: { dataset: { skill: sid, idx: 0 } } });
  call(learning.toggleStage, { currentTarget: { dataset: { skill: sid, idx: 1 } } });
  let badges = storage.list('skillAchieved');
  assert(badges.length === 1, '两阶段完成后应生成 1 枚徽章');
  const bid = badges[0]._id;
  assert(typeof badges[0].stages[0].doneAt === 'number', '徽章阶段应有 doneAt(完成时间)');

  // 打开图鉴详情 → 应含 createdAtLabel 与 stageViews[].doneAtLabel
  call(learning.openBadge, { currentTarget: { dataset: { id: bid } } });
  assert(learning.data.badgeDetail, '应能打开图鉴详情');
  assert(!!learning.data.badgeDetail.createdAtLabel, '详情应展示创建时间 createdAtLabel');
  assert(learning.data.badgeDetail.stageViews.every(sv => !!sv.doneAtLabel), '每个阶段应展示完成时间 doneAtLabel');

  // 图鉴长按删除
  call(learning.delBadge, { currentTarget: { dataset: { id: bid } } });
  assert(storage.list('skillAchieved').length === 0, '长按删除后应移除该徽章');
}

// =====================================================================
// 测试 4：读书 #30 去除计时 + 合并记进度
// =====================================================================
section('4. 读书：计时功能已移除 + 记进度(定位)可用');
{
  clearStore();
  const reading = makeCtx(readingCfg);
  assert(typeof reading.startReadTimer !== 'function', 'startReadTimer 应已移除');
  assert(typeof reading.stopReadTimer !== 'function', 'stopReadTimer 应已移除');
  assert(typeof reading.addOneSection !== 'function', 'addOneSection(读了一节) 应已合并移除');
  assert(typeof reading.openJump === 'function', 'openJump(记进度) 应保留');

  // 加书（章单位）
  reading.data.bookSheet = { show: true, editId: '', title: '人类简史', author: '赫拉利', unit: 'chapter', total: '20', error: '' };
  call(reading.saveBookSheet);
  let books = storage.list('books');
  assert(books.length === 1, '应创建 1 本书');
  const bid = books[0]._id;

  // 记进度（打开定位滑块并提交）
  call(reading.openJump, { currentTarget: { dataset: { id: bid } } });
  assert(reading.data.jump.show === true, 'openJump 应打开定位弹层');
  reading.data.jump.val = 5;
  call(reading.commitJump);
  books = storage.list('books');
  assert(books[0].currentChapter === 5, '记进度后当前章应为 5，实际=' + books[0].currentChapter);
  assert(!('readSeconds' in books[0]), '书数据不应含 readSeconds 计时字段');
}

// =====================================================================
// 测试 5：我的 #32 备份 / 恢复 round-trip
// =====================================================================
section('5. 我的：备份与恢复两端可用（数据一致性）');
{
  clearStore();
  storage.add('books', { title: 'A', status: 'reading', progressType: 'chapter', totalChapters: 10, currentChapter: 3, color: '#000', records: [], createdAt: Date.now() });
  storage.add('skills', { name: 'S', stages: [{ name: 'x', done: false, logs: [] }], createdAt: Date.now() });

  const snap = JSON.parse(backup.snapshotToText());
  assert(snap.counts.books === 1 && snap.counts.skills === 1, '快照应记录正确的计数');
  assert(snap.app === 'baoge-workbench', '快照应有 app 标识');

  // 改数据
  storage.add('books', { title: 'B', status: 'reading', progressType: 'chapter', totalChapters: 5, currentChapter: 1, color: '#111', records: [], createdAt: Date.now() });
  assert(storage.list('books').length === 2, '变更后应 2 本书');

  // 恢复快照
  const applied = backup.applySnapshot(snap);
  assert(applied.books === 1, '恢复后 books 应回到 1');
  assert(storage.list('books').length === 1 && storage.list('books')[0].title === 'A', '恢复应还原为 A');

  // 模拟 profile.importFromClipboard 全流程
  clearStore();
  storage.add('books', { title: 'X', status: 'reading', progressType: 'chapter', totalChapters: 9, currentChapter: 2, color: '#222', records: [], createdAt: Date.now() });
  const txt = backup.snapshotToText();
  clipboard = txt; // 用户把备份复制到剪贴板
  const profile = makeCtx(profileCfg);
  const r = call(profile.importFromClipboard);
  assert(r.ok, 'importFromClipboard 全流程抛错: ' + (r.err && r.err.message));
  assert(storage.list('books').length === 1 && storage.list('books')[0].title === 'X', '从剪贴板恢复应落库');
}

// =====================================================================
// 测试 6：本周待办 固定7天窗口（今天排倒数第三 = 今天-4 ~ 今天+2）
// =====================================================================
section('6. 今日：本周待办固定7天（今天排倒数第三）+ 图标统一');
{
  clearStore();
  const index = makeCtx(indexCfg);
  call(index.onShow);  // onShow 会设置 viewDate 并 refresh
  const cells = index.data.week.cells;
  assert(cells.length === 7, '周待办应有 7 天');
  // 每天都有统一的字段
  const okShape = cells.every(c => 'count' in c && 'pct' in c && 'isToday' in c && 'isSel' in c && 'incomplete' in c);
  assert(okShape, '每天应含统一的 count/pct/isToday/isSel/incomplete 字段');

  // 固定7天窗口：今天排到「倒数第三」 → 索引0=今天-4 … 4=今天 … 6=今天+2
  const todayIdx = cells.findIndex(c => c.isToday);
  assert(todayIdx === 4, '今日应在索引4（倒数第三格），实际=' + todayIdx);
  // 第0格应是今天-4
  assert(cells[0].iso === util.addDaysISO(util.todayISO(), -4), '第0格应为今天-4');
  // 最后1格(索引6)应是今天+2
  assert(cells[6].iso === util.addDaysISO(util.todayISO(), 2), '最后1格应为今天+2');

  // 红/绿双色比例：已完成 pct + 未完成 incomplete = 100（有任务天）
  const withTask = cells.find(c => c.count > 0);
  if (withTask) {
    assert(withTask.pct + withTask.incomplete === 100, '绿(已完成)+红(未完成)比例应加总为100，实际=' + (withTask.pct + withTask.incomplete));
  }
  // 图标统一：所有 cell 都有 wk-track 渲染依据（count/pct）
  const allTrackOk = cells.every(c => typeof c.count === 'number' && typeof c.pct === 'number');
  assert(allTrackOk, '每天都应有 count/pct 供轨道统一渲染');
}

// =====================================================================
// 测试 7：随机卡死专项 —— 高频随机交互
// =====================================================================
section('7. 随机卡死专项：300 次随机交互无抛错/无 setData 失控');
{
  clearStore();
  const reading = makeCtx(readingCfg);
  const fitness = makeCtx(fitnessCfg);
  const learning = makeCtx(learningCfg);
  const index = makeCtx(indexCfg);

  // 预置一些数据，让随机交互有对象可操作
  storage.add('books', { _id: 'b1', title: '书1', status: 'reading', progressType: 'chapter', totalChapters: 10, currentChapter: 0, color: '#000', records: [], createdAt: Date.now() });
  storage.add('skills', { _id: 's1', name: '技1', stages: [{ name: 'a', done: false, logs: [] }, { name: 'b', done: false, logs: [] }], color: '#000', createdAt: Date.now() });
  storage.add('workouts', { _id: 'w1', name: '练1', date: util.todayISO(), cycleDays: 7, items: [{ _id: 'i1', name: '深蹲', sets: [], done: false }], completed: false, createdAt: Date.now() });

  const actors = [
    { ctx: reading, fn: reading.onShow },
    { ctx: reading, fn: reading.refresh },
    { ctx: reading, fn: reading.openJump, a: { currentTarget: { dataset: { id: 'b1' } } } },
    { ctx: reading, fn: reading.addRecord, a: { currentTarget: { dataset: { id: 'b1' } } } },
    { ctx: fitness, fn: fitness.onShow },
    { ctx: fitness, fn: fitness.refreshTrain },
    { ctx: fitness, fn: fitness.toggleItem, a: { currentTarget: { dataset: { w: 'w1', i: 'i1' } } } },
    { ctx: learning, fn: learning.onShow },
    { ctx: learning, fn: learning.toggleStage, a: { currentTarget: { dataset: { skill: 's1', idx: 0 } } } },
    { ctx: index, fn: index.onShow },
    { ctx: index, fn: index.refresh },
    { ctx: index, fn: index.shiftDay, a: { currentTarget: { dataset: { dir: 1 } } } },
    { ctx: index, fn: index.shiftDay, a: { currentTarget: { dataset: { dir: -1 } } } },
    { ctx: index, fn: index.gotoDay, a: { currentTarget: { dataset: { iso: util.todayISO() } } } },
    { ctx: index, fn: index.onViewDatePick, a: { detail: { value: util.addDaysISO(util.todayISO(), 3) } } },
    { ctx: index, fn: index.jumpToday },
    { ctx: index, fn: index.openTodoSheet },
    { ctx: index, fn: index.closeTodoSheet },
  ];

  let errs = 0;
  const N = 300;
  for (let i = 0; i < N; i++) {
    const act = actors[Math.floor(Math.random() * actors.length)];
    const r = call(act.fn.bind(act.ctx), act.a);
    if (!r.ok) { errs++; if (errs <= 3) console.error('    随机交互异常: ' + (r.err && r.err.message)); }
  }
  assert(errs === 0, '随机交互中发生 ' + errs + ' 次异常');
  assert(setDataCalls <= SETDATA_HARD_LIMIT, '随机交互触发 setData 失控（疑似卡死）');
}

// =====================================================================
// 测试 8：学习 #5 时间码去小时(仅日期) + 图鉴滚动态
// =====================================================================
section('8. 学习：时间码仅到日期(去小时) + 图鉴折叠状态');
{
  clearStore();
  const learning = makeCtx(learningCfg);
  learning.data.form = { show: true, editId: '', icon: '🌐', name: '学英语', goal: '', cycleDays: '', stages: ['发音', '对话'], error: '' };
  call(learning.saveForm);
  const sid = storage.list('skills')[0]._id;
  call(learning.toggleStage, { currentTarget: { dataset: { skill: sid, idx: 0 } } });
  call(learning.toggleStage, { currentTarget: { dataset: { skill: sid, idx: 1 } } });
  const bid = storage.list('skillAchieved')[0]._id;
  call(learning.openBadge, { currentTarget: { dataset: { id: bid } } });
  const label = learning.data.badgeDetail.createdAtLabel;
  assert(/^\d+月\d+日$/.test(label), '创建时间应仅到日期(天)、不含时分，实际=' + label);
  assert(label.indexOf(':') < 0, '创建时间码不应含冒号(小时)');
  assert(learning.data.badgeDetail.stageViews.every(sv => sv.doneAtLabel.indexOf(':') < 0), '各阶段完成时间也不含冒号(小时)');
}

// =====================================================================
// 测试 9：读书 #2 记录默认折叠（最后三条）+ 书墙/书架折叠态
// =====================================================================
section('9. 读书：记录默认折叠(最后三条) + 书墙/书架折叠态');
{
  clearStore();
  const reading = makeCtx(readingCfg);
  const recs = [];
  for (let i = 0; i < 6; i++) recs.push({ date: util.addDaysISO(util.todayISO(), -i), chapter: i + 1, note: '笔记' + i, createdAt: Date.now() - i * 1000 });
  storage.add('bookRead', { _id: 'r1', title: '读完书', author: '某', status: 'read', progressType: 'chapter', totalChapters: 6, currentChapter: 6, color: '#000', records: recs, rating: 5, review: '好', tags: [], finishedAt: Date.now(), finishedDate: util.todayISO() });

  // 书墙详情：默认仅 3 条（入口走 showReadDetail，它负责提取 dataset.id）
  call(reading.showReadDetail, { currentTarget: { dataset: { id: 'r1' } } });
  assert(reading.data.readDetail.noteTotal === 6, 'noteTotal 应为 6');
  assert(reading.data.readDetail.noteViews.length === 3, '详情默认仅显示最后 3 条，实际=' + reading.data.readDetail.noteViews.length);
  assert(reading.data.readDetail.noteShowAll === false, '默认未展开全部');
  call(reading.toggleNoteAll);
  assert(reading.data.readDetail.noteViews.length === 6, '展开后应显示全部 6 条');
  assert(reading.data.readDetail.noteShowAll === true, '展开标志应为 true');

  // 书架书卡：recExpanded 默认 false
  storage.add('books', { _id: 'b1', title: '在读', status: 'reading', progressType: 'chapter', totalChapters: 10, currentChapter: 0, color: '#000', records: recs, createdAt: Date.now() });
  call(reading.onShow);
  const bk = reading.data.books.find(b => b._id === 'b1');
  assert(bk.recExpanded === false, '书架书卡记录默认应折叠(recExpanded=false)');
  assert(bk.recordCount === 6, 'recordCount 应为 6');
}

// =====================================================================
// 测试 10：今日 #1 记一笔：直接三天芯片 + 其他日期小图标横排(前7天~后60天)
// =====================================================================
section('10. 今日：记一笔直接展示10天连续芯片(昨天/今天/明天+后续7天) + 内联小日历自定义日期');
{
  clearStore();
  const today = util.todayISO();
  const index = makeCtx(indexCfg);
  call(index.openTodoSheet);
  const chips = index.data.todoSheet.dateChips;
  // 直接展示 昨天(-1) ~ 未来8天(+8) 共 10 天连续快捷选项
  assert(chips.length === 10, '直接时间芯片应为 昨天/今天/明天+后续7天 共 10 个，实际=' + chips.length);
  assert(chips[0].label === '昨天' && chips[0].iso === util.addDaysISO(today, -1), '第0个应为昨天');
  assert(chips[1].label === '今天', '索引1应为今天');
  assert(chips[2].label === '明天', '索引2应为明天');
  assert(chips[9].iso === util.addDaysISO(today, 8), '最后一个应为 今天+8');
  assert(index.data.todoSheet.date === today, '记一笔默认应为今天（viewDate 默认今天）');
  assert(index.data.todoSheet.dateLabel === '今天', '默认日期标签应为「今天」');
  assert(index.data.todoSheet.dateSel === 1, '默认今天应在连续芯片内选中');
  // onTodoChip 切换（选明天）
  call(index.onTodoChip, { currentTarget: { dataset: { idx: 2 } } });
  assert(index.data.todoSheet.dateSel === 2, 'onTodoChip 应更新选中索引');
  assert(index.data.todoSheet.date === chips[2].iso, 'onTodoChip 应更新日期为明天');
  assert(index.data.todoSheet.customDate === '', '选连续芯片时应清空自定义日期');
  // 自定义日期（窗口之外）：通过内联小日历选中 90 天后
  const custom = util.addDaysISO(today, 90);
  call(index.toggleTodoCal);                       // 展开内联小日历
  call(index.onTodoCalDay, { currentTarget: { dataset: { iso: custom } } });
  assert(index.data.todoSheet.date === custom, 'onTodoCalDay 应更新日期');
  assert(index.data.todoSheet.dateLabel === util.formatCN(custom), '自定义日期标签应为中文日期');
  assert(index.data.todoSheet.dateSel === -1, '自定义日期应取消连续芯片选中');
  assert(index.data.todoSheet.customDate === custom, '自定义日期应记录到 customDate');
  assert(index.data.todoSheet.calShow === false, '选自定义日期后内联日历应自动收起');
  // 来源日期落在 10 天窗口内（如 +5）→ 默认选中对应芯片
  index.data.viewDate = util.addDaysISO(today, 5);
  call(index.openTodoSheet);
  const expIdx = index.data.todoSheet.dateChips.findIndex(c => c.iso === index.data.viewDate);
  assert(index.data.todoSheet.dateSel === expIdx, '来源日期在窗口内应默认选中对应芯片');
  // 来源日期超出窗口（如 +90）→ 默认日期=来源日期、customDate 标记、不崩溃
  index.data.viewDate = custom;
  call(index.openTodoSheet);
  assert(index.data.todoSheet.date === custom, '来源日期超窗口应等于来源日期(不回退)');
  assert(index.data.todoSheet.customDate === custom, '超窗口应通过自定义日期承载');
  assert(index.data.todoSheet.dateSel === -1, '超窗口时应无连续芯片选中');
}

// =====================================================================
// 测试 11：读书 #3 自动加入每日待办 默认关 + 仅开启者进首页
// =====================================================================
// =====================================================================
// 测试 10b：今日·日期弹层绿点标记 + 自定义跳转
// =====================================================================
section('10b. 今日：日期弹层绿点标记(有待办日) + 自定义跳转');
{
  clearStore();
  const index = makeCtx(indexCfg);
  // 造一条今天的手动待办 + 一条未来健身计划（未来第3天）
  storage.add('todos', { _id: 't1', title: '今天待办', date: util.todayISO(), source: 'manual', sourceKey: null, sourcePlanId: null, done: false, skipped: false, createdAt: Date.now() });
  const planDay = util.addDaysISO(util.todayISO(), 3);
  storage.add('workouts', { _id: 'w1', name: '未来训练', plan: 'beginner', date: planDay, items: [], completed: false, createdAt: Date.now() });
  call(index.openDateSheet);
  const chips = index.data.dateSheet.chips;
  const todayChip = chips.find(c => c.iso === util.todayISO());
  assert(todayChip && todayChip.hasTodo === true, '今天有待办 → 应标绿点');
  const planChip = chips.find(c => c.iso === planDay);
  assert(planChip && planChip.hasTodo === true, '健身计划日应标绿点');
  const yChip = chips.find(c => c.iso === util.addDaysISO(util.todayISO(), -1));
  assert(yChip && yChip.hasTodo !== true, '无待办日不应标绿点');
  // 自定义跳转：onDateJump 选 planDay → 切换 viewDate 并关闭弹层
  call(index.onDateJump, { detail: { value: planDay } });
  assert(index.data.viewDate === planDay, '自定义跳转应切换到所选日期');
  assert(index.data.dateSheet.show === false, '跳转后应关闭日期弹层');
}

section('11. 读书：自动加入每日待办 默认关 + 仅开启者进首页');
{
  clearStore();
  const reading = makeCtx(readingCfg);
  // 加书（默认 autoTodo=false）
  reading.data.bookSheet = { show: true, editId: '', title: '人类简史', author: '赫拉利', unit: 'chapter', total: '20', autoTodo: false, error: '' };
  call(reading.saveBookSheet);
  let books = storage.list('books');
  assert(books.length === 1, '应创建 1 本书');
  assert(books[0].autoTodo === false, '加书默认不应自动进待办');
  // 默认关 → 首页不应有读书待办
  let todos = derive.deriveDailyTodos();
  assert(!todos.some(t => t.source === 'reading'), '默认关时首页不应出现读书待办');
  // 开启后（需先设目标读完日）→ 聚合一条
  storage.update('books', books[0]._id, { autoTodo: true, deadline: util.addDaysISO(util.todayISO(), 5) });
  todos = derive.deriveDailyTodos();
  const rTodos = todos.filter(t => t.source === 'reading');
  assert(rTodos.length === 1 && rTodos[0].sourceKey === 'reading:today', '开启后首页应聚合 1 条读书待办（恒定 key）');
  // 再次关闭 → 消失
  storage.update('books', books[0]._id, { autoTodo: false });
  todos = derive.deriveDailyTodos();
  assert(!todos.some(t => t.source === 'reading'), '关闭后首页读书待办应消失');

  // ===== Round 9：自动待办门禁 + 目标读完日窗口 =====
  const bid = books[0]._id;
  // 1) 无目标读完日 → 即使 autoTodo=true 也不派生（derive 要求 deadline 且 today<=deadline）
  storage.update('books', bid, { autoTodo: true, deadline: '' });
  todos = derive.deriveDailyTodos();
  assert(!todos.some(t => t.source === 'reading'), '未设目标读完日时即使开启自动待办也不应进首页');
  // 2) 设未来目标读完日 → 今天(<=deadline)应派生
  storage.update('books', bid, { deadline: util.addDaysISO(util.todayISO(), 5) });
  todos = derive.deriveDailyTodos();
  assert(todos.some(t => t.source === 'reading' && t.sourceKey === 'reading:today'), '设目标读完日(未来)且开启 → 今天应进首页');
  // 3) 目标读完日已过期 → 不再派生
  storage.update('books', bid, { deadline: util.addDaysISO(util.todayISO(), -1) });
  todos = derive.deriveDailyTodos();
  assert(!todos.some(t => t.source === 'reading'), '目标读完日已过期 → 不应再进首页');
  // 4) 管理菜单(editMenu) 开启自动待办需目标读完日
  storage.update('books', bid, { deadline: '', autoTodo: false });
  call(reading.editMenu, { currentTarget: { dataset: { id: bid } } });
  assert(storage.list('books').find(b => b._id === bid).autoTodo === false, 'editMenu 未设目标读完日时不应开启自动待办');
  storage.update('books', bid, { deadline: util.addDaysISO(util.todayISO(), 3) });
  call(reading.editMenu, { currentTarget: { dataset: { id: bid } } });
  assert(storage.list('books').find(b => b._id === bid).autoTodo === true, 'editMenu 设目标读完日后可开启自动待办');
}

// =====================================================================
// 测试 12：今日 #6 本周成长读书统计=完本数量
// =====================================================================
section('12. 今日：本周成长 · 读书统计=完本数量');
{
  clearStore();
  const reading = makeCtx(readingCfg);
  storage.add('books', { _id: 'b1', title: 'A', status: 'reading', progressType: 'chapter', totalChapters: 10, currentChapter: 3, color: '#000', records: [], createdAt: Date.now() });
  storage.add('books', { _id: 'b2', title: 'B', status: 'reading', progressType: 'chapter', totalChapters: 10, currentChapter: 0, color: '#000', records: [], createdAt: Date.now() });
  storage.add('books', { _id: 'b3', title: 'C', status: 'reading', progressType: 'chapter', totalChapters: 10, currentChapter: 5, color: '#000', records: [], createdAt: Date.now() });
  storage.add('bookRead', { _id: 'r1', title: 'A', status: 'read', progressType: 'chapter', totalChapters: 10, currentChapter: 10, color: '#000', records: [], finishedAt: Date.now(), finishedDate: util.todayISO() });
  storage.add('bookRead', { _id: 'r2', title: 'B', status: 'read', progressType: 'chapter', totalChapters: 10, currentChapter: 10, color: '#000', records: [], finishedAt: Date.now(), finishedDate: util.todayISO() });
  const index = makeCtx(indexCfg);
  call(index.onShow);
  const ov = index.data.overview.reading;
  assert(ov.finished === 2, '读书统计·本周完本应为 2（bookRead 落周按 _id 去重），实际=' + ov.finished);
  assert(ov.days === 1, '读书统计·翻阅天应同日去重为 1（两本同在今天读完），实际=' + ov.days);
  const dow = new Date().getDay();
  const elapsed = dow === 0 ? 7 : dow;
  assert(ov.percent === Math.round(ov.days * 100 / elapsed), '读书统计·进度=翻阅天/周内已过天，实际=' + ov.percent);
  assert(typeof ov.sub === 'string', '读书卡应有副行说明 sub');
}

// =====================================================================
// 测试 13：任务6 真机修复 —— 云同步开启且 cloud.database() 抛异常时，保存仍成功
// （验证 storage.syncToCloud 已把 database() 包进 try/catch，不再中断 storage.add）
// =====================================================================
section('13. 任务6：云同步异常下 记一笔/倒记时 仍能保存');
{
  clearStore();
  // 模拟真机：用户开了云同步，但 wx.cloud.database() 会抛（环境未初始化）
  appStub.globalData.cloudSync = true;
  wx.cloud = {
    database() { throw new Error('cloud not initialized (simulated)'); }
  };
  const index = makeCtx(indexCfg);
  // 记一笔
  call(index.openTodoSheet);
  index.data.todoSheet.title = '真机测试待办';
  const r1 = call(index.saveTodo);
  assert(r1.ok, '云同步异常时 saveTodo 不应抛异常');
  assert(storage.list('todos').some(t => t.title === '真机测试待办'), '记一笔应已落库（未被 cloud 异常中断）');
  // 倒记时（先选一个未来日期，saveCd 强制需选日期）
  call(index.openCdSheet);
  index.data.cdSheet.name = '真机测试倒计时';
  index.data.cdSheet.date = util.addDaysISO(util.todayISO(), 5);
  index.data.cdSheet.dateLabel = util.formatCN(index.data.cdSheet.date);
  const r2 = call(index.saveCd);
  assert(r2.ok, '云同步异常时 saveCd 不应抛异常');
  assert(storage.list('countdown').some(c => c.name === '真机测试倒计时'), '倒记时应已落库（未被 cloud 异常中断）');
  // 复原：关云同步、清 wx.cloud，避免影响后续测试
  appStub.globalData.cloudSync = false;
  delete wx.cloud;
}

// =====================================================================
// 测试 14：任务7 读书进度 100% 自动上墙 + 管理菜单「读完全本」
// =====================================================================
section('14. 任务7：进度100%弹出评分(必填)界面 + 读完全本');
{
  clearStore();
  const reading = makeCtx(readingCfg);
  // 用章节书，进度 0 → 10（100%）
  storage.add('books', { _id: 'bk', title: '自控力', status: 'reading', progressType: 'chapter', totalChapters: 10, currentChapter: 0, color: '#000', records: [], createdAt: Date.now() });
  // 记进度到满 —— commitProgress 需多参，直接调用（桩 call 仅转发单参）
  reading.commitProgress('bk', 10, false);
  // 进度满应先弹出「上墙」填写界面，而非直接置已读
  assert(reading.data.finishSheet && reading.data.finishSheet.show === true, '进度到100%应弹出评分填写界面');
  assert(storage.list('books').find(b => b._id === 'bk').status !== 'read', '未提交评分前不应已上墙');
  // 评分必填：rating 为空时提交应被拦截
  const r0 = call(reading.saveFinish);
  assert(r0.ok, 'saveFinish 不应抛异常');
  assert(storage.list('books').find(b => b._id === 'bk').status !== 'read', '缺评分时不应上墙（评分必填）');
  // 补评分后提交 → 上墙
  reading.data.finishSheet.rating = 5;
  reading.data.finishSheet.review = '五星好书';
  call(reading.saveFinish);
  assert(storage.list('books').find(b => b._id === 'bk').status === 'read', '评分后进度到100%应自动置为已读');
  assert(storage.list('bookRead').some(r => r._id === 'bk'), '进度到100%应自动上墙（推书脊墙）');
  assert(storage.list('bookRead').find(r => r._id === 'bk').rating === 5, '上墙应写入评分');
  assert(storage.list('bookRead').find(r => r._id === 'bk').review === '五星好书', '上墙应写入书评');

  // 记一笔推进到满也应弹评分界面（chapter 单位，逐节推进）
  clearStore();
  storage.add('books', { _id: 'bk2', title: '原则', status: 'reading', progressType: 'chapter', totalChapters: 2, currentChapter: 0, color: '#000', records: [], createdAt: Date.now() });
  reading.data.bookSheet = { show: false };
  call(reading.addRecord, { currentTarget: { dataset: { id: 'bk2' } } });   // 自动确认 modal，推进 1 节
  call(reading.addRecord, { currentTarget: { dataset: { id: 'bk2' } } });   // 再推进 1 节 → 100%
  assert(reading.data.finishSheet && reading.data.finishSheet.show === true, '记一笔逐节推进到100%应弹评分界面');
  reading.data.finishSheet.rating = 4;
  call(reading.saveFinish);
  assert(storage.list('books').find(b => b._id === 'bk2').status === 'read', '记一笔逐节推进到100%应自动上墙');

  // 管理菜单「读完全本」(tapIndex=1) → 也应弹评分界面
  clearStore();
  storage.add('books', { _id: 'bk3', title: '穷查理宝典', status: 'reading', progressType: 'page', totalPages: 30, currentPage: 5, color: '#000', records: [], createdAt: Date.now() });
  const origSheet = wx.showActionSheet;
  wx.showActionSheet = (opts) => { if (opts && opts.success) opts.success({ tapIndex: 1 }); };  // 命中「读完全本」
  call(reading.editMenu, { currentTarget: { dataset: { id: 'bk3' } } });   // 自动确认 modal → openFinishSheet
  wx.showActionSheet = origSheet;
  assert(reading.data.finishSheet && reading.data.finishSheet.show === true, '「读完全本」应弹评分界面');
  reading.data.finishSheet.rating = 5;
  call(reading.saveFinish);
  assert(storage.list('books').find(b => b._id === 'bk3').status === 'read', '「读完全本」评分后应置为已读');
  assert(storage.list('bookRead').some(r => r._id === 'bk3' && r.currentPage === 30), '「读完全本」应把进度补满(30页)并上墙');
}

// =====================================================================
// 测试 15：任务4 导出成长报告（月度/年度/全部 HTML）
// =====================================================================
section('15. 任务4：成长报告 HTML 生成（月度/年度/全部）');
{
  clearStore();
  const profile = makeCtx(profileCfg);
  storage.add('bookRead', { _id: 'r1', title: 'A', status: 'read', finishedAt: Date.now(), finishedDate: util.todayISO(), rating: 5, records: [] });
  storage.add('skillAchieved', { _id: 's1', name: '摄影', icon: '📷', achievedAt: Date.now(), stages: [{ name: '布光' }] });
  storage.add('workouts', { _id: 'w1', name: '练', date: util.todayISO(), items: [], completed: false, createdAt: Date.now() });
  storage.add('todos', { _id: 't1', title: 'x', date: util.todayISO(), done: true, source: 'manual' });
  ['month', 'year', 'all'].forEach(period => {
    const html = profile.buildReportHtml(period);
    assert(typeof html === 'string' && html.indexOf('宝哥成长报告') >= 0, '[' + period + '] 报告应包含标题');
    assert(html.indexOf('<!DOCTYPE html>') === 0, '[' + period + '] 应为完整 HTML 文档');
    assert(html.indexOf('本读完') >= 0 && html.indexOf('新达成技能') >= 0, '[' + period + '] 应含读书/学习板块');
  });
}

// =====================================================================
// 测试 16：任务5 本周待办 红/绿比例（pct + incomplete = 100）
// =====================================================================
section('16. 任务5：本周待办 红(未完成)/绿(已完成) 比例正确');
{
  clearStore();
  // 构造今天 3 条待办，其中 1 条已完成 → 今天 pct=33, incomplete=67
  const today = util.todayISO();
  storage.add('todos', { _id: 'a', date: today, done: false, source: 'manual', title: '1' });
  storage.add('todos', { _id: 'b', date: today, done: false, source: 'manual', title: '2' });
  storage.add('todos', { _id: 'c', date: today, done: true, source: 'manual', title: '3' });
  const index = makeCtx(indexCfg);
  call(index.onShow);
  const todayCell = index.data.week.cells.find(c => c.isToday);
  assert(todayCell.count === 3, '今天应有 3 条待办');
  assert(todayCell.pct === 33, '今天已完成比例应为 33%，实际=' + todayCell.pct);
  assert(todayCell.incomplete === 67, '今天未完成比例应为 67%，实际=' + todayCell.incomplete);
  assert(todayCell.pct + todayCell.incomplete === 100, '红绿比例之和应为 100');
}

// =====================================================================
// 测试 17：任务1 空状态每日轮换激励语 稳定可生成
// =====================================================================
section('17. 任务1：空状态激励语');
{
  clearStore();
  const index = makeCtx(indexCfg);
  const q = index.pickDailyQuote();
  assert(typeof q === 'string' && q.length > 0, 'pickDailyQuote 应返回非空字符串');
  // 今天无任何待办 → emptyQuote 应被赋值
  call(index.onShow);
  assert(index.data.emptyQuote && index.data.emptyQuote.length > 0, '今天无待办时 emptyQuote 应被赋值');
}

// =====================================================================
// 测试 18：任务1 今日页搜索待办功能已移除
// =====================================================================
section('18. 任务1：今日页搜索待办功能已移除');
{
  clearStore();
  const index = makeCtx(indexCfg);
  assert(typeof index.onTodoSearch !== 'function', 'onTodoSearch 应已删除');
  assert(typeof index.applySearch !== 'function', 'applySearch 应已删除');
  assert(typeof index.clearTodoSearch !== 'function', 'clearTodoSearch 应已删除');
  assert(!('todoSearch' in index.data), 'data 不应含 todoSearch 字段');
  const r = call(index.onShow);
  assert(r.ok, '移除搜索后 onShow/refresh 仍应无异常');
}

// =====================================================================
// 测试 19：任务2 健身自动添加今日待办 · 时间显示准确（startedAt 保留）
// =====================================================================
section('19. 任务2：健身今日训练时间显示准确（完成后保留开始时间）');
{
  clearStore();
  const fitness = makeCtx(fitnessCfg);
  call(fitness.addWorkout);   // 默认今天
  call(fitness.pickTemplate, { currentTarget: { dataset: { key: 'ppl-push' } } });
  const w = storage.list('workouts')[0];
  assert(w.startedAt && typeof w.startedAt === 'number', '今日训练应带 startedAt（自动计时起点）');
  // 完成全部动作 → 触发自动 completed
  const wid = w._id;
  w.items.forEach(it => call(fitness.toggleItem, { currentTarget: { dataset: { w: wid, i: it._id } } }));
  const w2 = storage.list('workouts')[0];
  assert(w2.completed === true, '所有动作完成应标记 completed');
  // 关键：完成后 startedAt 不得被置空（否则训练卡"起"时间丢失 → 时间显示错误）
  assert(w2.startedAt && typeof w2.startedAt === 'number', '完成后 startedAt 应保留（时间显示准确）');
  call(fitness.refreshTrain);
  // 完成后该训练已收纳进「历史训练」专区（workouts 仅含未完成）
  const card = fitness.data.historyWorkouts.find(x => x._id === wid);
  assert(card, '完成后训练应进「历史训练」专区（historyWorkouts）');
  assert(card.timeText.indexOf('起') >= 0, '训练卡时间应包含"起"（开始时间），实际=' + card.timeText);
}

// =====================================================================
// 测试 20：任务3 倒计时时间选择器（快捷芯片 + 禁选过去）
// =====================================================================
section('20. 今日：倒计时仅自定义(移除周/月/三月预设) + 农历选择 + 禁选过去');
{
  clearStore();
  const index = makeCtx(indexCfg);
  call(index.openCdSheet);
  // 不应再有预设快捷芯片（一周后/一月后/三月后），仅自定义 + 农历
  const cs = index.data.cdSheet;
  assert(!cs.dateChips || cs.dateChips.length === 0, '倒计时应不再有预设快捷芯片（仅自定义+农历）');
  assert(cs.cdType === 'solar', '默认应为公历选择');
  assert(Array.isArray(cs.lunarYears) && cs.lunarYears.length > 0, '应初始化农历年份列表');
  assert(!cs.date, '默认未选日期');
  // 选公历未来日期 → 成功
  cs.name = '将来事件';
  cs.date = util.addDaysISO(util.todayISO(), 5);
  cs.dateLabel = util.formatCN(cs.date);
  call(index.saveCd);
  assert(storage.list('countdown').some(c => c.name === '将来事件'), '未来日期倒计时应成功添加');
  // 不选日期保存 → 拒绝
  clearStore();
  call(index.openCdSheet);
  index.data.cdSheet.name = '无名';
  call(index.saveCd);
  assert(!storage.list('countdown').some(c => c.name === '无名'), '未选日期应被拒绝');
  // 一次性事件选过去日期 → 拒绝
  index.data.cdSheet.name = '过去事件';
  index.data.cdSheet.date = util.addDaysISO(util.todayISO(), -1);
  index.data.cdSheet.annual = false;
  call(index.saveCd);
  assert(!storage.list('countdown').some(c => c.name === '过去事件'), '一次性事件选过去日期应被拒绝');
  // 农历：切到农历并选择具体日期 → 应计算出公历日期
  call(index.onCdType, { currentTarget: { dataset: { type: 'lunar' } } });
  assert(index.data.cdSheet.cdType === 'lunar', '应切换到农历选择');
  call(index.onCdLunarDay, { detail: { value: [0] } });
  assert(/^\d{4}-\d{2}-\d{2}$/.test(index.data.cdSheet.date), '农历选择应计算出合法公历日期');
  assert(typeof index.data.cdSheet.solarRef === 'string' && index.data.cdSheet.solarRef.length > 0, '农历选择应给出公历参考(solarRef)');
  // 一次性事件选"过去"的农历日期 → 拒绝（整体删除今天之前的日期选项）
  index.data.cdSheet.name = '农历过去';
  index.data.cdSheet.annual = false;
  index.data.cdSheet.date = util.addDaysISO(util.todayISO(), -1);
  index.data.cdSheet.dateLabel = util.formatCN(index.data.cdSheet.date);
  call(index.saveCd);
  assert(!storage.list('countdown').some(c => c.name === '农历过去'), '一次性事件选过去(农历映射)日期应被拒绝');
  // 选未来年份的农历日期 → 应可成功保存
  const lunarYears = index.data.cdSheet.lunarYears;
  if (lunarYears.length > 1) {
    index.data.cdSheet.name = '农历将来';
    index.data.cdSheet.annual = false;
    index.data.cdSheet.lunarYearIdx = 1;
    call(index.onCdLunarYear, { detail: { value: [1] } });
    call(index.onCdLunarDay, { detail: { value: [0] } });
    call(index.saveCd);
    assert(storage.list('countdown').some(c => c.name === '农历将来'), '未来农历日期应可成功添加倒计时');
  }
}

// =====================================================================
// 测试 20b：倒计时 · 公历点选方框即时反馈（isSel 重算，非延后）
// =====================================================================
section('20b. 倒计时公历点选 · 选中方框即时反馈(isSel 重算)');
{
  clearStore();
  const index = makeCtx(indexCfg);
  call(index.openCdSheet);
  const target = util.addDaysISO(util.todayISO(), 5);
  call(index.onCdCalDay, { currentTarget: { dataset: { iso: target } } });
  const cs = index.data.cdSheet;
  assert(cs.date === target, 'onCdCalDay 应设置选中日期');
  // setData 回调已同步调用 buildCdCal 重算 isSel → 恰好一个选中格
  const sel = cs.calDays.filter(c => !c.empty && c.isSel);
  assert(sel.length === 1, '月历应恰好一个选中格(方框即时反馈)，实际=' + sel.length);
  assert(sel[0].iso === target, '选中格应为点击的日期');
  // 再点另一天 → 选中态切换（旧的不再选中，避免延后/残留）
  const target2 = util.addDaysISO(util.todayISO(), 6);
  call(index.onCdCalDay, { currentTarget: { dataset: { iso: target2 } } });
  const sel2 = index.data.cdSheet.calDays.filter(c => !c.empty && c.isSel);
  assert(sel2.length === 1 && sel2[0].iso === target2, '切换选中后旧格不应仍选中');
}

// =====================================================================
// 测试 20c：倒计时 · 同步展示对应农历日期（保存/回显 lunar）
// =====================================================================
section('20c. 倒计时 · 同步展示对应农历日期(lunar)');
{
  clearStore();
  const index = makeCtx(indexCfg);
  call(index.openCdSheet);
  const cs = index.data.cdSheet;
  cs.name = '生日';
  cs.date = '2026-10-01';
  cs.dateLabel = util.formatCN(cs.date);
  cs.annual = true;
  call(index.saveCd);
  const cd = storage.list('countdown').find(c => c.name === '生日');
  assert(cd && typeof cd.lunar === 'string' && cd.lunar.indexOf('农历') === 0, 'saveCd 应记录对应农历日期，实际=' + (cd && cd.lunar));
  const item = index.buildCountdown().find(c => c.name === '生日');
  assert(item && typeof item.lunar === 'string' && item.lunar.indexOf('农历') === 0, 'buildCountdown 应回显农历标签');
}

// =====================================================================
// 测试 19b：健身 · 提前完成未来日期计划不误删其待办（保留已完成）
// =====================================================================
section('19b. 健身：提前完成未来日期计划不误删待办(保留已完成)');
{
  clearStore();
  const fitness = makeCtx(fitnessCfg);
  const tomorrow = util.addDaysISO(util.todayISO(), 1);
  storage.add('workouts', { _id: 'fw1', name: '明天练', date: tomorrow,
    items: [{ _id: 'i1', name: '深蹲', target: '3组', sets: [], done: false }], completed: false, startedAt: null });
  // 先为明天派生（落库 planned 待办）
  derive.deriveDailyTodos(tomorrow);
  const before = storage.list('todos').find(t => t.source === 'fitness' && t.sourcePlanId === 'fw1' && t.date === tomorrow);
  assert(before && before.done === false, '明天计划应在明天派生出未完成的 planned 待办');
  // 提前（今天）完成该未来计划
  const w = storage.list('workouts').find(x => x._id === 'fw1');
  call(fitness.doComplete, w, 45);
  // 再次派生明天 → 该 planned 待办应仍在且 done=true（不被清理误删）
  derive.deriveDailyTodos(tomorrow);
  const after = storage.list('todos').find(t => t.source === 'fitness' && t.sourcePlanId === 'fw1' && t.date === tomorrow);
  assert(after && after.done === true, '提前完成后，明天对应待办应保留为已完成(done)，不应被误删');
}

// =====================================================================
// 测试 19c：健身 · 历史训练专区（已完成收纳、默认折叠）
// =====================================================================
section('19c. 健身：历史训练专区(已完成收纳、默认折叠)');
{
  clearStore();
  const fitness = makeCtx(fitnessCfg);
  storage.add('workouts', { _id: 'a1', name: '待练', date: util.todayISO(), items: [], completed: false, startedAt: Date.now() });
  storage.add('workouts', { _id: 'h1', name: '已完', date: util.addDaysISO(util.todayISO(), -1), items: [], completed: true, completedAt: Date.now(), startedAt: Date.now() });
  call(fitness.refreshTrain);
  assert(fitness.data.workouts.length === 1 && fitness.data.workouts[0]._id === 'a1', '未完成训练应在主列表');
  assert(fitness.data.historyWorkouts.length === 1 && fitness.data.historyWorkouts[0]._id === 'h1', '已完成训练应进历史专区');
  assert(fitness.data.showHistory === false, '历史专区默认折叠');
  call(fitness.toggleHistory);
  assert(fitness.data.showHistory === true, 'toggleHistory 应展开历史专区');
}

// =====================================================================
// 测试 21：任务4 读书 100% 弹评分界面（评分必填 / 书评选填）
// （主流程见测试14；此处聚焦必填校验与 review 可空）
// =====================================================================
section('21. 任务4：读书满100%弹窗 · 评分必填 / 书评选填');
{
  clearStore();
  const reading = makeCtx(readingCfg);
  storage.add('books', { _id: 'x', title: '书', status: 'reading', progressType: 'percent', totalChapters: 0, currentChapter: 0, progressPercent: 0, color: '#000', records: [], createdAt: Date.now() });
  reading.commitProgress('x', 100, false);
  assert(reading.data.finishSheet && reading.data.finishSheet.show === true, '满100%应弹评分界面');
  // 评分必填：rating=0 提交应拦截
  reading.data.finishSheet.rating = 0;
  call(reading.saveFinish);
  assert(storage.list('books').find(b => b._id === 'x').status !== 'read', 'rating=0 不应上墙（必填）');
  // 书评选填：不给 review 也能上墙
  reading.data.finishSheet.rating = 3;
  call(reading.saveFinish);
  assert(storage.list('books').find(b => b._id === 'x').status === 'read', '给评分后即可上墙');
  assert(storage.list('bookRead').find(r => r._id === 'x').rating === 3, '应写入评分');
}

// =====================================================================
// 测试 22：任务5 学习阶段完成记录完成日期（精度到天）
// =====================================================================
section('22. 任务5：学习阶段完成记录 doneDate（YYYY-MM-DD）');
{
  clearStore();
  const learning = makeCtx(learningCfg);
  learning.data.form = { show: true, editId: '', icon: '🌐', name: '学英语', goal: '', cycleDays: '', stages: ['发音', '对话'], error: '' };
  call(learning.saveForm);
  const sid = storage.list('skills')[0]._id;
  call(learning.toggleStage, { currentTarget: { dataset: { skill: sid, idx: 0 } } });
  const st = storage.list('skills')[0].stages[0];
  assert(typeof st.doneDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(st.doneDate), '完成阶段应记录 doneDate(YYYY-MM-DD)，实际=' + st.doneDate);
  assert(st.doneAt && typeof st.doneAt === 'number', 'doneAt 时间戳也应保留');
  // 图鉴详情应含 doneDateLabel
  call(learning.toggleStage, { currentTarget: { dataset: { skill: sid, idx: 1 } } });
  const bid = storage.list('skillAchieved')[0]._id;
  call(learning.openBadge, { currentTarget: { dataset: { id: bid } } });
  assert(learning.data.badgeDetail.stageViews[0].doneDateLabel === st.doneDate, '图鉴详情应展示阶段完成日期 doneDateLabel');
}

// =====================================================================
// 测试 23：任务6 我的页备份/导出机制（入口齐全 + 结构调整无异常）
// =====================================================================
section('23. 我的：备份与导出入口（复制进度速览 已下架）');
{
  clearStore();
  const profile = makeCtx(profileCfg);
  assert(typeof profile.exportToFile === 'function', '一键备份 exportToFile 应存在');
  assert(typeof profile.exportReport === 'function', '导出成长报告应存在');
  assert(typeof profile.copyJson === 'function', '复制完整备份应存在');
  assert(typeof profile.copySummary !== 'function', '「复制进度速览」应已下架');
  assert(typeof profile.importFromFile === 'function' && typeof profile.importFromClipboard === 'function', '恢复入口应存在');
  const r = call(profile.onShow);
  assert(r.ok, 'profile onShow 结构调整后应无异常');
}

// =====================================================================
// 测试 24：模块三·健身模板调整（移除五分化/全身循环，新增空「新手训练」，保留三分化）
// =====================================================================
section('24. 健身：模板调整（移除五分化/全身循环 + 新增空「新手训练」+ 保留三分化）');
{
  clearStore();
  const fitness = makeCtx(fitnessCfg);
  const list = fitness.data.tplList;
  const keys = list.map(t => t.key);
  assert(keys.indexOf('beginner') >= 0, '应新增「新手训练」模板');
  const beginner = list.find(t => t.key === 'beginner');
  assert(beginner && beginner.moves.length === 0, '新手训练应为空模板（不预设内容，用户自行自定义）');
  assert(keys.indexOf('ppl-push') >= 0 && keys.indexOf('ppl-pull') >= 0 && keys.indexOf('ppl-legs') >= 0, '应保留三分化(ppl)模板');
  ['bro-chest', 'bro-back', 'bro-legs', 'bro-shoulder', 'bro-arm', 'full-body'].forEach(k =>
    assert(keys.indexOf(k) < 0, '不应再有模板: ' + k));
  // 行为：新手训练建卡后动作列表为空（用户后加）
  call(fitness.addWorkout);
  call(fitness.pickTemplate, { currentTarget: { dataset: { key: 'beginner' } } });
  const w = storage.list('workouts').find(x => x.plan === 'beginner');
  assert(w && w.items.length === 0, '新手训练建卡后动作列表应为空');
}

// =====================================================================
// 测试 25：模块四·学习「加入今日待办」默认关 + 自动加入时不显示阶段信息
// =====================================================================
section('25. 学习：新建技能不再有「加入今日待办」+ 阶段输入自动新增');
{
  clearStore();
  const learning = makeCtx(learningCfg);
  // 新建表单不应再有 addToTodo 字段 / 处理
  call(learning.addSkill);
  assert(learning.data.form.addToTodo === undefined, '新建技能表单不应再有 addToTodo 字段');
  assert(typeof learning.onFormAddTodo !== 'function', 'onFormAddTodo 应已删除');
  // 创建技能 → 不再派生学习待办（学习计划跟进统一在「在学」页）
  learning.data.form = { show: true, editId: '', icon: '🌐', name: '学英语', goal: '', cycleDays: '', stages: ['发音', '对话'], error: '' };
  call(learning.saveForm);
  let todos = derive.deriveDailyTodos();
  assert(!todos.some(t => t.source === 'learning'), '学习不再进首页今日待办');
  // 阶段输入即自动新增一个阶段：编辑最后一个阶段且有内容时，自动补一个空阶段
  call(learning.addSkill);
  assert(learning.data.form.stages.length === 1 && learning.data.form.stages[0] === '', '新表单应仅有 1 个空阶段');
  call(learning.onStageInput, { currentTarget: { dataset: { idx: 0 } }, detail: { value: '第一阶段' } });
  assert(learning.data.form.stages.length === 2, '输入末阶段后应自动新增一个空阶段');
  assert(learning.data.form.stages[1] === '', '自动新增的阶段应为空');
}

// =====================================================================
// 测试 26：模块二·读书书摘本（笔记按书归档 + 全局搜索 + 单本导出 Markdown）
// =====================================================================
section('26. 读书：书摘本功能已下架 + 加书书名查重 + 读书笔记导出保留');
{
  clearStore();
  const reading = makeCtx(readingCfg);
  assert(typeof reading.buildExcerpts !== 'function', 'buildExcerpts 应已下架');
  assert(typeof reading.openExcerptBook !== 'function', 'openExcerptBook 应已下架');
  assert(typeof reading.exportExcerptMd !== 'function', 'exportExcerptMd 应已下架');
  assert(typeof reading.data.isExcerpt === 'undefined', 'data 不应含 isExcerpt');
  assert(typeof reading.exportNotes === 'function', '读书笔记 Markdown 导出应保留');
  // 加书书名查重：同名书应被拦截
  reading.data.bookSheet = { show: true, editId: '', title: '人类简史', author: '赫拉利', unit: 'chapter', total: '20', autoTodo: false, error: '' };
  call(reading.saveBookSheet);
  assert(storage.list('books').length === 1, '应创建 1 本《人类简史》');
  reading.data.bookSheet = { show: true, editId: '', title: '人类简史', author: '赫拉利', unit: 'chapter', total: '20', autoTodo: false, error: '' };
  call(reading.saveBookSheet);
  assert(storage.list('books').length === 1, '同名书《人类简史》应被查重拦截，仍为 1 本');
  // 不同名可正常创建
  reading.data.bookSheet = { show: true, editId: '', title: '原则', author: '达利欧', unit: 'chapter', total: '20', autoTodo: false, error: '' };
  call(reading.saveBookSheet);
  assert(storage.list('books').length === 2, '不同书名应可正常新增');
}

// =====================================================================
// 测试 28：农历转换（solarToLunar / lunarToSolar）正确性
// =====================================================================
section('28. 工具：农历转换（公历↔农历）');
{
  clearStore();
  // 已知锚点：2025-01-29 为乙巳年（蛇年）正月初一
  const l1 = util.solarToLunar('2025-01-29');
  assert(l1.year === 2025 && l1.month === 1 && l1.day === 1 && !l1.isLeap, '2025-01-29 应为农历乙巳年正月初一');
  assert(l1.zodiac === '蛇', '2025 生肖应为蛇，实际=' + l1.zodiac);
  assert(util.lunarToSolar(2025, 1, 1, false) === '2025-01-29', '农历2025正月初一应回算为 2025-01-29');
  // 反向一致性：任取若干公历日，农历→公历→农历应还原
  ['2026-02-17', '2026-09-05', '2030-01-01', '2024-12-25'].forEach(iso => {
    const ln = util.solarToLunar(iso);
    const back = util.lunarToSolar(ln.year, ln.month, ln.day, ln.isLeap);
    const ln2 = util.solarToLunar(back);
    assert(ln2.year === ln.year && ln2.month === ln.month && ln2.day === ln.day && ln2.isLeap === ln.isLeap,
      '农历往返应一致: ' + iso + ' → ' + ln.label + ' → ' + back);
  });
  // 闰月存在性检查：2025 年有闰六月（公历 2025-07-25 为闰六月初一）
  const leapFirst = util.solarToLunar('2025-07-25');
  assert(leapFirst.isLeap && leapFirst.month === 6, '2025-07-25 应为闰六月初一，实际=' + leapFirst.label);
}

// =====================================================================
// 测试 27：模块五·成长报告 buildReportModel 正确 + 长图导出不抛异常(降级 HTML)
// =====================================================================
section('27. 我的：成长报告 buildReportModel 正确 + 长图导出不抛异常(降级 HTML)');
{
  clearStore();
  const profile = makeCtx(profileCfg);
  storage.add('bookRead', { _id: 'r1', title: 'A', status: 'read', finishedAt: Date.now(), finishedDate: util.todayISO(), rating: 5, records: [] });
  storage.add('skillAchieved', { _id: 's1', name: '摄影', icon: '📷', achievedAt: Date.now(), stages: [{ name: '布光', done: true }] });
  storage.add('workouts', { _id: 'w1', name: '练', date: util.todayISO(), items: [], completed: false, createdAt: Date.now() });
  storage.add('todos', { _id: 't1', title: 'x', date: util.todayISO(), done: true, source: 'manual' });
  const model = profile.buildReportModel('all');
  assert(model.hero[0].n === 1, 'hero 本读完应为 1');
  assert(model.hero[1].n === 1, 'hero 新达成技能应为 1');
  assert(model.hero[2].n === 1, 'hero 次训练应为 1');
  assert(model.reading.readCount === 1, '本期读完应为 1');
  assert(model.todo.done === 1 && model.todo.total === 1, '本期待办应 1/1 完成');
  // 长图导出（canvas 桩不会真正出图，应降级或静默，不抛异常）
  const r = call(profile.doExportReport, 'all');
  assert(r.ok, 'doExportReport 不应抛异常: ' + (r.err && r.err.message));
  // buildReportHtml 仍可用（降级路径）
  const html = profile.buildReportHtml('month');
  assert(html.indexOf('宝哥成长报告') >= 0, 'HTML 报告应含标题');
}

// =====================================================================
// 测试 29：模块五·云备份入口为禁用占位(功能升级中) + 本地备份独立可用
// =====================================================================
section('29. 云备份：禁用占位入口(功能升级中) + 本地备份独立');
{
  clearStore();
  storage.add('books', { title: '测试书', status: 'reading', records: [] });
  const profile = makeCtx(profileCfg);

  // 云备份入口仅弹「功能升级中」，是占位禁用态，不应触发任何云写入、不抛异常
  assert(typeof profile.cloudComingSoon === 'function', 'profile 应暴露 cloudComingSoon 入口方法');
  assert(call(profile.cloudComingSoon).ok, 'cloudComingSoon 同步不应抛异常');
  assert(!('enableCloud' in profile), '云备份未开放：不应暴露 enableCloud');
  assert(!('cloudBackup' in profile), '云备份未开放：不应暴露 cloudBackup');
  assert(!('cloudRestore' in profile), '云备份未开放：不应暴露 cloudRestore');

  // 本地备份仍独立可用（与云备份互不耦合、互不影响）
  let snapOk = false;
  try { const txt = backup.snapshotToText(); snapOk = typeof txt === 'string' && txt.length > 0; } catch (e) {}
  assert(snapOk, '本地备份快照能力应独立可用');
}

// =====================================================================
// 测试 30：方案A 双击取消 + 跨页回滚缺陷修复
//   勾选仍单击立即生效；取消(已完成项)需 250ms 内二次点击：
//   a) 今日页手动待办：单击已完成不取消，双击才取消
//   b) 健身页动作：双击取消 → 训练 completed 回滚 + 首页 planned 待办 done 回滚（原缺陷）
//   c) 学习页阶段：双击取消 → status 回滚 learning + 摘除图鉴徽章（原缺陷）
// =====================================================================
section('30. 方案A：双击取消（单击提示不取消 · 二次点击才取消）+ 健身/学习取消回滚缺陷修复');
{
  // a) 今日页手动待办
  {
    clearStore();
    const index = makeCtx(indexCfg);
    storage.add('todos', { title: '双击验证手动待办', desc: '', date: util.todayISO(), done: false, important: false, source: 'manual', sourceKey: null, sourcePlanId: null, createdAt: Date.now() });
    call(index.onShow);
    const mid = storage.list('todos').find(t => t.title === '双击验证手动待办')._id;
    const ev = id => ({ currentTarget: { dataset: { id } } });
    // 未完成 → 单击立即勾选
    call(index.toggleTodo, ev(mid));
    assert(storage.list('todos').find(t => t._id === mid).done === true, 'a. 未完成待办单击应勾选完成');
    // 已完成 → 单击仅提示，不取消
    call(index.toggleTodo, ev(mid));
    assert(storage.list('todos').find(t => t._id === mid).done === true, 'a. 已完成待办单击不应取消（等待二次点击）');
    // 窗口内第二次点击 → 取消
    call(index.toggleTodo, ev(mid));
    assert(storage.list('todos').find(t => t._id === mid).done === false, 'a. 已完成待办双击应取消完成');
  }
  // b) 健身页动作：双击取消 + 首页 planned 待办 done 回滚
  {
    clearStore();
    const fitness = makeCtx(fitnessCfg);
    call(fitness.addWorkout);
    call(fitness.pickTemplate, { currentTarget: { dataset: { key: 'ppl-push' } } });
    const w = storage.list('workouts')[0];
    const wid = w._id;
    derive.deriveDailyTodos();
    // 逐条单击勾完所有动作
    w.items.forEach(it => call(fitness.toggleItem, { currentTarget: { dataset: { w: wid, i: it._id } } }));
    assert(storage.list('workouts').find(x => x._id === wid).completed === true, 'b. 勾满全部动作应 completed=true');
    assert(storage.list('todos').some(t => t.source === 'fitness' && t.sourcePlanId === wid && t.done), 'b. 完成后首页 planned 待办应同步 done');
    const first = w.items[0];
    // 单击已完成动作 → 不取消
    call(fitness.toggleItem, { currentTarget: { dataset: { w: wid, i: first._id } } });
    assert(storage.list('workouts').find(x => x._id === wid).completed === true, 'b. 已完成动作单击不应取消整条训练');
    // 双击 → 取消：动作 done 回滚、训练 completed 回滚、首页待办 done 回滚
    call(fitness.toggleItem, { currentTarget: { dataset: { w: wid, i: first._id } } });
    const w2 = storage.list('workouts').find(x => x._id === wid);
    assert(w2.items.find(it => it._id === first._id).done === false, 'b. 双击应取消该动作');
    assert(w2.completed === false, 'b. 取消动作后训练 completed 应回滚 false');
    assert(!storage.list('todos').some(t => t.source === 'fitness' && t.sourcePlanId === wid && t.done), 'b. 缺陷修复：取消动作应回滚首页 planned 待办 done');
  }
  // c) 学习页阶段：双击取消 + status/徽章回滚
  {
    clearStore();
    const learning = makeCtx(learningCfg);
    learning.data.form = { show: true, editId: '', icon: '🌐', name: '双击验证技能', goal: '', cycleDays: '', stages: ['阶段一', '阶段二'], error: '' };
    call(learning.saveForm);
    const sid = storage.list('skills')[0]._id;
    const ev = idx => ({ currentTarget: { dataset: { skill: sid, idx } } });
    // 全部点灯 → 达成 + 1 枚徽章
    call(learning.toggleStage, ev(0));
    call(learning.toggleStage, ev(1));
    assert(storage.list('skills')[0].status === 'achieved', 'c. 全阶段完成应 achieved');
    assert(storage.list('skillAchieved').length === 1, 'c. 达成应生成 1 枚徽章');
    // 单击已完成阶段 → 不取消（status 不变、徽章仍在）
    call(learning.toggleStage, ev(0));
    assert(storage.list('skills')[0].status === 'achieved', 'c. 已完成阶段单击不应回滚（等待二次点击）');
    assert(storage.list('skillAchieved').length === 1, 'c. 单击不应摘除徽章');
    // 双击 → 取消：stage done 回滚、status 回滚 learning、徽章摘除（缺陷修复）
    call(learning.toggleStage, ev(0));
    const s2 = storage.list('skills')[0];
    assert(s2.stages[0].done === false, 'c. 双击应取消该阶段');
    assert(s2.status === 'learning', 'c. 缺陷修复：取消后 status 应回滚为 learning');
    assert(s2.achievedAt === null || s2.achievedAt === undefined, 'c. 取消后 achievedAt 应清空');
    assert(storage.list('skillAchieved').length === 0, 'c. 缺陷修复：取消后应摘除残留徽章');
  }
}

// =====================================================================
// 测试 31：本周成长速览重设计 —— 自然周(周一起)成果口径 + 跨周边界/去重规则
//   a) 读书：翻阅天按日期去重(records 落周 ∪ 完本日)；本周完本以 bookRead 为权威按 _id 去重；
//      上周翻阅/上周完本一律不计
//   b) 健身：仅统计 completed 且计划日 ∈ [本周一,今天] 的训练（未练计划/上周完成不计），
//      次数按条、达标天按日去重，percent=达标天/5
//   c) 学习：本周点亮阶段(doneAt 落周)按阶段计；本周达成技能(achievedAt 落周)按 _id 去重；
//      上周点亮/上周徽章不计；percent=点亮/2(周目标)
// =====================================================================
section('31. 本周成长速览：自然周口径 + 跨周边界与去重规则（v0.10 重设计）');
{
  clearStore();
  // ⚠️ 时钟冻结（2026-10-26 修）：本节断言需要「本周已过 ≥2 天」，用「周一 + 今天」两个不同日期。
  // 但 buildWeekOverview 的 inWeekISO 是 d >= wkStartISO && d <= today —— 未来日期不计。
  // 若用真实时钟，在**周一**运行时 startOfWeek 恰好等于今天，两个日期塌缩成一个，
  // 本节会在每周一必然假失败（代码本身没问题）。把「现在」固定到周四即可永久确定。
  const RealDate = Date;
  const FIXED_MS = new RealDate(2026, 0, 8, 12, 0, 0).getTime();   // 2026-01-08 周四 12:00
  global.Date = class extends RealDate {
    constructor(...args) { if (args.length === 0) super(FIXED_MS); else super(...args); }
    static now() { return FIXED_MS; }
  };
  const util = require(U('utils/util'));
  const now = Date.now();
  const wkStartISO = util.toISO(new Date(util.startOfWeek(now)));
  const lastWeekISO = util.addDaysISO(wkStartISO, -1);       // 上周日（周界外）
  const lastWeekTs = util.startOfWeek(now) - 86400000;       // 上周日（ts 边界外）
  const today = util.todayISO();
  // —— 读书 ——
  storage.add('books', { title: 'A', status: 'reading', records: [{ date: wkStartISO }, { date: today }, { date: lastWeekISO }] });
  storage.add('books', { title: 'B', status: 'reading', records: [{ date: lastWeekISO }] });   // 全上周 → 不计
  storage.add('books', { title: 'C', status: 'read', finishedDate: today, records: [] });
  storage.add('bookRead', { title: 'C', finishedDate: today });            // 本周完本
  storage.add('bookRead', { title: '上周完本', finishedDate: lastWeekISO }); // 上周 → 不计
  // —— 健身 ——
  storage.add('workouts', { name: '练1', date: today, completed: true });
  storage.add('workouts', { name: '练2', date: wkStartISO, completed: true });
  storage.add('workouts', { name: '上周练', date: lastWeekISO, completed: true });   // 上周 → 不计
  storage.add('workouts', { name: '本周建未练', date: today, completed: false, createdAt: now }); // 未练 → 不计
  // —— 学习 ——
  storage.add('skills', { title: '技能X', stages: [{ name: 's1', done: true, doneAt: now }, { name: 's2', done: false }] });
  const skY = storage.add('skills', { title: '技能Y', stages: [{ name: 's1', done: true, doneAt: now }, { name: 's2', done: true, doneAt: lastWeekTs }], status: 'achieved', achievedAt: now });
  storage.add('skillAchieved', { _id: skY._id, title: '技能Y', achievedAt: now });              // 本周达成
  storage.add('skillAchieved', { _id: 'old1', title: '旧达成', achievedAt: lastWeekTs });       // 上周 → 不计

  const index = makeCtx(indexCfg);
  call(index.onShow);
  const ov = index.data.overview;
  // a) 读书：翻阅日 {wkStartISO, today}=2（上周日/上周完本剔除；books 完本日与 bookRead 同日并入去重）；本周完本=1
  assert(ov.reading.days === 2, 'a. 读书·本周翻阅天=2（records 两日 ∪ 完本日今日 去重），实际=' + ov.reading.days);
  assert(ov.reading.finished === 1, 'a. 读书·本周完本=1（上周完本不计、bookRead 按 _id 去重），实际=' + ov.reading.finished);
  assert(typeof ov.reading.sub === 'string' && ov.reading.sub.indexOf('1') >= 0, 'a. 读书·副行应体现本周完本数');
  // b) 健身：2 次（上周完成/本周未练的计划不计）、达标天 2（today+周一 去重）、percent=2/5=40
  assert(ov.fitness.times === 2, 'b. 健身·本周完成训练次数=2（未练计划与上周完成不计），实际=' + ov.fitness.times);
  assert(ov.fitness.days === 2, 'b. 健身·达标天=2（按计划日去重），实际=' + ov.fitness.days);
  assert(ov.fitness.percent === 40, 'b. 健身·percent=达标天/5=40，实际=' + ov.fitness.percent);
  // c) 学习：本周点亮=2（sY 阶段2 为上周点亮 → 不计）、本周达成技能=1（上周徽章不计）、percent=2/2=100
  assert(ov.learning.stages === 2, 'c. 学习·本周点亮阶段=2（上周点亮剔除），实际=' + ov.learning.stages);
  assert(ov.learning.skillsDone === 1, 'c. 学习·本周达成技能=1（上周徽章剔除、按 _id 去重），实际=' + ov.learning.skillsDone);
  assert(ov.learning.percent === 100, 'c. 学习·percent=点亮/周目标2=100，实际=' + ov.learning.percent);
  assert(typeof ov.weekLabel === 'string' && ov.weekLabel.indexOf('–') >= 0, '卡片 meta 应显示周区间 weekLabel');
  global.Date = RealDate;   // 还原真实时钟，避免污染后续用例
}

function finish() {
  console.log('\n========================================');
  console.log('结果：通过 ' + pass + ' · 失败 ' + fail);
  if (fail) {
    console.log('失败项：');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  } else {
    console.log('✅ 全部通过');
    process.exit(0);
  }
}

if (pendingAsync.length) {
  Promise.all(pendingAsync).catch(e => { console.error('异步测试异常', e); fail++; }).then(finish);
} else {
  finish();
}
console.log('结果：通过 ' + pass + ' · 失败 ' + fail);
if (fail) {
  console.log('失败项：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
} else {
  console.log('✅ 全部通过');
  process.exit(0);
}
