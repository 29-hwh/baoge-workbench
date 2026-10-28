// utils/derive.js
// 「计划 → 今日待办」派生引擎
//
// 业务规则：
//   - 读书：有在读的书（已设进度目标）→ 只聚合派生一条「读《A》《B》」待办，
//     不逐本出现；勾选=当天读书打卡，不回写书进度
//   - 学习：未达成的技能 → 取当前最近未完成的阶段 → 派生「xxx · 第N阶段」
//   - 健身：当天有训练记录且未勾选完成 → 派生训练完成的任务
//   - 手动：source='manual' 的不参与派生，只在 UI 中显示
//
// 派生任务有 sourcePlanId + sourceKey 用于回写完成态。
// 每次派生会先去重（同计划同 key 一天只一条），避免污染今日。
//
// 注意：storage.list/add/update 等一律传 logical key（如 'books'），不要传 storage.KEYS.xxx。

const storage = require('./storage');
const util = require('./util');

// deriveDailyTodos(targetDate?) —— targetDate 不传则取真实今天。
//  支持「查看未来/历史某天」时按那一天派生其当日待办（未来计划日会在对应日期出现）。
//  读书自动待办是逐日提醒，只在真实当天派生（历史/未来浏览日不出现读书提醒）。
function deriveDailyTodos(targetDate) {
  const target = targetDate || util.todayISO();
  const todayActual = util.todayISO();
  const todos = storage.list('todos');
  const list = [];

  // 读书：仅在真实当天派生（自动待办逐日提醒，隶属真实当天）
  if (target === todayActual) {
    const books = storage.list('books');
    const readingBooks = books.filter(b =>
      b.status !== 'read' && util.progressOf(b).total > 0 && b.autoTodo && b.deadline
      && util.diffDays(todayActual, b.deadline) >= 0);
    if (readingBooks.length) {
      list.push({
        source: 'reading',
        sourceKey: 'reading:today',          // 恒定 key：一天一条，多本不再各自出现
        sourcePlanId: '',                     // 空 → 勾选只打卡不回写任何一本书
        title: '读' + readingBooks.map(b => '《' + b.title + '》').join(''),
        desc: readingBooks.length + ' 本在读 · 点我去翻几页',
        icon: '📖',
        iconBg: '#E6F1FB',
        iconColor: '#185FA5'
      });
    }
  }

  // 学习（技能）：已取消"加入今日待办"——学习计划的跟进统一在「在学」页完成，
  // 不再向首页今日待办派生，避免污染。保留函数以便将来可恢复。

  // 健身：仅「未完成的、且计划日 === target」的训练计划派生（支持未来计划日在其对应日期出现）
  const workouts = storage.list('workouts');
  const fitPlanIds = new Set();
  workouts.forEach(w => {
    fitPlanIds.add(w._id);
    if (w.completed) return;                // 已完成则不派生
    if (w.date !== target) return;          // 仅计划日（target）当天派生
    list.push({
      source: 'fitness',
      sourceKey: 'fitness:' + w._id,
      sourcePlanId: w._id,
      title: w.name || '训练计划',
      desc: '今天训练 · 在健身页完成全部项目后自动同步',
      planned: true,
      icon: '🏋',
      iconBg: '#FAEEDA',
      iconColor: '#854F0B'
    });
  });

  const derivedKeys = new Set(list.map(i => i.sourceKey));
  const readingDerived = list.some(i => i.source === 'reading');

  const result = [];
  const existingKeys = new Set();
  todos.forEach(t => {
    if (t.date !== target) {
      // 非 target 日：原样保留；清理孤儿/错过过去的 planned 健身待办
      if (t.source === 'fitness' && t.sourcePlanId) {
        if (!fitPlanIds.has(t.sourcePlanId)) return;   // 训练已删除 → 孤儿清理
        if (t.date < todayActual) return;              // 错过的过去计划日 → 清理
        // 未来计划日 → 保留，待那天打开时派生
      }
      result.push(t);
      return;
    }
    // target 日
    if (t.source === 'reading' && t.sourceKey && t.sourceKey !== 'reading:today') return;   // 升级前遗留逐本读书待办清理
    if (t.source === 'reading' && t.sourceKey === 'reading:today' && !readingDerived) return; // 全部关自动待办 → 移除聚合条
    if (t.source === 'fitness' && t.sourcePlanId) {
      if (!fitPlanIds.has(t.sourcePlanId)) return;          // 训练已删除 → 孤儿清理
      // 已完成计划：保留该「已打勾」待办（不删除），仅清理「不再派生且未完成」的孤儿
      if (!derivedKeys.has(t.sourceKey) && !t.done) return;
    }
    result.push(t);
    if (t.sourceKey) existingKeys.add(t.sourceKey);
  });
  list.forEach(item => {
    if (!existingKeys.has(item.sourceKey)) {
      result.push(Object.assign({ date: target, done: false, _id: storage.genId(), createdAt: Date.now() }, item));
    }
  });

  // 把派生结果落库（含计划日当天的 planned 健身待办，便于健身页完成后回写 done 自动同步）
  wx.setStorageSync(storage.KEYS.todos, result);
  return result;
}

// 完成派生任务时，回写对应计划进度
function completeDerived(todoId) {
  const todos = storage.list('todos');
  const t = todos.find(it => it._id === todoId);
  if (!t) return;
  t.done = true;
  t.completedAt = Date.now();
  wx.setStorageSync(storage.KEYS.todos, todos);

  if (!t.source || !t.sourcePlanId) return; // 手动任务直接标完

  if (t.source === 'reading') {
    const books = storage.list('books');
    const b = books.find(it => it._id === t.sourcePlanId);
    if (!b) return;                    // 书已不存在，忽略
    if (b.status === 'read') return;   // 已读完：仅把该待办标 done，绝不重复上墙
    util.stepProgress(b);              // 章/页/百分比各自 +1 步
    if (util.progressOf(b).done) {
      b.status = 'read';
      b.finishedAt = Date.now();
      b.finishedDate = util.toISO(new Date());
      // 推入书脊墙：保留原书 _id（与读书页 commitFinish 惯例一致），按 _id 去重防重复上墙
      const read = storage.list('bookRead');
      if (!read.some(it => it._id === b._id)) {
        read.push(Object.assign({}, b, { finishedAt: Date.now() }));
        wx.setStorageSync(storage.KEYS.bookRead, read);
      }
    }
    wx.setStorageSync(storage.KEYS.books, books);
  } else if (t.source === 'learning') {
    const skills = storage.list('skills');
    const s = skills.find(it => it._id === t.sourcePlanId);
    if (s && s.stages && s.stages.length) {
      const nextIdx = s.stages.findIndex(st => !st.done);
      if (nextIdx >= 0) {
        s.stages[nextIdx].done = true;
        s.stages[nextIdx].doneAt = Date.now();
      }
      const allDone = s.stages.every(st => st.done);
      if (allDone) {
        s.status = 'achieved';
        s.achievedAt = Date.now();
        const achieved = storage.list('skillAchieved');
        achieved.push(Object.assign({}, s, { _id: storage.genId() }));
        wx.setStorageSync(storage.KEYS.skillAchieved, achieved);
      }
      wx.setStorageSync(storage.KEYS.skills, skills);
    }
  } else if (t.source === 'fitness') {
    const workouts = storage.list('workouts');
    const w = workouts.find(it => it._id === t.sourcePlanId);
    if (w) { w.completed = true; w.completedAt = Date.now(); }
    wx.setStorageSync(storage.KEYS.workouts, workouts);
  }
}

module.exports = { deriveDailyTodos, completeDerived };