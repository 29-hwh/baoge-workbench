// pages/fitness/fitness.js · 宝哥工作台 · 健身板块 v0.9
// v0.8 基线 + v0.9：①添加计划日期改为「今天起连续8天」芯片（周几/几号，默认明天）
//  ②自定义/收藏模板(baoge:templates) ③组间休息计时器 ④训练时长可视增强(开始/结束/共)
const app = getApp();
const storage = require('../../utils/storage');
const util = require('../../utils/util');
const trend = require('../../utils/trend');

const SPLITS = [
  // 新手训练：不预设内容，建卡后由用户自行添加动作自定义
  { key: 'beginner', split: '', name: '新手训练', emoji: '🌱', moves: [] },
  { key: 'ppl-push', split: '三分化', name: '推日 · 胸/肩/三头', emoji: '📈',
    moves: [['杠铃卧推',4,'6-8'],['上斜哑铃推举',3,'10-12'],['站姿杠铃推举',3,'8-10'],['哑铃侧平举',3,'12-15'],['绳索下压',3,'12-15'],['双杠臂屈伸',3,'8-12']] },
  { key: 'ppl-pull', split: '三分化', name: '拉日 · 背/二头', emoji: '🏹',
    moves: [['引体向上/高位下拉',4,'8-10'],['杠铃划船',4,'8-10'],['坐姿绳索划船',3,'10-12'],['面拉',3,'15-20'],['杠铃弯举',3,'10-12'],['锤式弯举',3,'12-15']] },
  { key: 'ppl-legs', split: '三分化', name: '腿日 · 股四/后链/臀', emoji: '🦵',
    moves: [['杠铃深蹲',4,'6-8'],['罗马尼亚硬拉',3,'8-10'],['腿举',3,'10-12'],['腿弯举',3,'12-15'],['站姿提踵',4,'15-20']] }
];

const PRESET_EXERCISES = [
  '哑铃卧推','杠铃卧推','上斜哑铃推举','飞鸟夹胸','高位下拉','坐姿划船','引体向上',
  '硬拉','深蹲','腿举','弓步蹲','腿弯举','站姿推举','侧平举','俯身飞鸟',
  '二头弯举','三头下压','锤式弯举','面拉','罗马尼亚硬拉','提踵'
];

const WEEK_CN = ['周日','周一','周二','周三','周四','周五','周六'];

// 今天起连续 8 天（含今天，默认明天），仅显示「周几/几号」
function buildDateChips() {
  const today = util.todayISO();
  const chips = [];
  for (let i = 0; i < 8; i++) {
    const iso = util.addDaysISO(today, i);
    const d = util.parseISO(iso);
    chips.push({
      iso,
      week: WEEK_CN[d.getDay()],
      day: (d.getMonth() + 1) + '.' + d.getDate(),
      isToday: i === 0,
      isTomorrow: i === 1
    });
  }
  return chips;
}
function chipLabel(iso) {
  const d = util.parseISO(iso);
  return WEEK_CN[d.getDay()] + ' ' + (d.getMonth() + 1) + '.' + d.getDate();
}

// ---------- 顶层工具 ----------
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function fmtKg(w) { const n = parseFloat(w) || 0; return Math.round(n * 10) / 10; }
function fmtNum(n) { const v = Math.round((parseFloat(n) || 0) * 10) / 10; return v % 1 === 0 ? String(v) : String(v); }
function repsOfRange(rng, setIdx) {
  const m = String(rng).match(/\d+/g);
  if (!m) return 8;
  const lo = parseInt(m[0], 10);
  const hi = m.length > 1 ? parseInt(m[1], 10) : lo;
  if (hi <= lo) return lo;
  return setIdx % 2 === 0 ? lo : Math.min(hi, lo + 2);
}
function lastRecorded(name) {
  const ws = storage.list('workouts').slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  for (let i = 0; i < ws.length; i++) {
    const it = (ws[i].items || []).find(x => x.name === name && x.sets && x.sets.some(s => (s.weight || 0) > 0));
    if (it) return it;
  }
  return null;
}
function setVolume(item) { if (!item || !item.sets) return 0; return item.sets.reduce((s, x) => s + ((parseFloat(x.weight) || 0) * (parseInt(x.reps, 10) || 0)), 0); }
function workoutVolume(w) { return (w.items || []).reduce((s, it) => s + setVolume(it), 0); }
function setsText(item) {
  if (!item.sets || !item.sets.length) return '';
  return item.sets.map(s => {
    const reps = parseInt(s.reps, 10) || 0;
    const w = parseFloat(s.weight) || 0;
    return w > 0 ? reps + '×' + fmtNum(w) : (reps > 0 ? reps + '次' : '—');
  }).join(' / ');
}
function prevBest(name, excludeWid) {
  let best = 0;
  storage.list('workouts').forEach(w => {
    if (excludeWid && w._id === excludeWid) return;
    (w.items || []).forEach(it => {
      if (it.name !== name) return;
      (it.sets || []).forEach(s => { const v = parseFloat(s.weight) || 0; if (v > best) best = v; });
    });
  });
  return best;
}
const timeHM = ts => { const d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };

