// pages/learning/learning.js
// v0.8 基线 + v0.9：①技能图标长按删除 ②每技能「成长记录」时间线（与读书一致：上限覆盖最早+保留创建时间）
//  ③P0 目标周期/每周节奏 ④P0 成长笔记导出 Markdown ⑤P0 阶段上移/下移重排
//  ⑥P1 阶段模板库一键套用 ⑦P1 达成分享卡（文字版）
const app = getApp();
const storage = require('../../utils/storage');
const color = require('../../utils/color');
const util = require('../../utils/util');

// 新建技能图标：按「类型」两排重设计（去掉图书📖/健身🏋，避免与读书、健身板块重复）
//   第一排 · 知识表达：语言/编程/乐器/考证/写作/设计/理财
//   第二排 · 生活实践：烹饪/棋类/摄影/绘画/商业/手工/医学
const ICON_OPTIONS = ['🌐', '💻', '🎵', '📚', '✍️', '🎨', '📈', '🍳', '♟️', '📷', '🖌️', '💼', '🛠️', '🩺'];
const ICON_ROWS = [
  ['🌐', '💻', '🎵', '📚', '✍️', '🎨', '📈'],
  ['🍳', '♟️', '📷', '🖌️', '💼', '🛠️', '🩺']
];
const MAX_RECORDS = 50;   // 每技能成长记录上限（与读书一致）

// 阶段模板库（降低"怎么拆"的决策成本）
const STAGE_TEMPLATES = [
  { name: '学会剪辑', stages: ['写脚本', '素材整理', '粗剪', '精剪', '调色', '配乐导出'] },
  { name: '学会商业摄影', stages: ['布光基础', '单灯练习', '多灯组合', '构图审美', '客片实战'] },
  { name: '学会一门语言', stages: ['发音与字母', '核心词汇', '基础语法', '日常对话', '阅读原著'] },
  { name: '学会写作', stages: ['选题', '列提纲', '初稿', '修改', '排版发布'] },
  { name: '学会健身计划', stages: ['评估体态', '推日', '拉日', '腿日', '核心', '饮食'] }
];

// 落一条成长记录（带 createdAt）；达上限覆盖最早一条并保留其 createdAt
function pushSkillRecord(skill, rec) {
  const records = skill.records || [];
  if (records.length >= MAX_RECORDS) {
    let ei = 0;
    for (let i = 1; i < records.length; i++) {
      if ((records[i].createdAt || 0) < (records[ei].createdAt || 0)) ei = i;
    }
    records[ei] = Object.assign({}, records[ei], rec);  // 保留最初 createdAt
  } else {
    records.push(rec);
  }
  skill.records = records;
}

