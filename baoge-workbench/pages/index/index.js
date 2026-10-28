// pages/index/index.js · 今日首页（执行台）
// v0.6 基线 + v0.9 升级：①本周待办点日期高亮同步 ②待办分组/排序+搜索 ③空状态引导
//          ④手动待办重要星标 ⑤完成激励 ⑥本周完成率周报 ⑦读书目标日首页提醒
const storage = require('../../utils/storage');
const derive = require('../../utils/derive');
const util = require('../../utils/util');

Page({
  data: {
    greeting: '早上好',
    dateLabel: '',
    viewDate: '',        // 当前查看的日期 YYYY-MM-DD
    isToday: true,
    isFuture: false,
    todos: [],            // 扁平待办（原始顺序，供事件处理按 _id 查找）
    todoList: [],        // 展示列表：未完成自动置顶 → 已完成随后（单一列表，无分组）
    pendingCount: 0,
    readingAlert: '',    // 读书目标日临近/逾期提醒（打通读书页 P1）
    countdown: [],
    week: [],            // 周待办（7天窗口：今天排倒数第三 = 今天-4 ~ 今天+2）
    celebrate: false,    // 完成激励动效
    emptyQuote: '',      // 空状态每日轮换激励语（仅今天无待办时显示）
    // 半屏表单（单层：名称 + 详情 + 日期 + 重要星标）
    // 时间选择器：默认仅展示「昨天/今天/明天」三天芯片，其余日期走原生滚轮 picker
    todoSheet: { show: false, title: '', desc: '', date: '', dateLabel: '', dateChips: [], dateSel: 0, important: false, customDate: '', useWheel: false },
    // 顶部日期快捷选择（chip 弹层，替代原生 date picker，更便捷简约）
    dateSheet: { show: false, chips: [], sel: 0 },
    cdSheet:   { show: false, name: '', desc: '', date: '', dateLabel: '', annual: false, dateMin: '', dateChips: [], dateSel: 0 },
    todoDetail: null,
    overview: {
      reading:  { count: 0, label: '本在读', percent: 0, alert: false },
      fitness:  { days: 0, target: 5, percent: 0 },
      learning: { count: 0, label: '个技能', percent: 0 }
    }
  },

  onShow() {
    const app = getApp();
    if (app && app.applyTheme) app.applyTheme(this);
    this.setData({ viewDate: util.todayISO() }, () => this.refresh());
  },

  // ===== 日期切换 =====
  shiftDay(e) {
    const dir = parseInt(e.currentTarget.dataset.dir, 10);
    const next = util.addDaysISO(this.data.viewDate, dir);
    this.setData({ viewDate: next }, () => this.refresh());
  },
  // 当天是否有待办（用于日期弹层绿点标记）：手动落库待办 / 未完成健身计划日 / 读书自动待办(仅今天)
  dayHasTodo(iso) {
    const t = util.todayISO();
    if (storage.list('todos').some(td => td.date === iso && !td.skipped)) return true;          // 已落库该日待办
    if (storage.list('workouts').some(w => !w.completed && w.date === iso)) return true;          // 未完成健身计划日
    if (iso === t) {                                                                              // 读书自动待办仅"今天"会派生
      const books = storage.list('books');
      if (books.some(b => b.status !== 'read' && util.progressOf(b).total > 0 && b.autoTodo
        && b.deadline && util.diffDays(t, b.deadline) >= 0)) return true;
    }
    return false;
  },
  // 点击日期栏 → 弹出「日期快捷选择」（chip 弹层，比原生滚轮更便捷简约）
  openDateSheet() {
    const today = util.todayISO();
    const chips = [];
    for (let i = -7; i <= 14; i++) {
      const iso = util.addDaysISO(today, i);
      const d = util.parseISO(iso);
      let label;
      if (i === -1) label = '昨天';
      else if (i === 0) label = '今天';
      else if (i === 1) label = '明天';
      else if (i === 2) label = '后天';
      else if (i === 3) label = '大后天';
      else if (i < 0) label = (-i) + '天前';
      else label = i + '天后';
      chips.push({ iso, label, sub: (d.getMonth() + 1) + '.' + d.getDate(), isToday: i === 0, isFuture: i > 0, offset: i, hasTodo: this.dayHasTodo(iso) });
    }
    const defIdx = chips.findIndex(c => c.iso === this.data.viewDate);
    this.setData({ dateSheet: { show: true, chips, sel: defIdx >= 0 ? defIdx : 0 } });
  },
  closeDateSheet() { this.setData({ 'dateSheet.show': false }); },
  onDateChip(e) {
    const idx = parseInt(e.currentTarget.dataset.idx, 10);
    const chip = this.data.dateSheet.chips[idx];
    if (!chip) return;
    this.setData({ viewDate: chip.iso }, () => { this.closeDateSheet(); this.refresh(); });
  },
  // 自定义跳转日期（日期弹层内：原生 date picker 直选）
  onDateJump(e) {
    const d = e.detail.value;
    if (!d) return;
    this.setData({ viewDate: d }, () => { this.closeDateSheet(); this.refresh(); });
  },
  // 兼容/兜底：原生 date 字符串直设（保留以适配旧调用与测试）
  onViewDatePick(e) {
    const d = e.detail.value;
    if (!d) return;
    this.setData({ viewDate: d }, () => this.refresh());
  },
  jumpToday() {
    this.setData({ viewDate: util.todayISO() }, () => this.refresh());
  },

  refresh() {
    const viewDate = this.data.viewDate;
    const today = util.todayISO();
    const isToday = viewDate === today;
    const isFuture = !isToday && util.diffDays(today, viewDate) > 0;
    const h = new Date().getHours();
    const greeting = h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好'
                    : h < 18 ? '下午好' : h < 22 ? '晚上好' : '夜深了';

    // 待办：按查看日(viewDate)派生该日待办（未来计划日会在其对应日期出现）。
    // derive 已落库全部日期，这里按 date 过滤只取当天展示。
    const todayTodosAll = derive.deriveDailyTodos(today).filter(t => !t.skipped && t.date === today);
    const todos = derive.deriveDailyTodos(viewDate).filter(t => !t.skipped && t.date === viewDate);
    const pendingCount = todos.filter(t => !t.done && !t.planned).length;

    // 读书目标日提醒（打通读书页：临近/逾期在首页给轻提示）
    const readingAlert = this.buildReadingAlert();

    this.setData({
      greeting,
      dateLabel: util.formatCN(viewDate, true),
      viewDate,
      isToday,
      isFuture,
      todos,
      todoList: this.sortTodos(todos),
      pendingCount,
      readingAlert,
      emptyQuote: (isToday && todos.length === 0) ? this.pickDailyQuote() : '',
      countdown: this.buildCountdown(),
      week: this.buildWeek(today, todayTodosAll),
      overview: this.buildWeekOverview(readingAlert)
    });
  },

  // ===== 本周成长速览（v0.10 重设计 · 统计口径）=====
  // 定位：自然周(周一 00:00 起，至现在)的「成果汇报」——三卡只统计本周真实发生的行为，
  // 不再混入历史累计或"计划创建"等无关信号。周期与读书页/健身页的"本周"同源(startOfWeek)。
  // 数据来源与口径：
  //   📚 读书  days=本周翻阅天数(books.records[].date 落周 ∪ 完本日，同一天去重)
  //          finished=本周完本数(bookRead 权威集，按 _id 去重)
  //          percent=翻阅天数/周内已过天数(周一=1…周日=7)，只报行为不判达标
  //   🏋 健身  times=本周完成训练次数；days=去重训练日(均要求 completed 且计划日 ∈ [周一,今天])，
  //          与健身页 hero.days 同口径；percent=days/5(周目标 5 天)
  //   🎯 学习  stages=本周点亮阶段数(skills 全量 stages.doneAt ∈ [周一,现在])；
  //          skillsDone=本周达成技能数(skillAchieved.achievedAt ∈ 本周，按 _id 去重)；
  //          percent=stages/2(周目标 2 阶段，常量可后续入设置)
  // 异常处理：done=false/时间戳缺失/非法 date/超出今天(未来)的事件一律不计；同源快照按 _id 去重。
  buildWeekOverview(readingAlert) {
    const now = Date.now();
    const weekStart = util.startOfWeek(now);                 // 周一 00:00 ts
    const wkStartISO = util.toISO(new Date(weekStart));      // 周一 YYYY-MM-DD
    const today = util.todayISO();
    const dow = new Date().getDay();
    const elapsed = dow === 0 ? 7 : dow;                     // 周内已过天数：周一=1 … 周日=7
    const inWeekISO = d => d >= wkStartISO && d <= today;    // 日期归周（不含未来）
    const d1 = util.parseISO(wkStartISO);
    const weekLabel = (d1.getMonth() + 1) + '.' + d1.getDate()
      + '–' + (new Date().getMonth() + 1) + '.' + new Date().getDate();

    // —— 📚 读书 ——
    const readDays = new Set();
    storage.list('books').forEach(b => {
      (b.records || []).forEach(r => { if (r.date && inWeekISO(r.date)) readDays.add(r.date); });
      // 读完当天也算"翻过书"（与读书页 buildWeekReport 行为一致）
      if (b.status === 'read' && b.finishedDate && inWeekISO(b.finishedDate)) readDays.add(b.finishedDate);
    });
    let finished = 0;
    const fSeen = new Set();
    storage.list('bookRead').forEach(r => {
      if (r.finishedDate && inWeekISO(r.finishedDate)) {
        readDays.add(r.finishedDate);
        if (!fSeen.has(r._id)) { fSeen.add(r._id); finished++; }   // 同书去重
      }
    });

    // —— 🏋 健身 ——
    let fitTimes = 0;
    const fitDays = new Set();
    storage.list('workouts').forEach(w => {
      if (w.completed && w.date && inWeekISO(w.date)) { fitTimes++; fitDays.add(w.date); }
    });

    // —— 🎯 学习 ——
    let stageLit = 0;
    storage.list('skills').forEach(s =>
      (s.stages || []).forEach(st => {
        if (st.done && st.doneAt && st.doneAt >= weekStart && st.doneAt <= now) stageLit++;
      }));
    let skillsDone = 0;
    const aSeen = new Set();
    storage.list('skillAchieved').forEach(a => {
      if (a.achievedAt && a.achievedAt >= weekStart && a.achievedAt <= now && !aSeen.has(a._id)) {
        aSeen.add(a._id); skillsDone++;
      }
    });

    const FIT_TARGET = 5, LEARN_TARGET = 2;   // 周目标常量：健身 5 天 / 学习 2 阶段（后续可做设置）
    const rDays = readDays.size;
    return {
      weekLabel,
      reading: {
        days: rDays,
        finished,
        percent: Math.round(rDays * 100 / elapsed),
        sub: finished ? '读完 ' + finished + ' 本' : '本周未读完',
        alert: !!readingAlert
      },
      fitness: {
        times: fitTimes,
        days: fitDays.size,
        target: FIT_TARGET,
        percent: Math.min(100, Math.round(fitDays.size * 100 / FIT_TARGET)),
        sub: fitDays.size + '/' + FIT_TARGET + ' 天达标'
      },
      learning: {
        stages: stageLit,
        skillsDone,
        target: LEARN_TARGET,
        percent: Math.min(100, Math.round(stageLit * 100 / LEARN_TARGET)),
        sub: skillsDone ? '达成 ' + skillsDone + ' 个技能' : (stageLit ? '点亮中' : '本周未点亮')
      }
    };
  },

  // ===== 空状态每日轮换激励语（按"年中第几天"取模，同一天稳定、每天不同）=====
  pickDailyQuote() {
    const quotes = [
      '种一棵树最好的时间是十年前，其次是现在。',
      '今天不想动，所以才要动一下。',
      '微小进步，每天发生。',
      '坚持，是把简单的事重复做对。',
      '你不必很厉害才能开始，但必须开始才能很厉害。',
      '把目标拆小，今天先完成这一件。',
      '读书、运动、学一项技能，都是给未来的自己存款。',
      '完成比完美更重要。',
      '今天的努力，是明天松弛的底气。',
      '自律给你自由。'
    ];
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    const dayOfYear = Math.floor((now - start) / 86400000);
    return quotes[dayOfYear % quotes.length];
  },

  // ===== 读书目标日提醒（P1 打通首页）=====
  buildReadingAlert() {
    const books = storage.list('books').filter(b => b.status !== 'read' && b.deadline);
    let alert = '';
    books.forEach(b => {
      const left = util.diffDays(util.todayISO(), b.deadline);
      if (left >= 0 && left <= 3) {
        alert = '《' + b.title + '》' + (left === 0 ? '今天' : left + '天后') + '读完 · 加油';
      } else if (left < 0 && !alert) {
        alert = '《' + b.title + '》目标已超 ' + (-left) + ' 天';
      }
    });
    return alert;
  },

  // ===== 待办排序（合并原「来源分组 / 未完成置顶」两套逻辑，统一为单一列表）=====
  // 顺序：未完成全部在前（★重要优先）→ 已完成随后（最近完成在前）；来源靠每条 src-pill 图标辨识
  sortTodos(list) {
    return list.slice().sort((a, b) => {
      if (!!a.done !== !!b.done) return a.done ? 1 : -1;                // 1) 未完成自动置顶
      if (a.done) return (b.completedAt || 0) - (a.completedAt || 0);   // 2) 已完成：最近完成在前
      if (!!a.important !== !!b.important) return a.important ? -1 : 1; // 3) 未完成：重要★优先
      return 0;                                                         // 4) 其余保持原顺序（创建先后）
    });
  },

  // ===== 周待办（固定7天窗口：昨天 + 今天 + 后5天）=====
  buildWeek(todayISO, tt) {
    const today = todayISO || util.todayISO();
    const weeks = ['日', '一', '二', '三', '四', '五', '六'];
    const todayTodos = (tt || derive.deriveDailyTodos().filter(t => !t.skipped))
      .filter(t => !t.planned);
    const stored = storage.list('todos');

    const cells = [];
    let totDone = 0, totAll = 0;
    // 7天窗口：今天排到「倒数第三」位 → 索引 0=今天-4 … 4=今天 … 6=今天+2
    for (let i = -4; i <= 2; i++) {
      const iso = util.addDaysISO(today, i);
      const dayTodos = iso === today
        ? todayTodos
        : stored.filter(t => t.date === iso && !t.skipped);
      const count = dayTodos.length;
      const done = dayTodos.filter(t => t.done).length;
      const isToday = iso === today;
      totAll += count; totDone += done;
      const pct = count ? Math.round(done * 100 / count) : 0;
      const d = util.parseISO(iso);
      cells.push({
        iso,
        dchar: weeks[d.getDay()],
        offset: i,
        count,
        done,
        pending: count - done,
        pct,
        incomplete: count ? 100 - pct : 0,   // 红色段：未完成比例
        isToday,
        isSel: iso === this.data.viewDate,
        isPast: util.isPast(iso),
        cls: isToday ? 'wk-today' : (count === 0 ? 'wk-empty' : '')
      });
    }
    return { cells, weekTotal: todayTodos.filter(t => !t.done).length,
             rate: { done: totDone, total: totAll, pct: totAll ? Math.round(totDone * 100 / totAll) : 0 } };
  },

  // 周卡片点某天 → 切到那天查看（高亮同步）
  gotoDay(e) {
    const iso = e.currentTarget.dataset.iso;
    this.setData({ viewDate: iso }, () => this.refresh());
  },

  // 组装倒计时
  buildCountdown() {
    const arr = storage.list('countdown').map(c => {
      const left = util.countdownDays(c.date, !!c.annual);
      const d = util.parseISO(c.date);
      const label = c.annual
        ? (d.getMonth() + 1) + '月' + d.getDate() + '日'
        : util.formatCN(c.date);
      const cls = left === 0 ? 'cd-today' : (left < 0 ? 'cd-past' : '');
      // 农历：优先用存储值，缺失则按公历回算（与 saveCd 保持同一口径）
      const lunar = c.lunar || (() => {
        const ln = util.solarToLunar(c.date);
        return '农历' + ln.monthCn + ln.dayCn;
      })();
      return Object.assign({}, c, { left, dateLabel: label, lunar, cls });
    });
    arr.sort((a, b) => {
      const aOver = a.left < 0 ? 1 : 0;
      const bOver = b.left < 0 ? 1 : 0;
      if (aOver !== bOver) return aOver - bOver;
      return a.left - b.left;
    });
    return arr;
  },

  // ===== 待办操作 =====
  openTodo(e) {
    const id = e.currentTarget.dataset.id;
    const t = this.data.todos.find(it => it._id === id);
    if (!t) return;
    if (t.planned) {  // 训练计划待办：不可直接勾选，须到健身页完成全部项目后自动同步
      if (t.source === 'fitness') { wx.switchTab({ url: '/pages/fitness/fitness' }); return; }
      wx.showToast({ title: '训练计划 · 请在健身页完成全部项目后自动同步', icon: 'none', duration: 1600 });
      return;
    }
    if (t.source === 'reading') {
      getApp().globalData.expandBookId = t.sourcePlanId || '';
      wx.switchTab({ url: '/pages/reading/reading' });
      return;
    }
    if (t.source === 'learning') { wx.switchTab({ url: '/pages/learning/learning' }); return; }
    if (t.source === 'fitness')  { wx.switchTab({ url: '/pages/fitness/fitness' }); return; }
    this.setData({
      todoDetail: {
        _id: t._id,
        title: t.title,
        desc: t.desc || '（没有补充详情）',
        dateLabel: util.formatCN(t.date, true),
        done: !!t.done,
        important: !!t.important,
        doneLabel: t.done ? '已完成' : '未完成'
      }
    });
  },

  toggleTodo(e) {
    const id = e.currentTarget.dataset.id;
    const t = this.data.todos.find(it => it._id === id);
    if (!t) return;
    if (t.planned) {  // 训练计划待办：不可手动勾选，完成全部项目后由健身页自动同步为已完成
      wx.showToast({ title: '训练计划 · 完成全部项目后自动同步 ✓', icon: 'none', duration: 1800 });
      return;
    }
    // 读书聚合条（当天打卡项，sourcePlanId 为空）：可勾选/取消，按本地项双击取消规则处理
    if (t.source === 'reading' && !t.sourcePlanId) { this.doLocalToggle(id, t); return; }
    // 其余派生项（升级前遗留/兜底安全网）：不可取消，维持原状
    if (t.source && t.source !== 'manual') {
      if (t.done) {
        wx.showToast({ title: '进度已记录 · 长按可删除本条', icon: 'none', duration: 1500 });
        return;
      }
      derive.completeDerived(id);
      this.afterToggle(id);
      return;
    }
    // 纯本地待办（手动/打卡类）：见 doLocalToggle
    this.doLocalToggle(id, t);
  },

  // 本地待办勾选规则：勾选=单击立即生效（保住完成动效与 celebrate）；
  // 取消=已完成项需 250ms 窗口内二次点击（避免误触把刚完成的待办又点掉）
  doLocalToggle(id, t) {
    if (!t.done) {
      storage.update('todos', id, { done: true, completedAt: Date.now() });
      this.afterToggle(id);
      return;
    }
    const now = Date.now();
    const last = this._uncheckTap && this._uncheckTap.id === id ? this._uncheckTap : null;
    if (last && now - last.time <= 250) {
      this._uncheckTap = null;
      storage.update('todos', id, { done: false, completedAt: null });
      this.afterToggle(id);
      return;
    }
    this._uncheckTap = { id, time: now };
    wx.showToast({ title: '再点一次取消完成', icon: 'none', duration: 1000 });
  },

  // 勾选后：重建分组 + 完成激励
  afterToggle(id) {
    const wasPending = this.data.pendingCount;
    this.refresh();
    const nowPending = this.data.pendingCount;
    if (wasPending > 0 && nowPending === 0 && this.data.isToday) {
      this.setData({ celebrate: true });
      wx.showToast({ title: '🎉 今日待办全部完成！', icon: 'none', duration: 1800 });
      setTimeout(() => this.setData({ celebrate: false }), 1600);
    }
  },

  // 长按 = 删除确认
  delTodo(e) {
    const id = e.currentTarget.dataset.id;
    const t = this.data.todos.find(it => it._id === id);
    if (!t) return;
    const isPlan = t.source && t.source !== 'manual';
    if (isPlan) {
      wx.showModal({
        title: '移除这条计划待办？',
        content: '只移除当天的提醒，不动读书 / 学习 / 健身进度；明天仍会按计划出现。',
        confirmText: '移除', cancelText: '再想想',
        success: (r) => {
          if (r.confirm) {
            storage.update('todos', id, { skipped: true, skippedAt: Date.now() });
            this.refresh();
            wx.showToast({ title: '已移除当天提醒', icon: 'none', duration: 1200 });
          }
        }
      });
    } else {
      wx.showModal({
        title: '删除这条待办？',
        content: '删除后不可恢复。',
        confirmText: '删除', cancelText: '再想想',
        success: (r) => {
          if (r.confirm) {
            storage.remove('todos', id);
            this.refresh();
          }
        }
      });
    }
  },

  // ===== 手动待办详情弹层操作 =====
  closeTodoDetail() { this.setData({ todoDetail: null }); },
  toggleFromDetail() {
    const d = this.data.todoDetail;
    if (!d) return;
    const t = storage.list('todos').find(it => it._id === d._id);
    if (!t) return;
    const done = !t.done;
    storage.update('todos', d._id, { done, completedAt: done ? Date.now() : null });
    this.refresh();
    this.setData({ 'todoDetail.done': done, 'todoDetail.doneLabel': done ? '已完成' : '未完成' });
  },
  deleteFromDetail() {
    const d = this.data.todoDetail;
    if (!d) return;
    const that = this;
    wx.showModal({
      title: '删除这条待办？',
      content: '删除后不可恢复。',
      success: (r) => {
        if (r.confirm) {
          storage.remove('todos', d._id);
          that.setData({ todoDetail: null });
          that.refresh();
        }
      }
    });
  },

  // ===== 加手动待办：单表单（名称/详情/日期/重要星标）=====
  // 时间选择（Round 11）：
  //  - 直接展示「昨天 / 今天 / 明天 + 后续连续 7 天」共 10 天连续快捷选项（简约芯片横滑）；
  //  - 下方原生 date picker「自定义日期」覆盖 10 天窗口之外的任意日期；
  //  - 默认日期 = 来源日期（当前正在查看的日期），如从 9月10日 进入添加，默认即 9月10日。
  openTodoSheet() {
    const today = util.todayISO();
    const src = this.data.viewDate || today;          // 来源日期（当前查看的日期）
    const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    // 直接展示 10 天连续：昨天(-1) ~ 未来8天(+8)
    const chips = [];
    for (let off = -1; off <= 8; off++) {
      const iso = util.addDaysISO(today, off);
      const d = util.parseISO(iso);
      let label;
      if (off === -1) label = '昨天';
      else if (off === 0) label = '今天';
      else if (off === 1) label = '明天';
      else label = (d.getMonth() + 1) + '月' + d.getDate() + '日';
      chips.push({ iso, label, sub: weeks[d.getDay()], isToday: off === 0, isFuture: off > 0 });
    }
    const sel = chips.findIndex(c => c.iso === src);   // 来源日期落在 10 天窗口内？
    const useCustom = sel < 0;                          // 否则走自定义日期
    const date = src;
    const dateLabel = useCustom ? util.formatCN(src) : chips[sel].label;
    this.setData({
      todoSheet: {
        show: true, title: '', desc: '', date, dateLabel,
        dateChips: chips, dateSel: sel,
        customDate: useCustom ? src : '',
        important: false
      }
    });
  },
  closeTodoSheet() { this.setData({ 'todoSheet.show': false }); },
  onTodoTitleInput(e) { this.setData({ 'todoSheet.title': e.detail.value }); },
  onTodoDescInput(e)  { this.setData({ 'todoSheet.desc': e.detail.value }); },
  toggleImportant() {
    this.setData({ 'todoSheet.important': !this.data.todoSheet.important });
  },
  // 记一笔时间选择：10 天连续芯片直选（昨天/今天/明天 + 后续7天）
  onTodoChip(e) {
    const idx = parseInt(e.currentTarget.dataset.idx, 10);
    const chip = this.data.todoSheet.dateChips[idx];
    if (!chip) return;
    this.setData({
      'todoSheet.date': chip.iso,
      'todoSheet.dateLabel': chip.label,
      'todoSheet.dateSel': idx,
      'todoSheet.customDate': '',
      'todoSheet.calShow': false
    });
  },
  // 1.2 记一笔 · 自定义日期：内联小日历（点击触发行展开/收起，快速点选任意日）
  toggleTodoCal() {
    if (this.data.todoSheet.calShow) { this.setData({ 'todoSheet.calShow': false }); return; }
    const base = this.data.todoSheet.customDate || this.data.todoSheet.date || util.todayISO();
    this.setData({ 'todoSheet.calShow': true }, () => this.buildTodoCal(base));
  },
  buildTodoCal(iso) {
    const cs = this.data.todoSheet;
    const base = iso || cs.customDate || cs.date || util.todayISO();
    const d = util.parseISO(base);
    const y = d.getFullYear(), m = d.getMonth() + 1;
    const startW = new Date(y, m - 1, 1).getDay();
    const daysInM = new Date(y, m, 0).getDate();
    const sel = cs.customDate || cs.date;
    const days = [];
    for (let i = 0; i < startW; i++) days.push({ empty: true, key: 'e' + i });
    for (let day = 1; day <= daysInM; day++) {
      const di = y + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
      days.push({ key: di, iso: di, dnum: day, isToday: di === util.todayISO(), isSel: di === sel });
    }
    this.setData({ 'todoSheet.calYear': y, 'todoSheet.calMonth': m, 'todoSheet.calDays': days, 'todoSheet.calWeek': ['日', '一', '二', '三', '四', '五', '六'] });
  },
  onTodoCalPrev() {
    let y = this.data.todoSheet.calYear, m = this.data.todoSheet.calMonth - 1;
    if (m < 1) { m = 12; y--; }
    this.buildTodoCal(y + '-' + (m < 10 ? '0' + m : m) + '-01');
  },
  onTodoCalNext() {
    let y = this.data.todoSheet.calYear, m = this.data.todoSheet.calMonth + 1;
    if (m > 12) { m = 1; y++; }
    this.buildTodoCal(y + '-' + (m < 10 ? '0' + m : m) + '-01');
  },
  onTodoCalDay(e) {
    const iso = e.currentTarget.dataset.iso;
    if (!iso) return;
    this.setData({
      'todoSheet.date': iso,
      'todoSheet.dateLabel': util.formatCN(iso),
      'todoSheet.dateSel': -1,
      'todoSheet.customDate': iso,
      'todoSheet.calShow': false
    });
  },
  saveTodo() {
    const s = this.data.todoSheet;
    const title = (s.title || '').trim();
    if (!title) { wx.showToast({ title: '请填事件名称', icon: 'none' }); return; }
    const today = util.todayISO();
    const date = s.date || today;
    // 允许昨天~今天~未来任意；回看历史日期时以来源 viewDate 为准（不强行截断）
    const floor = util.addDaysISO(today, -7);
    if (date < floor && date !== this.data.viewDate) {
      wx.showToast({ title: '日期太早就不可记啦', icon: 'none' });
      return;
    }
    const detail = (s.desc || '').trim();
    storage.add('todos', {
      date,
      source: 'manual',
      sourceKey: null,
      sourcePlanId: null,
      title,
      desc: detail || (date === today ? '手动添加' : '预定 ' + util.formatCN(date)),
      done: false,
      important: !!s.important
    });
    this.closeTodoSheet();
    this.setData({ viewDate: date }, () => this.refresh());
    wx.showToast({ title: '已记到 ' + util.formatCN(date), icon: 'success', duration: 1200 });
  },

  // ===== 加倒计时 =====
  // 移除「一周后/一月后/三月后」预设，仅保留自定义日期；新增农历日期选择。
  // 公历：月历网格点选（过去禁用，除非每年重复）；农历：三级联动 + 公历参考。
  // 时间到选择不能早于今天（一次性事件）。每年重复（生日/纪念日）允许任选。
  openCdSheet() {
    const today = util.todayISO();
    const sheet = {
      show: true, name: '', desc: '', date: '', dateLabel: '选日期',
      annual: false, dateMin: today, dateChips: [], dateSel: -1,
      cdType: 'solar',                 // solar(公历) | lunar(农历)
      calYear: 0, calMonth: 0, calDays: [], calWeek: ['日', '一', '二', '三', '四', '五', '六'], calSel: -1,
      lunarYears: this.buildLunarYears(),
      lunarYearIdx: 0, lunarMonths: [], lunarMonthIdx: 0, lunarDays: [], lunarDayIdx: 0,
      lunarLabel: ''
    };
    this.setData({ cdSheet: sheet }, () => { this.buildCdCal(today); this.initLunar(); });
  },
  // 构建公历月历（含今天当月；过去日期 disabled 除非每年重复）
  buildCdCal(iso) {
    const cs = this.data.cdSheet;
    const annual = !!cs.annual;
    const base = iso || cs.date || util.todayISO();
    const d = util.parseISO(base);
    const y = d.getFullYear(), m = d.getMonth() + 1;
    const startW = new Date(y, m - 1, 1).getDay();   // 0=周日
    const daysInM = new Date(y, m, 0).getDate();
    const today = util.todayISO();
    const days = [];
    for (let i = 0; i < startW; i++) days.push({ empty: true, key: 'e' + i });
    for (let day = 1; day <= daysInM; day++) {
      const di = y + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
      days.push({ key: di, iso: di, dnum: day, isToday: di === today, disabled: (!annual && util.isPast(di)), isSel: di === cs.date });
    }
    this.setData({ 'cdSheet.calYear': y, 'cdSheet.calMonth': m, 'cdSheet.calDays': days });
  },
  onCdCalPrev() {
    let y = this.data.cdSheet.calYear, m = this.data.cdSheet.calMonth - 1;
    if (m < 1) { m = 12; y--; }
    this.buildCdCal(y + '-' + (m < 10 ? '0' + m : m) + '-01');
  },
  onCdCalNext() {
    let y = this.data.cdSheet.calYear, m = this.data.cdSheet.calMonth + 1;
    if (m > 12) { m = 1; y++; }
    this.buildCdCal(y + '-' + (m < 10 ? '0' + m : m) + '-01');
  },
  onCdCalDay(e) {
    const iso = e.currentTarget.dataset.iso;
    if (!iso) return;
    const cs = this.data.cdSheet;
    if (!cs.annual && util.isPast(iso)) { wx.showToast({ title: '一次性事件不能选已过去的', icon: 'none' }); return; }
    // 先落库选中日期，再重算月历 isSel —— 确保方框标记即时反馈（修复选中状态延后、非实时）
    this.setData({ 'cdSheet.date': iso, 'cdSheet.dateLabel': util.formatCN(iso) }, () => this.buildCdCal());
  },
  buildLunarYears() {
    const y = parseInt(util.todayISO().slice(0, 4), 10);
    const arr = [];
    for (let i = 0; i <= 14; i++) arr.push((y + i) + '年');
    return arr;
  },
  // 农历选择器初始化：默认选中「今天」对应的农历日期（年/月含闰/日），并显示对应公历
  initLunar() {
    const cs = this.data.cdSheet;
    const today = util.todayISO();
    const tl = util.solarToLunar(today);             // 今天农历
    const yIdx = cs.lunarYears.indexOf(tl.year + '年');
    const months = util.lunarMonthsOf(tl.year);
    let mIdx = months.findIndex(m => m.m === tl.month && m.isLeap === tl.isLeap);
    if (mIdx < 0) mIdx = 0;
    const days = this.buildLunarDays(tl.year, months[mIdx]);
    this.setData({
      'cdSheet.lunarYearIdx': yIdx >= 0 ? yIdx : 0,
      'cdSheet.lunarMonths': months,
      'cdSheet.lunarMonthIdx': mIdx,
      'cdSheet.lunarDays': days,
      'cdSheet.lunarDayIdx': tl.day - 1
    }, () => this.recomputeLunar());
  },
  buildLunarDays(y, monthObj) {
    const arr = [];
    for (let d = 1; d <= monthObj.days; d++) {
      const iso = util.lunarToSolar(y, monthObj.m, d, monthObj.isLeap);
      arr.push(util.solarToLunar(iso).dayCn);
    }
    return arr;
  },
  recomputeLunar() {
    const cs = this.data.cdSheet;
    if (cs.cdType !== 'lunar') {
      // 公历模式：日期由用户自己选，不预填；清空农历参考信息
      this.setData({ 'cdSheet.solarRef': '', 'cdSheet.solarRefFull': '', 'cdSheet.cdPast': false });
      return;
    }
    const y = parseInt(cs.lunarYears[cs.lunarYearIdx], 10);
    const mo = cs.lunarMonths[cs.lunarMonthIdx];
    if (!mo) return;
    const day = cs.lunarDayIdx + 1;
    const iso = util.lunarToSolar(y, mo.m, day, mo.isLeap);
    const ln = util.solarToLunar(iso);
    const sd = util.parseISO(iso);
    const annual = !!cs.annual;
    const past = !annual && util.isPast(iso);   // 一次性事件不允许选过去日期
    const solarRefFull = sd.getFullYear() + '年' + (sd.getMonth() + 1) + '月' + sd.getDate() + '日'
      + (iso === util.todayISO() ? '（今天）' : '');
    this.setData({
      'cdSheet.date': iso,
      'cdSheet.lunarLabel': ln.label,
      'cdSheet.dateLabel': ln.label,
      'cdSheet.solarRef': util.formatCN(iso),    // 灰色小字：公历参考
      'cdSheet.solarRefFull': solarRefFull,      // 顶部显眼：完整公历日期
      'cdSheet.cdPast': past
    });
  },
  closeCdSheet() { this.setData({ 'cdSheet.show': false }); },
  onCdNameInput(e) { this.setData({ 'cdSheet.name': e.detail.value }); },
  onCdDescInput(e) { this.setData({ 'cdSheet.desc': e.detail.value }); },
  // 公历 / 农历 切换
  onCdType(e) {
    const t = e.currentTarget.dataset.type;
    if (t === this.data.cdSheet.cdType) return;
    if (t === 'lunar') {
      this.setData({ 'cdSheet.cdType': 'lunar' }, () => this.initLunar());
    } else {
      this.setData({ 'cdSheet.cdType': 'solar' }, () => this.buildCdCal(this.data.cdSheet.date || util.todayISO()));
    }
  },
  // 农历选择器：年
  onCdLunarYear(e) {
    const idx = parseInt(e.detail.value[0], 10);
    this.setData({ 'cdSheet.lunarYearIdx': idx }, () => this.onCdLunarMonthCore());
  },
  // 农历选择器：月（含闰月）
  onCdLunarMonth(e) {
    const idx = parseInt(e.detail.value[0], 10);
    this.setData({ 'cdSheet.lunarMonthIdx': idx }, () => this.onCdLunarMonthCore());
  },
  onCdLunarMonthCore() {
    const cs = this.data.cdSheet;
    const y = parseInt(cs.lunarYears[cs.lunarYearIdx], 10);
    const months = util.lunarMonthsOf(y);
    const mo = months[cs.lunarMonthIdx] || months[0];
    const days = this.buildLunarDays(y, mo);
    let di = cs.lunarDayIdx; if (di >= days.length) di = days.length - 1;
    this.setData({
      'cdSheet.lunarMonths': months, 'cdSheet.lunarMonthIdx': months.indexOf(mo),
      'cdSheet.lunarDays': days, 'cdSheet.lunarDayIdx': di
    }, () => this.recomputeLunar());
  },
  // 农历选择器：日
  onCdLunarDay(e) {
    const idx = parseInt(e.detail.value[0], 10);
    this.setData({ 'cdSheet.lunarDayIdx': idx }, () => this.recomputeLunar());
  },
  onCdAnnualChange(e) {
    const annual = !!e.detail.value;
    // 每年重复（生日/纪念日）允许选过去日期；一次性事件严格不早于今天
    this.setData({
      'cdSheet.annual': annual,
      'cdSheet.dateMin': annual ? '2000-01-01' : util.todayISO()
    }, () => this.buildCdCal(this.data.cdSheet.date || util.todayISO()));
  },
  onCdDatePick(e) {
    const d = e.detail.value;
    if (!d) return;
    this.setData({ 'cdSheet.date': d, 'cdSheet.dateLabel': util.formatCN(d) });
  },
  saveCd() {
    const s = this.data.cdSheet;
    const name = (s.name || '').trim();
    if (!name) { wx.showToast({ title: '请填事件名称', icon: 'none' }); return; }
    const date = s.date || '';
    if (!date) { wx.showToast({ title: '请选择日期', icon: 'none' }); return; }   // 必须选日期（公历或农历）
    const annual = !!s.annual;
    if (!annual && util.isPast(date)) {
      wx.showToast({ title: '一次性事件不能选已过去的', icon: 'none' });
      return;
    }
    const dup = storage.list('countdown').find(c => c.name === name);
    if (dup) { wx.showToast({ title: '已存在同名倒计时', icon: 'none', duration: 1200 }); return; }
    // 同步记录农历（无论公历/农历选择）：首页倒计时展示时一并呈现对应农历日期
    const ln = util.solarToLunar(date);
    const lunar = '农历' + ln.monthCn + ln.dayCn;
    storage.add('countdown', {
      name, desc: (s.desc || '').trim(), date, annual, lunar, createdAt: Date.now()
    });
    this.closeCdSheet();
    this.refresh();
    wx.showToast({ title: '已添加', icon: 'success', duration: 1000 });
  },

  delCountdown(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除该倒计时？',
      success: (r) => {
        if (r.confirm) { storage.remove('countdown', id); this.refresh(); }
      }
    });
  },

  // 空状态引导：去三模块建计划
  goReading()   { wx.switchTab({ url: '/pages/reading/reading' }); },
  goFitness()   { wx.switchTab({ url: '/pages/fitness/fitness' }); },
  goLearning()  { wx.switchTab({ url: '/pages/learning/learning' }); },
  noop() {}
});