// ---------- 日期滚轮（身体记录：仅今天及之前）----------
function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
function buildDp(minISO, maxISO, selISO) {
  const min = util.parseISO(minISO), max = util.parseISO(maxISO);
  let sel = util.parseISO(selISO);
  if (sel < min) sel = min; if (sel > max) sel = max;
  const minY = min.getFullYear(), maxY = max.getFullYear();
  const minM = min.getMonth() + 1, maxM = max.getMonth() + 1;
  const minD = min.getDate(), maxD = max.getDate();
  const selY = sel.getFullYear(), selM = sel.getMonth() + 1;
  const years = []; for (let y = minY; y <= maxY; y++) years.push(y);
  const mLo = (selY === minY) ? minM : 1, mHi = (selY === maxY) ? maxM : 12;
  const months = []; for (let m = mLo; m <= mHi; m++) months.push(m);
  const dLo = (selY === minY && selM === minM) ? minD : 1, dHi = (selY === maxY && selM === maxM) ? maxD : daysInMonth(selY, selM);
  const days = []; for (let d = dLo; d <= dHi; d++) days.push(d);
  return { years, months, days, val: [Math.max(0, years.indexOf(selY)), Math.max(0, months.indexOf(selM)), Math.max(0, days.indexOf(sel.getDate()))] };
}
function isoFromDp(arrays, val) {
  const y = arrays.dpYears[val[0]], m = arrays.dpMonths[val[1]], dRaw = arrays.dpDays[val[2]];
  const d = Math.min(dRaw, daysInMonth(y, m));
  return y + '-' + pad2(m) + '-' + pad2(d);
}

const METRIC_OPTS = [{ k: 'weight', text: '⚖️ 体重' }, { k: 'fat', text: '🧴 体脂' }];
const RANGE_OPTS = [{ k: '1m', text: '1月' }, { k: '3m', text: '3月' }, { k: '6m', text: '6月' }, { k: 'all', text: '全部' }];
const REST_DEFAULT = 90; // 组间休息默认秒数