Page({
  data: {
    skills: [],     // 在学
    badges: [],     // 已达成
    iconOptions: ICON_OPTIONS,
    iconRows: ICON_ROWS,
    stageTemplates: STAGE_TEMPLATES,
    // 单表单创建（FAB 打开；editId 非空=编辑模式，仅改名称/目标/图标/周期，不动阶段）
    // 注：已取消"加入今日待办"开关——学习计划的跟进统一在「在学」页完成，不污染首页待办
    form: { show: false, editId: '', icon: '🎯', name: '', goal: '', cycleDays: '', stages: [''], error: '' },
    // 阶段详情 / 里程碑备注
    stageDetail: null,   // { skillId, idx, name, done, note, logs:[] }
    // 达成回顾卡
    badgeDetail: null,    // 由 skillAchieved 富化（stageViews 等）
    badgeShareTip: false
  },

  onShow() {
    const app = getApp();
    if (app && app.applyTheme) app.applyTheme(this);
    this.refresh();
  },

  refresh() {
    const skills = storage.list('skills')
      .filter(s => s.status !== 'achieved');
    skills.forEach(s => {
      s.percent = s.stages && s.stages.length
        ? Math.round(s.stages.filter(st => st.done).length * 100 / s.stages.length)
        : 0;
      s.doneCount = s.stages ? s.stages.filter(st => st.done).length : 0;
      (s.stages || []).forEach(st => { st.logCount = (st.logs || []).length; });
      // 目标周期 / 每周节奏
      if (s.createdAt && s.cycleDays) {
        const days = Math.max(0, Math.round((Date.now() - s.createdAt) / 86400000));
        s.learnedDays = days;
        const weeks = Math.max(1, Math.ceil(s.cycleDays / 7));
        s.weeklyHint = '建议每周 ' + Math.max(1, Math.ceil((s.stages.length || 1) / weeks)) + ' 个阶段';
        s.cycleText = '预计 ' + s.cycleDays + ' 天达成 · 已学 ' + days + ' 天';
      }
      // 成长记录时间线
      const recs = (s.records || []).slice().sort((a, c) => (c.date || '').localeCompare(a.date || '') || (c.createdAt || 0) - (a.createdAt || 0));
      s.recordCount = recs.length;
      s.recViews = s.recExpanded
        ? recs.slice(0, 50).map(r => ({ date: r.date, createdAt: r.createdAt || 0, note: r.note || '' }))
        : [];
    });
    const badges = storage.list('skillAchieved')
      .sort((a, b) => (b.achievedAt || 0) - (a.achievedAt || 0));
    badges.forEach(b => {
      if (b.achievedAt) {
        const d = new Date(b.achievedAt);
        b.dateLabel = (d.getMonth() + 1) + '月' + d.getDate() + '日';
        if (b.createdAt) {
          const days = Math.round((b.achievedAt - b.createdAt) / 86400000);
          b.usedDays = days <= 0 ? '当天达成' : '用时 ' + days + ' 天';
        }
        b.stageCount = (b.stages || []).length;
      }
    });
    this.setData({ skills, badges });
  },

  // ============ 单表单创建 / 编辑 ============
  addSkill() { this.openForm(null); },

  openForm(skill) {
    if (skill) {
      this.setData({
        form: {
          show: true, editId: skill._id, icon: skill.icon,
          name: skill.name, goal: skill.goal || '',
          cycleDays: skill.cycleDays ? String(skill.cycleDays) : '',
          stages: (skill.stages || []).map(s => s.name), error: ''
        }
      });
    } else {
      this.setData({
        form: { show: true, editId: '', icon: '🎯', name: '', goal: '', cycleDays: '', stages: [''], error: '' }
      });
    }
  },
  closeForm() { this.setData({ 'form.show': false }); },

  pickFormIcon(e) { this.setData({ 'form.icon': e.currentTarget.dataset.icon }); },
  onFormName(e) { this.setData({ 'form.name': e.detail.value }); },
  onFormGoal(e) { this.setData({ 'form.goal': e.detail.value }); },
  onFormCycle(e) { this.setData({ 'form.cycleDays': e.detail.value }); },

  // 阶段输入即自动新增一个阶段：当编辑最后一个阶段且有内容时，自动补一个空阶段
  onStageInput(e) {
    const idx = parseInt(e.currentTarget.dataset.idx, 10);
    const stages = this.data.form.stages.slice();
    stages[idx] = e.detail.value;
    if (idx === stages.length - 1 && (e.detail.value || '').trim()) {
      stages.push('');
    }
    this.setData({ 'form.stages': stages });
  },
  addStage() {
    const stages = this.data.form.stages.slice();
    stages.push('');
    this.setData({ 'form.stages': stages });
  },
  removeStage(e) {
    const idx = parseInt(e.currentTarget.dataset.idx, 10);
    const stages = this.data.form.stages.slice();
    if (stages.length <= 1) { wx.showToast({ title: '至少留一个阶段', icon: 'none' }); return; }
    stages.splice(idx, 1);
    this.setData({ 'form.stages': stages });
  },
  // P1 阶段模板库：一键套用
  applyStageTemplate(e) {
    const key = e.currentTarget.dataset.key;
    const tpl = STAGE_TEMPLATES.find(t => t.name === key);
    if (!tpl) return;
    if (this.data.form.editId) {
      wx.showToast({ title: '编辑模式不可套用模板', icon: 'none' });
      return;
    }
    this.setData({ 'form.stages': tpl.stages.slice() });
    wx.showToast({ title: '已套用「' + tpl.name + '」', icon: 'none', duration: 1200 });
  },
  openStageTemplates() {
    wx.showActionSheet({
      itemList: STAGE_TEMPLATES.map(t => t.name),
      success: (r) => { if (r.tapIndex >= 0) this.applyStageTemplate({ currentTarget: { dataset: { key: STAGE_TEMPLATES[r.tapIndex].name } } }); }
    });
  },

  saveForm() {
    const f = this.data.form;
    const name = (f.name || '').trim();
    if (!name) { this.setData({ 'form.error': '请填技能名称' }); return; }
    const stageNames = f.stages.map(s => (s || '').trim()).filter(Boolean);
    if (!stageNames.length) { this.setData({ 'form.error': '至少写一个阶段' }); return; }
    const cycle = parseInt((f.cycleDays || '').trim(), 10);
    const cycleDays = isFinite(cycle) && cycle > 0 ? cycle : 0;

    if (f.editId) {
      // 编辑模式：仅改名称 / 目标 / 图标 / 周期，保留已有阶段与进度
      storage.update('skills', f.editId, { name, goal: (f.goal || '').trim(), icon: f.icon, cycleDays });
      this.closeForm();
      this.refresh();
      wx.showToast({ title: '已更新', icon: 'success', duration: 900 });
      return;
    }

    const existing = storage.list('skills');
    storage.add('skills', {
      name, goal: (f.goal || '').trim(), icon: f.icon,
      cycleDays,
      color: color.pickFor(existing.length),
      stages: stageNames.map(n => ({ name: n, done: false, logs: [] })),
      records: [],
      createdAt: Date.now(),
      status: 'learning'
    });
    this.closeForm();
    this.refresh();
    wx.showToast({ title: '🚀 开始学习', icon: 'none', duration: 1200 });
  },

  // ============ 阶段圆圈点灯 ============
  toggleStage(e) {
    const skillId = e.currentTarget.dataset.skill;
    const idx = parseInt(e.currentTarget.dataset.idx, 10);
    const skills = storage.list('skills');
    const s = skills.find(it => it._id === skillId);
    if (!s || !s.stages || !s.stages[idx]) return;
    const st = s.stages[idx];
    // 勾选：单击立即点灯；全部点亮 → 达成 + 入图鉴
    if (!st.done) {
      st.done = true; st.doneAt = Date.now();
      st.doneDate = util.todayISO();  // 完成日期，精度到天
      if (s.stages.every(x => x.done)) {
        s.status = 'achieved';
        s.achievedAt = Date.now();
        // 缺陷修复：先按技能去重再写入（防历史遗留/重复达成产生多张同技能徽章）
        const achieved = storage.list('skillAchieved').filter(it => it._id !== s._id);
        achieved.push(Object.assign({}, s));   // 携带 stages（含 logs）+ createdAt，供「达成回顾卡」回看成长
        wx.setStorageSync(storage.KEYS.skillAchieved, achieved);
      }
      wx.setStorageSync(storage.KEYS.skills, skills);
      this.refresh();
      return;
    }
    // 取消（已点亮的阶段）：需 250ms 窗口内二次点击，防误触
    const now = Date.now();
    const key = skillId + ':' + idx;
    const last = this._uncheckTap && this._uncheckTap.id === key ? this._uncheckTap : null;
    if (last && now - last.time <= 250) {
      this._uncheckTap = null;
      st.done = false; st.doneAt = null; st.doneDate = null;
      // 缺陷修复：原实现取消时无 else 分支 → 技能若已达成，status/徽章不回滚。
      // 现回滚为学习中并摘除图鉴徽章，技能回到「在学」列表
      if (s.status === 'achieved') {
        s.status = 'learning';
        s.achievedAt = null;
        const achieved = storage.list('skillAchieved').filter(it => it._id !== s._id);
        wx.setStorageSync(storage.KEYS.skillAchieved, achieved);
      }
      wx.setStorageSync(storage.KEYS.skills, skills);
      this.refresh();
      wx.showToast({ title: '已取消该阶段', icon: 'none', duration: 900 });
      return;
    }
    this._uncheckTap = { id: key, time: now };
    wx.showToast({ title: '再点一次取消完成', icon: 'none', duration: 1000 });
  },

  // ============ 阶段详情 / 里程碑备注 ============
  openStageDetail(e) {
    const skillId = e.currentTarget.dataset.skill;
    const idx = parseInt(e.currentTarget.dataset.idx, 10);
    const s = storage.list('skills').find(it => it._id === skillId);
    if (!s || !s.stages || !s.stages[idx]) return;
    const st = s.stages[idx];
    this.setData({
      stageDetail: {
        skillId, idx,
        name: st.name,
        done: !!st.done,
        doneDate: st.doneDate || '',
        logs: (st.logs || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')),
        note: ''
      }
    });
  },
  closeStageDetail() { this.setData({ stageDetail: null }); },
  onStageNoteInput(e) { this.setData({ 'stageDetail.note': e.detail.value }); },
  saveStageNote() {
    const d = this.data.stageDetail;
    if (!d) return;
    const text = (d.note || '').trim();
    const skills = storage.list('skills');
    const s = skills.find(it => it._id === d.skillId);
    if (!s || !s.stages || !s.stages[d.idx]) return;
    if (text) {
      const logs = s.stages[d.idx].logs || [];
      logs.push({ date: util.todayISO(), text });
      s.stages[d.idx].logs = logs;
      wx.setStorageSync(storage.KEYS.skills, skills);
    }
    this.setData({ 'stageDetail.note': '' });
    this.refresh();
    wx.showToast({ title: text ? '已记里程碑' : '已保存', icon: 'none', duration: 900 });
  },

  // ============ 阶段行：长按重命名 / 删除 / 上移 / 下移 ============
  stageAction(e) {
    const skillId = e.currentTarget.dataset.skill;
    const idx = parseInt(e.currentTarget.dataset.idx, 10);
    const skills = storage.list('skills');
    const s = skills.find(it => it._id === skillId);
    if (!s || !s.stages || !s.stages[idx]) return;
    const canUp = idx > 0;
    const canDown = idx < s.stages.length - 1;
    const items = ['重命名阶段'];
    if (canUp) items.push('上移');
    if (canDown) items.push('下移');
    items.push('删除阶段');
    const that = this;
    wx.showActionSheet({
      itemList: items,
      success: (r) => {
        const label = items[r.tapIndex];
        if (label === '重命名阶段') {
          wx.showModal({
            title: '阶段名称', editable: true, placeholderText: '阶段名',
            contentText: s.stages[idx].name,
            success: (m) => {
              if (!m.confirm) return;
              const n = (m.content || '').trim();
              if (!n) return;
              s.stages[idx].name = n;
              wx.setStorageSync(storage.KEYS.skills, skills);
              that.refresh();
            }
          });
        } else if (label === '上移') { that.moveStage(skillId, idx, -1); }
        else if (label === '下移') { that.moveStage(skillId, idx, 1); }
        else if (label === '删除阶段') {
          if (s.stages.length <= 1) { wx.showToast({ title: '至少留一个阶段', icon: 'none' }); return; }
          wx.showModal({
            title: '删除这个阶段？',
            success: (m) => {
              if (!m.confirm) return;
              s.stages.splice(idx, 1);
              wx.setStorageSync(storage.KEYS.skills, skills);
              that.refresh();
            }
          });
        }
      }
    });
  },
  moveStage(skillId, idx, dir) {
    const skills = storage.list('skills');
    const s = skills.find(it => it._id === skillId);
    if (!s || !s.stages) return;
    const j = idx + dir;
    if (j < 0 || j >= s.stages.length) return;
    const arr = s.stages;
    const tmp = arr[idx]; arr[idx] = arr[j]; arr[j] = tmp;
    wx.setStorageSync(storage.KEYS.skills, skills);
    this.refresh();
  },

  // 技能卡底部：加一个阶段
  addStageToSkill(e) {
    const id = e.currentTarget.dataset.id;
    const skills = storage.list('skills');
    const s = skills.find(it => it._id === id);
    if (!s) return;
    wx.showModal({
      title: '新阶段', editable: true, placeholderText: '阶段名',
      success: (m) => {
        if (!m.confirm) return;
        const n = (m.content || '').trim();
        if (!n) return;
        s.stages.push({ name: n, done: false, logs: [] });
        wx.setStorageSync(storage.KEYS.skills, skills);
        this.refresh();
      }
    });
  },

  // ============ 技能卡：长按改名 / 改目标 / 删除 ============
  skillAction(e) {
    const id = e.currentTarget.dataset.id;
    const skill = storage.list('skills').find(s => s._id === id);
    if (!skill) return;
    const that = this;
    wx.showActionSheet({
      itemList: ['改名', '改目标', '删除'],
      success: (r) => {
        if (r.tapIndex === 0) {
          wx.showModal({
            title: '技能名称', editable: true, placeholderText: '名称',
            contentText: skill.name,
            success: (m) => {
              if (!m.confirm) return;
              const n = (m.content || '').trim();
              if (!n) return;
              storage.update('skills', id, { name: n });
              that.refresh();
            }
          });
        } else if (r.tapIndex === 1) {
          wx.showModal({
            title: '目标（可空）', editable: true, placeholderText: '可衡量的成果',
            contentText: skill.goal || '',
            success: (m) => {
              if (!m.confirm) return;
              storage.update('skills', id, { goal: (m.content || '').trim() });
              that.refresh();
            }
          });
        } else if (r.tapIndex === 2) {
          wx.showModal({
            title: '删除技能？',
            success: (m) => {
              if (!m.confirm) return;
              storage.remove('skills', id);
              that.refresh();
            }
          });
        }
      }
    });
  },

  // 技能图标长按：直接删除（见需求："技能图标支持长按删除"）
  delSkill(e) {
    const id = e.currentTarget.dataset.id;
    const skill = storage.list('skills').find(s => s._id === id);
    if (!skill) return;
    wx.showModal({
      title: '删除这个技能？',
      content: skill.name,
      success: (m) => { if (m.confirm) { storage.remove('skills', id); this.refresh(); } }
    });
  },

  // ============ 成长记录时间线（与读书一致）============
  toggleSkillRecords(e) {
    const id = e.currentTarget.dataset.id;
    const skills = storage.list('skills');
    const s = skills.find(it => it._id === id);
    if (!s) return;
    s.recExpanded = !s.recExpanded;
    wx.setStorageSync(storage.KEYS.skills, skills);
    this.refresh();
  },
  addSkillRecord(e) {
    const id = e.currentTarget.dataset.id;
    const skills = storage.list('skills');
    const s = skills.find(it => it._id === id);
    if (!s) return;
    wx.showModal({
      title: '写成长记录 · ' + s.name,
      editable: true,
      placeholderText: '今天学了什么 / 卡点 / 心得',
      success: (r) => {
        if (!r.confirm) return;
        const note = (r.content || '').trim();
        if (!note) return;
        pushSkillRecord(s, { date: util.todayISO(), note, createdAt: Date.now() });
        s.recExpanded = true;
        wx.setStorageSync(storage.KEYS.skills, skills);
        this.refresh();
        wx.showToast({ title: '已记成长一笔', icon: 'success', duration: 1000 });
      }
    });
  },
  deleteSkillRecord(e) {
    const id = e.currentTarget.dataset.id;
    const ca = Number(e.currentTarget.dataset.ca);
    const skills = storage.list('skills');
    const s = skills.find(it => it._id === id);
    if (!s) return;
    wx.showModal({
      title: '删除这条成长记录？',
      success: (m) => {
        if (!m.confirm) return;
        s.records = (s.records || []).filter(rec => (rec.createdAt || 0) !== ca);
        wx.setStorageSync(storage.KEYS.skills, skills);
        this.refresh();
      }
    });
  },

  // ============ 徽章：达成回顾卡 + 分享卡 ============
  openBadge(e) {
    const id = e.currentTarget.dataset.id;
    const b = storage.list('skillAchieved').find(it => it._id === id);
    if (!b) return;
    const createdAtLabel = b.createdAt ? util.formatDate(b.createdAt) : '';
    const stageViews = (b.stages || []).map(st => ({
      name: st.name,
      doneAtLabel: st.doneAt ? util.formatDate(st.doneAt) : '',
      doneDateLabel: st.doneDate || '',
      logs: (st.logs || []).slice().sort((a, c) => (c.date || '').localeCompare(a.date || ''))
    }));
    this.setData({ badgeDetail: Object.assign({}, b, { stageViews, createdAtLabel }), badgeShareTip: false });
  },
  // 图鉴徽章长按删除（需求：图鉴长按菜单新增删除）
  delBadge(e) {
    const id = e.currentTarget.dataset.id;
    const b = storage.list('skillAchieved').find(it => it._id === id);
    if (!b) return;
    const that = this;
    wx.showModal({
      title: '删除这枚徽章？',
      content: b.name,
      success: (m) => {
        if (!m.confirm) return;
        storage.remove('skillAchieved', id);
        that.closeBadge();
        that.refresh();
        wx.showToast({ title: '已删除徽章', icon: 'none', duration: 1000 });
      }
    });
  },
  closeBadge() { this.setData({ badgeDetail: null }); },
  // P1 达成分享卡（文字版，可复制/转发）
  shareBadge() {
    const b = this.data.badgeDetail;
    if (!b) return;
    const lines = [];
    lines.push('🏆 我点亮了一个技能：' + b.icon + ' ' + b.name);
    if (b.usedDays) lines.push('⏱ ' + b.usedDays);
    lines.push('📊 共 ' + (b.stages || []).length + ' 个阶段：');
    (b.stages || []).forEach(st => lines.push('  ✓ ' + st.name));
    lines.push('—— 宝哥工作台');
    const text = lines.join('\n');
    wx.setClipboardData({
      data: text,
      success: () => { this.setData({ badgeShareTip: true }); wx.showToast({ title: '已复制成就卡', icon: 'none', duration: 1200 }); }
    });
  },

  // ============ 成长笔记导出 Markdown ============
  exportNotes() {
    const md = this.buildMarkdown();
    const d = new Date();
    const p = n => (n < 10 ? '0' + n : '' + n);
    const name = '宝哥技能笔记_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.md';
    const fs = wx.getFileSystemManager();
    fs.writeFile({
      filePath: wx.env.USER_DATA_PATH + '/' + name, data: md, encoding: 'utf8',
      success: () => {
        if (!wx.shareFileMessage) { this.fallbackClipboard(md); return; }
        wx.shareFileMessage({ filePath: wx.env.USER_DATA_PATH + '/' + name, fileName: name,
          success: () => wx.showToast({ title: '已分享', icon: 'success', duration: 1200 }),
          fail: () => this.fallbackClipboard(md) });
      },
      fail: () => this.fallbackClipboard(md)
    });
  },
  fallbackClipboard(md) {
    wx.setClipboardData({ data: md, success: () => wx.showToast({ title: '已复制 md 全文', icon: 'none', duration: 1500 }) });
  },
  buildMarkdown() {
    const skills = storage.list('skills').filter(s => s.status !== 'achieved');
    const badges = storage.list('skillAchieved').sort((a, b) => (b.achievedAt || 0) - (a.achievedAt || 0));
    const d = new Date();
    const p = n => (n < 10 ? '0' + n : '' + n);
    const L = [];
    L.push('# 🎯 宝哥的技能成长笔记');
    L.push(''); L.push('> 导出时间 ' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()));
    L.push(''); L.push('## 📚 在学 ' + skills.length + ' 项');
    skills.forEach(s => {
      L.push(''); L.push('### ' + s.icon + ' ' + s.name);
      if (s.goal) L.push('- 目标：' + s.goal);
      if (s.cycleDays) L.push('- 周期：预计 ' + s.cycleDays + ' 天');
      L.push('- 进度：' + s.stages.filter(st => st.done).length + '/' + s.stages.length + ' 阶段（' +
        (s.stages.length ? Math.round(s.stages.filter(st => st.done).length * 100 / s.stages.length) : 0) + '%）');
      L.push('- 阶段：');
      s.stages.forEach(st => {
        L.push('  - ' + (st.done ? '✅' : '⬜') + ' ' + st.name);
        (st.logs || []).forEach(lg => L.push('    · ' + lg.date + ' ' + lg.text));
      });
      const recs = (s.records || []).slice().sort((x, y) => (x.date || '').localeCompare(y.date || ''));
      if (recs.length) {
        L.push('- 成长记录 ' + recs.length + ' 条：');
        recs.forEach(rec => L.push('  - ' + rec.date + (rec.note ? '：' + rec.note : '')));
      }
    });
    L.push(''); L.push('## 🏆 已达成 ' + badges.length + ' 枚');
    badges.forEach(b => {
      L.push(''); L.push('### ' + b.icon + ' ' + b.name);
      if (b.usedDays) L.push('- ' + b.usedDays + ' · ' + (b.dateLabel || '') + ' 达成');
      (b.stages || []).forEach(st => L.push('  - ✓ ' + st.name));
    });
    return L.join('\n');
  },

  noop() {}
});