Page({
  data: {
    view: 'train', isTrain: true, isBody: false,
    today: util.todayISO(),
    workouts: [],
    historyWorkouts: [],   // 已完成训练（收纳进「历史训练」专区）
    showHistory: false,    // 历史训练默认折叠
    hero: { days: 0, done: 0, vol: 0, streak: 0 },
    tplList: SPLITS,
    userTemplates: [],
    tmpl: { show: false, date: '', dateLabel: '', dateChips: [], dateSel: 0 },
    exSheet: { show: false, wid: '', query: '', all: [], list: [] },
    setE: { show: false, wid: '', iid: '', name: '', target: '', done: false, sets: [], rest: { active: false, left: REST_DEFAULT, total: REST_DEFAULT } },
    bodyRecords: [],
    bodyHero: { latest: '', delta: '', latestFat: '' },
    metricOptions: METRIC_OPTS,
    rangeOptions: RANGE_OPTS,
    chart: { metric: 'weight', range: '1m', points: [], min: 0, max: 0, canvas: false, empty: false, metricText: '体重', rangeText: '近 1 个月', emptyText: '' },
    bodySheet: { show: false, date: '', dateLabel: '', weight: '', fat: '', dpYears: [], dpMonths: [], dpDays: [], dpVal: [0, 0, 0] }
  },

  onShow() {
    const app = getApp();
    if (app && app.applyTheme) app.applyTheme(this);
    this.refresh();
  },

  switchTab(e) {
    const view = e.currentTarget.dataset.view;
    if (view === this.data.view) return;
    this.setData({ view, isTrain: view === 'train', isBody: view === 'body' }, () => this.refresh());
  },

  refresh() {
    if (this.data.view === 'body') { this.refreshBody(); return; }
    this.refreshTrain();
  },

  // ============ 训练视图 ============
  refreshTrain() {
    const ws = storage.list('workouts').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const tday = util.todayISO();
    const today = new Date();
    const weekStartTs = util.startOfWeek(Date.now());
    const wkStartISO = util.toISO(new Date(weekStartTs));
    const curYM = today.getFullYear() * 100 + (today.getMonth() + 1);
    let monthDone = 0, monthVol = 0;
    const weekDates = new Set();
    let streak = 0;

    ws.forEach(w => {
      const items = w.items || [];
      w.totalItems = items.length;
      w.doneItems = items.filter(it => it.done).length;
      w.pct = w.totalItems ? Math.round(w.doneItems * 100 / w.totalItems) : 0;
      w.isToday = w.date === tday;
      w.statusLabel = w.completed ? '已完成' : (w.isToday ? '今天' : '待练');
      w.volume = Math.round(workoutVolume(w));
      w.volumeText = w.volume > 0 ? w.volume + ' kg' : '';
      // 时长可视增强：开始/结束/共
      const startHM = w.startedAt ? timeHM(w.startedAt) : '';
      const endHM = w.completedAt ? timeHM(w.completedAt) : '';
      if (w.completed) {
        let t = '时长 ' + (w.durationMin || 0) + ' 分';
        if (startHM) t += ' · ' + startHM + ' 起';
        if (endHM) t += ' · ' + endHM + ' 止';
        w.timeText = t;
      } else if (startHM) {
        w.timeText = '开始 ' + startHM;
      } else {
        w.timeText = w.durationMin ? '时长 ' + w.durationMin + ' 分' : '';
      }
      w.dateLabel = w.isToday ? '今天' : util.formatCN(w.date);
      w.showDate = !w.isToday;
      items.forEach(it => { it.setsText = setsText(it); it.hasData = !!it.setsText; });
      if (w.completed && w.date) {
        if (w.date >= wkStartISO && w.date <= tday) weekDates.add(w.date);
        const d = new Date(w.date + 'T00:00:00');
        if (!isNaN(d.getTime()) && d.getFullYear() * 100 + (d.getMonth() + 1) === curYM) { monthDone++; monthVol += Math.round(workoutVolume(w)); }
      }
    });

    const doneDates = new Set();
    ws.forEach(w => { if (w.completed && w.date) doneDates.add(w.date); });
    let cursor = util.todayISO();
    if (!doneDates.has(cursor)) cursor = util.addDaysISO(cursor, -1);
    while (doneDates.has(cursor)) { streak++; cursor = util.addDaysISO(cursor, -1); }

    // 拆分：未完成(含待练) → 主列表；已完成 → 历史训练专区（默认折叠收纳）
    const active = ws.filter(w => !w.completed);
    const history = ws.filter(w => w.completed);
    // 2.2 历史训练激励字段：本月第几次 + 是否本月最大容量
    const monthHistory = history.filter(w => {
      const d = new Date(w.date + 'T00:00:00');
      return !isNaN(d.getTime()) && d.getFullYear() * 100 + (d.getMonth() + 1) === curYM;
    }).sort((a, b) => a.date.localeCompare(b.date));
    monthHistory.forEach((w, i) => { w.monthSeq = i + 1; });
    const maxVol = history.reduce((m, w) => Math.max(m, w.volume || 0), 0);
    history.forEach(w => { w.isMonthBest = (w.volume || 0) > 0 && (w.volume || 0) === maxVol; });
    this.setData({
      workouts: active,
      historyWorkouts: history,
      hero: { days: weekDates.size, done: monthDone, vol: monthVol, streak },
      isTrain: true, isBody: false
    });
  },
  // 历史训练专区：展开 / 折叠
  toggleHistory() {
    this.setData({ showHistory: !this.data.showHistory });
  },

  onFab() { if (this.data.view === 'body') this.openBodySheet(); else this.addWorkout(); },

  // ============ 新建训练（FAB → 模板选择 + 8天日期芯片）============
  addWorkout() {
    const chips = buildDateChips();
    const today = util.todayISO();
    this.setData({
      tmpl: Object.assign({}, this.data.tmpl, {
        show: true, date: today, dateLabel: chipLabel(today), dateChips: chips,
        dateSel: 0
      }),
      userTemplates: storage.list('templates')
    });
  },
  closeTmpl() { this.setData({ 'tmpl.show': false }); },
  // 点日期芯片选训练日（今天起连续 8 天）
  onTmplChip(e) {
    const idx = parseInt(e.currentTarget.dataset.idx, 10);
    const chip = this.data.tmpl.dateChips[idx];
    if (!chip) return;
    this.setData({ 'tmpl.date': chip.iso, 'tmpl.dateLabel': chipLabel(chip.iso), 'tmpl.dateSel': idx });
  },
  pickTemplate(e) {
    const key = e.currentTarget.dataset.key;
    const tpl = SPLITS.find(s => s.key === key);
    if (!tpl) return;
    const date = this.data.tmpl.date || util.todayISO();
    const isToday = date === util.todayISO();
    const wname = tpl.split ? (tpl.emoji + ' ' + tpl.split + ' · ' + tpl.name) : (tpl.emoji + ' ' + tpl.name);
    storage.add('workouts', {
      name: wname,
      plan: tpl.key, date,
      items: (tpl.moves || []).map(mv => this.buildItemFromMove(mv[0], mv[1], mv[2])),
      completed: false, startedAt: isToday ? Date.now() : null
    });
    this.closeTmpl();
    this.refresh();
    wx.showToast({ title: isToday ? '已建 · 开练（自动计时）' : '已排到 ' + chipLabel(date), icon: 'none', duration: 1400 });
  },
  buildItemFromMove(name, nSets, rng) {
    const prev = lastRecorded(name);
    let sets;
    if (prev && prev.sets && prev.sets.length) {
      sets = Array.from({ length: nSets }, (_, k) => {
        const src = prev.sets[k] || prev.sets[prev.sets.length - 1] || { reps: 0, weight: 0 };
        return { reps: parseInt(src.reps, 10) || 0, weight: parseFloat(src.weight) || 0 };
      });
    } else {
      sets = Array.from({ length: nSets }, (_, k) => ({ reps: repsOfRange(rng, k), weight: 0 }));
    }
    return { _id: storage.genId(), name, target: nSets + '组×' + rng + '次', sets, done: false };
  },
  pickManual() {
    const that = this;
    wx.showModal({
      title: '新建训练', editable: true, placeholderText: '训练名 · 如：热身+核心',
      success: (r) => {
        if (!r.confirm) return;
        const name = (r.content || '').trim();
        if (!name) return;
        const date = that.data.tmpl.date || util.todayISO();
        const isToday = date === util.todayISO();
        storage.add('workouts', { name, date, cycleDays: 7, items: [], completed: false, startedAt: isToday ? Date.now() : null });
        that.closeTmpl();
        that.refresh();
      }
    });
  },

  // ============ 自定义/收藏模板 ============
  saveAsTemplate(e) {
    const wid = e.currentTarget.dataset.w;
    const w = storage.list('workouts').find(it => it._id === wid);
    if (!w) return;
    if (!w.items || !w.items.length) { wx.showToast({ title: '先添加动作再存模板', icon: 'none' }); return; }
    wx.showModal({
      title: '存为我的模板', editable: true, placeholderText: '模板名，如：我的胸推日',
      contentText: w.name,
      success: (m) => {
        if (!m.confirm) return;
        const name = (m.content || '').trim() || w.name;
        const items = (w.items || []).map(it => ({
          _id: storage.genId(), name: it.name,
          target: it.target || (it.sets ? it.sets.length + '组' : ''),
          sets: (it.sets || []).map(s => ({ reps: parseInt(s.reps, 10) || 0, weight: parseFloat(s.weight) || 0 })),
          done: false
        }));
        storage.add('templates', { name, items, createdAt: Date.now() });
        wx.showToast({ title: '已存为模板', icon: 'success', duration: 1000 });
      }
    });
  },
  pickUserTemplate(e) {
    const tid = e.currentTarget.dataset.tid;
    const tpl = storage.list('templates').find(it => it._id === tid);
    if (!tpl) return;
    const date = this.data.tmpl.date || util.todayISO();
    const isToday = date === util.todayISO();
    const items = (tpl.items || []).map(it => ({
      _id: storage.genId(), name: it.name,
      target: it.target || (it.sets ? it.sets.length + '组' : ''),
      sets: (it.sets || []).map(s => ({ reps: parseInt(s.reps, 10) || 0, weight: parseFloat(s.weight) || 0 })),
      done: false
    }));
    storage.add('workouts', { name: '⭐ ' + tpl.name, plan: 'user', date, cycleDays: 7, items, completed: false, startedAt: isToday ? Date.now() : null });
    this.closeTmpl();
    this.refresh();
    wx.showToast({ title: isToday ? '已建 · 开练' : '已排到 ' + chipLabel(date), icon: 'none', duration: 1200 });
  },
  delUserTemplate(e) {
    const tid = e.currentTarget.dataset.tid;
    wx.showModal({
      title: '删除这个模板？',
      success: (m) => { if (m.confirm) { storage.remove('templates', tid); this.setData({ userTemplates: storage.list('templates') }); } }
    });
  },

  // ============ 添加动作 ============
  openExSheet(e) {
    const wid = e.currentTarget.dataset.w;
    const w = storage.list('workouts').find(it => it._id === wid);
    if (!w) return;
    const others = (w.items || []).map(it => it.name);
    const all = PRESET_EXERCISES.filter(n => !others.includes(n));
    this.setData({ exSheet: { show: true, wid, query: '', all, list: all } });
  },
  closeExSheet() { this.setData({ 'exSheet.show': false }); },
  onExSearch(e) {
    const q = (e.detail.value || '').trim();
    const all = this.data.exSheet.all || [];
    this.setData({ 'exSheet.query': q, 'exSheet.list': q ? all.filter(n => n.indexOf(q) >= 0) : all });
  },
  pickEx(e) { const name = e.currentTarget.dataset.name; if (name) this.doAddExercise(name); },
  pickExCustom() {
    const that = this;
    wx.showModal({
      title: '自定义动作', editable: true, placeholderText: '动作名',
      success: (m) => { if (!m.confirm) return; const n = (m.content || '').trim(); if (n) that.doAddExercise(n); }
    });
  },
  doAddExercise(name) {
    const wid = this.data.exSheet.wid;
    const ws = storage.list('workouts');
    const w = ws.find(it => it._id === wid);
    if (!w) { this.closeExSheet(); return; }
    const others = (w.items || []).map(it => it.name);
    const nn = others.includes(name) ? name + '(2)' : name;
    w.items.push({ _id: storage.genId(), name: nn, target: '3组×10次', sets: [1, 2, 3].map(() => ({ reps: 10, weight: 0 })), done: false });
    storage.update('workouts', wid, { items: w.items });
    this.closeExSheet();
    this.refresh();
  },

  // ============ 训练卡动作操作 ============
  toggleItem(e) {
    const wid = e.currentTarget.dataset.w, iid = e.currentTarget.dataset.i;
    const ws = storage.list('workouts');
    const w = ws.find(it => it._id === wid);
    const item = w && w.items.find(it => it._id === iid);
    if (!w || !item) return;
    // 勾选：单击立即生效（保留「全部完成 → 自动同步今日待办」联动）
    if (!item.done) {
      item.done = true; item.doneAt = Date.now();
      if (w.items.every(it => it.done)) {
        w.completed = true; w.completedAt = w.completedAt || Date.now();
        this.markTodoDoneForWorkout(wid);   // 全部阶段完成 → 同步今日 planned 待办自动标记完成
      }
      storage.update('workouts', wid, { items: w.items, completed: w.completed, completedAt: w.completedAt });
      this.refresh();
      return;
    }
    // 取消（已完成动作）：需 250ms 窗口内二次点击，防误触
    const now = Date.now();
    const key = wid + ':' + iid;
    const last = this._uncheckTap && this._uncheckTap.id === key ? this._uncheckTap : null;
    if (last && now - last.time <= 250) {
      this._uncheckTap = null;
      item.done = false; item.doneAt = null;
      // 缺陷修复：整条训练原本已「全部完成/标记完成」→ 回滚训练完成态，
      // 并反向清除首页对应 planned 待办的 done，避免"训练未完成、待办却已完成"
      const wasComplete = !!w.completed;
      w.completed = false; w.completedAt = null;
      storage.update('workouts', wid, { items: w.items, completed: false, completedAt: null });
      if (wasComplete) this.markTodoIncompleteForWorkout(wid);
      this.refresh();
      wx.showToast({ title: '已取消该项', icon: 'none', duration: 900 });
      return;
    }
    this._uncheckTap = { id: key, time: now };
    wx.showToast({ title: '再点一次取消完成', icon: 'none', duration: 1000 });
  },

  openSets(e) {
    const wid = e.currentTarget.dataset.w, iid = e.currentTarget.dataset.i;
    const ws = storage.list('workouts');
    const w = ws.find(it => it._id === wid);
    const item = w && w.items.find(it => it._id === iid);
    if (!w || !item) return;
    this.setData({
      setE: {
        show: true, wid, iid, name: item.name, target: item.target, done: !!item.done,
        sets: item.sets.map(s => ({ reps: parseInt(s.reps, 10) || 0, weight: fmtKg(s.weight) })),
        rest: { active: false, left: REST_DEFAULT, total: REST_DEFAULT }
      }
    });
  },
  closeSets() { this.stopRest(); this.setData({ 'setE.show': false }); },
  noop() {},
  stepSet(e) {
    const d = e.currentTarget.dataset;
    const wid = d.w, iid = d.i, si = parseInt(d.s, 10), kind = d.k, delta = parseFloat(d.d);
    const e0 = this.data.setE;
    if (!e0.show) return;
    const ws = storage.list('workouts');
    const w = ws.find(it => it._id === wid);
    const item = w && w.items.find(it => it._id === iid);
    if (!w || !item || !item.sets[si]) return;
    const set = item.sets[si];
    if (kind === 'r') set.reps = Math.max(0, (parseInt(set.reps, 10) || 0) + delta);
    else set.weight = Math.max(0, Math.round(((parseFloat(set.weight) || 0) + delta) * 10) / 10);
    storage.update('workouts', wid, { items: w.items });
    const fresh = w.items.find(it => it._id === iid);
    this.setData({ 'setE.sets': (fresh.sets || []).map(s => ({ reps: parseInt(s.reps, 10) || 0, weight: fmtKg(s.weight) })) });
    if (kind === 'w' && set.weight > 0) {
      const best = prevBest(item.name, wid);
      if (best > 0 && set.weight > best) { wx.vibrateShort && wx.vibrateShort({ type: 'light' }); wx.showToast({ title: '💪 ' + item.name + ' PR ' + fmtNum(set.weight) + 'kg', icon: 'none', duration: 1500 }); }
      else if (best === 0) { wx.showToast({ title: '已记录 · 首个 ' + item.name + ' 重量', icon: 'none', duration: 900 }); }
    }
    this.refresh();
  },
  toggleFromEditor() {
    const e0 = this.data.setE;
    if (!e0.show) return;
    const ws = storage.list('workouts');
    const w = ws.find(it => it._id === e0.wid);
    const item = w && w.items.find(it => it._id === e0.iid);
    if (!w || !item) return;
    item.done = !item.done;
    item.doneAt = item.done ? Date.now() : null;
    storage.update('workouts', e0.wid, { items: w.items });
    this.closeSets();
    this.refresh();
  },
  delFromEditor() {
    const e0 = this.data.setE;
    if (!e0.show) return;
    const that = this;
    wx.showModal({
      title: '删除这个动作？',
      success: (m) => {
        if (!m.confirm) return;
        const ws = storage.list('workouts');
        const w = ws.find(it => it._id === e0.wid);
        if (w) { w.items = (w.items || []).filter(it => it._id !== e0.iid); storage.update('workouts', e0.wid, { items: w.items }); }
        that.closeSets();
        that.refresh();
      }
    });
  },

  // ============ 组间休息计时器 ============
  startRest() {
    this.stopRest();
    const tick = () => {
      const rest = this.data.setE.rest;
      if (!rest || !rest.active) return;
      const left = rest.left - 1;
      if (left <= 0) {
        this.setData({ 'setE.rest': { active: false, left: 0, total: REST_DEFAULT } });
        wx.vibrateShort && wx.vibrateShort({ type: 'heavy' });
        wx.showToast({ title: '💪 该下一组了', icon: 'none', duration: 1200 });
        this._restTimer = null;
        return;
      }
      this.setData({ 'setE.rest.left': left });
    };
    this.setData({ 'setE.rest': { active: true, left: REST_DEFAULT, total: REST_DEFAULT } });
    this._restTimer = (typeof setInterval === 'function') ? setInterval(tick, 1000) : null;
  },
  stopRest() {
    if (this._restTimer) { clearInterval(this._restTimer); this._restTimer = null; }
    if (this.data.setE && this.data.setE.show) {
      this.setData({ 'setE.rest': { active: false, left: REST_DEFAULT, total: REST_DEFAULT } });
    }
  },

  // ============ 训练卡管理 ============
  manageWorkout(e) {
    const wid = e.currentTarget.dataset.w;
    const w = storage.list('workouts').find(it => it._id === wid);
    if (!w) return;
    const that = this;
    const isDone = !!w.completed;
    wx.showActionSheet({
      itemList: isDone
        ? ['⏱ 改训练时长', '💾 存为模板', '🗑 删除训练']
        : ['✔ 标记完成', '⏱ 训练时长', '💾 存为模板', '🗑 删除训练'],
      success: (r) => {
        const idx = r.tapIndex;
        if (isDone) {
          if (idx === 0) that.promptDuration(w);
          else if (idx === 1) that.saveAsTemplate({ currentTarget: { dataset: { w: wid } } });
          else if (idx === 2) that.confirmDel(w);
        } else {
          if (idx === 0) that.markComplete(w);
          else if (idx === 1) that.promptDuration(w);
          else if (idx === 2) that.saveAsTemplate({ currentTarget: { dataset: { w: wid } } });
          else if (idx === 3) that.confirmDel(w);
        }
      }
    });
  },
  markComplete(w) {
    const that = this;
    const auto = w.startedAt ? Math.max(1, Math.round((Date.now() - w.startedAt) / 60000)) : 0;
    if (auto) that.doComplete(w, auto);
    else wx.showModal({
      title: '训练时长（分钟）', editable: true, placeholderText: '如 60（可留空）',
      success: (m) => { if (!m.confirm) return; const v = parseInt((m.content || '').trim(), 10); that.doComplete(w, isFinite(v) && v > 0 ? v : null); }
    });
  },
  // 把某训练计划「所有日期」的 planned 待办标记为已完成（首页对应日期待办自动同步）。
  // 关键：不按 t.date===tday 约束 —— 提前完成「明天/之后」的计划时，其未来日期的 planned
  // 待办也要置 done，否则 derive 会把它当作「不再派生且未完成」清理掉（即"误删"）。
  markTodoDoneForWorkout(wid) {
    const todos = storage.list('todos');
    let hit = false;
    todos.forEach(t => {
      if (t.source === 'fitness' && t.sourcePlanId === wid && !t.done) {
        t.done = true; t.completedAt = Date.now(); hit = true;
      }
    });
    if (hit) wx.setStorageSync(storage.KEYS.todos, todos);
  },
  // markTodoDoneForWorkout 的逆操作：取消训练完成态时，把所有日期下该训练对应的
  // planned 待办 done 一并回滚（含提前完成未来计划而置 done 的那些），保证跨页一致
  markTodoIncompleteForWorkout(wid) {
    const todos = storage.list('todos');
    let hit = false;
    todos.forEach(t => {
      if (t.source === 'fitness' && t.sourcePlanId === wid && t.done) {
        t.done = false; t.completedAt = null; hit = true;
      }
    });
    if (hit) wx.setStorageSync(storage.KEYS.todos, todos);
  },
  doComplete(w, durationMin) {
    const wid = w._id;
    w.completed = true; w.completedAt = Date.now();
    w.durationMin = durationMin || w.durationMin || null;
    w.volume = Math.round(workoutVolume(w));
    // 保留 startedAt：训练卡需要它来显示准确的"HH:MM 起"，不置空
    if (!w.startedAt) w.startedAt = w.completedAt;
    storage.update('workouts', wid, { completed: true, completedAt: w.completedAt, durationMin: w.durationMin, volume: w.volume, startedAt: w.startedAt });
    this.markTodoDoneForWorkout(wid);   // 同步今日 planned 待办 done（按 sourcePlanId + 计划日）
    this.refresh();
    const tip = (w.durationMin ? w.durationMin + ' 分钟 · ' : '') + (w.volume ? w.volume + ' kg' : '未录重量');
    wx.showToast({ title: '✅ 完成 ' + tip, icon: 'none', duration: 1800 });
  },
  promptDuration(w) {
    wx.showModal({
      title: '训练时长（分钟）', editable: true, placeholderText: '如 60', contentText: w.durationMin ? String(w.durationMin) : '',
      success: (m) => {
        if (!m.confirm) return;
        const v = parseInt((m.content || '').trim(), 10);
        if (!isFinite(v) || v <= 0) { wx.showToast({ title: '时长需大于 0', icon: 'none' }); return; }
        storage.update('workouts', w._id, { durationMin: v });
        this.refresh();
        wx.showToast({ title: '已记时长 ' + v + ' 分钟', icon: 'success', duration: 900 });
      }
    });
  },
  confirmDel(w) {
    wx.showModal({
      title: '删除这次训练？',
      success: (m) => { if (m.confirm) { storage.remove('workouts', w._id); this.refresh(); } }
    });
  },
  // 2.1 历史训练：长按删除
  delHistory(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: '删除这条历史训练？',
      content: '删除后不可恢复。',
      success: (m) => { if (m.confirm) { storage.remove('workouts', id); this.refresh(); } }
    });
  },

  // ============ 身体视图 ============
  refreshBody() {
    const list = storage.list('body').slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const now = new Date();
    list.forEach(r => {
      r.label = r.date === util.todayISO() ? '今天' : util.formatCN(r.date);
      r.dow = '';
      r.weightText = r.weight ? fmtNum(r.weight) + ' kg' : '';
      r.fatText = r.fat ? '体脂 ' + fmtNum(r.fat) + '%' : '';
      r.deltaText = '';
    });
    let hero = { latest: '', delta: '', latestFat: '' };
    if (list.length) {
      const l0 = list[0];
      hero.latest = l0.weight ? fmtNum(l0.weight) : '';
      hero.latestFat = l0.fat ? fmtNum(l0.fat) : '';
      if (l0.weight && list[1] && list[1].weight) {
        const dlt = Math.round((parseFloat(l0.weight) - parseFloat(list[1].weight)) * 10) / 10;
        hero.delta = (dlt >= 0 ? '+' : '') + fmtNum(dlt) + ' kg';
        if (dlt === 0) hero.delta = '持平';
      } else { hero.delta = '首次记录'; }
    }
    this.setData({ bodyRecords: list, bodyHero: hero, isTrain: false, isBody: true });
    this.buildChart();
  },
  buildChart() {
    const c = this.data.chart;
    const s = trend.buildTrendSeries(this.data.bodyRecords, c.metric, c.range);
    const metricText = c.metric === 'fat' ? '体脂' : '体重';
    const rangeText = { '1m': '近 1 个月', '3m': '近 3 个月', '6m': '近 6 个月', all: '全部' }[c.range];
    this.setData({ chart: Object.assign({}, c, { points: s.points, min: s.min, max: s.max, canvas: s.points.length >= 2, empty: s.points.length < 2, metricText, rangeText }) }, () => this.drawChart());
  },
  onBodyMetric(e) { const metric = e.currentTarget.dataset.m; if (metric === this.data.chart.metric) return; this.setData({ 'chart.metric': metric }, () => this.buildChart()); },
  onBodyRange(e) { const range = e.currentTarget.dataset.r; if (range === this.data.chart.range) return; this.setData({ 'chart.range': range }, () => this.buildChart()); },
  drawChart() {
    const c = this.data.chart;
    if (!c || !c.canvas || c.points.length < 2) return;
    if (typeof wx.createCanvasContext !== 'function') return;
    const ctx = wx.createCanvasContext('trendCanvas', this);
    if (!ctx) return;
    const W = 320, H = 176, padL = 34, padR = 12, padT = 16, padB = 24;
    const iw = W - padL - padR, ih = H - padT - padB;
    const n = c.points.length;
    const xAt = i => n === 1 ? padL : padL + i * iw / (n - 1);
    const yAt = v => padT + ih - (v - c.min) / (c.max - c.min) * ih;
    ctx.clearRect(0, 0, W, H);
    ctx.setStrokeStyle('rgba(0,0,0,0.08)'); ctx.setLineWidth(1); ctx.setFontSize(10); ctx.setTextAlign('right'); ctx.setTextBaseline('middle');
    for (let g = 0; g <= 4; g++) {
      const ratio = g / 4, v = c.max - (c.max - c.min) * ratio, gy = padT + ih * ratio;
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
      ctx.setFillStyle('rgba(0,0,0,0.45)'); ctx.fillText(fmtNum(v), padL - 4, gy);
    }
    ctx.setTextAlign('center'); ctx.setTextBaseline('top');
    const stepIdx = Math.max(1, Math.ceil(n / 5));
    for (let i = 0; i < n; i += stepIdx) ctx.fillText((c.points[i].date || '').slice(5), xAt(i), padT + ih + 4);
    ctx.fillText((c.points[n - 1].date || '').slice(5), xAt(n - 1), padT + ih + 4);
    ctx.setStrokeStyle(c.metric === 'fat' ? '#1D9E75' : '#EF9F27'); ctx.setLineWidth(2); ctx.beginPath();
    c.points.forEach((p, i) => { const x = xAt(i), y = yAt(p.v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
    c.points.forEach((p, i) => {
      const x = xAt(i), y = yAt(p.v);
      ctx.setFillStyle(c.metric === 'fat' ? '#1D9E75' : '#EF9F27'); ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      if (i === n - 1) { ctx.setFillStyle('rgba(0,0,0,0.7)'); ctx.setFontSize(10); ctx.setTextAlign('center'); ctx.setTextBaseline('bottom'); ctx.fillText(fmtNum(p.v), x, y - 6); }
    });
    ctx.draw();
  },
  openBodySheet() {
    const today = util.todayISO();
    const dp = buildDp('2000-01-01', today, today);
    this.setData({ bodySheet: Object.assign({}, this.data.bodySheet, { show: true, date: today, dateLabel: '今天', dpYears: dp.years, dpMonths: dp.months, dpDays: dp.days, dpVal: dp.val }) });
  },
  closeBodySheet() { this.setData({ 'bodySheet.show': false }); },
  onBodyDpChange(e) {
    const iso = isoFromDp(this.data.bodySheet, e.detail.value);
    const ns = buildDp('2000-01-01', util.todayISO(), iso);
    this.setData({ 'bodySheet.date': iso, 'bodySheet.dateLabel': iso === util.todayISO() ? '今天' : util.formatCN(iso), 'bodySheet.dpYears': ns.years, 'bodySheet.dpMonths': ns.months, 'bodySheet.dpDays': ns.days, 'bodySheet.dpVal': ns.val });
  },
  onWeightInput(e) { this.setData({ 'bodySheet.weight': e.detail.value }); },
  onFatInput(e) { this.setData({ 'bodySheet.fat': e.detail.value }); },
  saveBody() {
    const s = this.data.bodySheet;
    const weight = parseFloat(s.weight);
    if (!isFinite(weight) || weight <= 0 || weight > 400) { wx.showToast({ title: '体重格式不对（如 70.5）', icon: 'none' }); return; }
    const date = s.date || util.todayISO();
    const fatV = parseFloat(s.fat);
    const patch = { weight: Math.round(weight * 10) / 10 };
    if (isFinite(fatV) && fatV > 0 && fatV <= 60) patch.fat = Math.round(fatV * 10) / 10;
    const all = storage.list('body');
    const same = all.find(r => r.date === date);
    if (same) storage.update('body', same._id, patch);
    else storage.add('body', Object.assign({ date }, patch));
    this.closeBodySheet();
    this.refreshBody();
    wx.showToast({ title: '已记录 ' + util.formatCN(date), icon: 'success', duration: 1000 });
  },
  delBody(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除这条记录？',
      success: (m) => { if (m.confirm) { storage.remove('body', id); this.refreshBody(); } }
    });
  },

  goTrain() { this.setData({ view: 'train', isTrain: true, isBody: false }, () => this.refreshTrain()); },
  noop2() {}
});
