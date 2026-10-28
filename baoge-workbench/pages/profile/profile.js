// pages/profile/profile.js
// v0.2 基线 + v0.9：①备份状态显著化(上次备份 X 天前 + 超 7 天变黄)
//  ②恢复前自动先备份(防覆盖丢数据) ③存储占用显示 ④每周备份提醒大按钮
//  ⑤暗色模式开关 ⑥导出可读成长报告
const storage = require('../../utils/storage');
const util = require('../../utils/util');
const backup = require('../../utils/backup');
const cleanup = require('../../utils/cleanup');

const DAY = 86400000;

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  const kb = bytes / 1024;
  if (kb < 1024) return kb.toFixed(1) + ' KB';
  return (kb / 1024).toFixed(2) + ' MB';
}

Page({
  data: {
    stats: {
      books: 0, reads: 0, skills: 0, badges: 0,
      workouts: 0, weeklyWorkouts: 0
    },
    lastBackupText: '',
    backupWarn: false,
    storageSizeText: '0 B',
    dark: false,
    version: 'v0.9.0',
    reportCanvasH: 420,   // 成长报告长图画布高度（导出时按内容动态设置）
    // 数据瘦身：默认收起，点开时才做占用体检（避免每次进页面都全量计算）
    cleanup: {
      open: false,
      totalText: '0 B',
      thresholdText: '0 B',
      overSized: false,
      items: []
    }
  },

  // 生成时间戳（用于报告抬头）
  _nowStamp() {
    const d = new Date();
    const p2 = n => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  },
  // 报告文件后缀
  _reportSuffix(period) {
    const d = new Date();
    const p2 = n => (n < 10 ? '0' + n : '' + n);
    if (period === 'month') return d.getFullYear() + p2(d.getMonth() + 1);
    if (period === 'year') return '' + d.getFullYear();
    return 'all';
  },

  onShow() {
    const app = getApp();
    if (app && app.applyTheme) app.applyTheme(this);
    else this.setData({ themeDark: (app && app.globalData.themeDark) ? 'theme-dark' : '' });
    this.refresh();
  },

  refresh() {
    const books = storage.list('books');
    const reads = storage.list('bookRead');
    const skills = storage.list('skills');
    const badges = storage.list('skillAchieved');
    const workouts = storage.list('workouts');
    const weekStart = util.startOfWeek(Date.now());
    const weeklyWorkouts = workouts.filter(w => (w.createdAt || 0) >= weekStart).length;
    const settings = wx.getStorageSync('baoge:settings') || {};

    // 备份状态显著化
    let lastBackupText = '';
    let backupWarn = true;
    if (settings.lastBackupAt) {
      lastBackupText = util.relativeDate(settings.lastBackupAt);
      backupWarn = (Date.now() - settings.lastBackupAt) > 7 * DAY;
    }

    // 存储占用
    let bytes = 0;
    backup.DATA_KEYS.forEach(k => { try { bytes += JSON.stringify(storage.list(k)).length; } catch (e) {} });

    this.setData({
      stats: {
        books: books.length,
        reads: reads.length,
        skills: skills.length,
        badges: badges.length,
        workouts: workouts.length,
        weeklyWorkouts
      },
      lastBackupText,
      backupWarn,
      storageSizeText: fmtSize(bytes),
      dark: !!settings.dark
    });
  },

  markBackedUp() {
    const settings = wx.getStorageSync('baoge:settings') || {};
    settings.lastBackupAt = Date.now();
    wx.setStorageSync('baoge:settings', settings);
    this.refresh();
  },

  // 恢复前自动先备份当前数据到剪贴板（静默），再执行恢复回调
  autoBackupThen(cb) {
    try {
      const text = backup.snapshotToText();
      wx.setClipboardData({
        data: text,
        success: () => wx.showToast({ title: '已自动备份当前数据', icon: 'none', duration: 1200 }),
        fail: () => {}
      });
    } catch (e) { /* 自动备份失败不阻塞恢复 */ }
    cb();
  },

  // —— 备份：发到微信（推荐） ——
  exportToFile() {
    wx.showLoading({ title: '生成备份中' });
    backup.exportAndShare().then(res => {
      wx.hideLoading();
      this.markBackedUp();
      // 有告警（如空数据、写入失败已降级）时优先提示，否则只报成功
      if (res.warnings && res.warnings.length) {
        wx.showModal({ title: '备份提示', content: res.warnings.join('\n'), showCancel: false });
      } else if (res.channel === 'wechat') {
        wx.showToast({ title: '已生成，选择好友发送', icon: 'none', duration: 2000 });
      }
      // clipboard 分支由 backup 模块自行弹窗提示
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '导出失败', icon: 'none' });
    });
  },

  // —— 备份：复制 JSON 到剪贴板 ——
  copyJson() {
    wx.showLoading({ title: '生成中' });
    try {
      backup.copyToClipboard();
      this.markBackedUp();
    } catch (e) {
      wx.showToast({ title: '导出失败', icon: 'none' });
    }
    wx.hideLoading();
  },

  // 注：已移除「复制进度速览」入口（v1 精简）；成长报告导出保留长图 + HTML 降级（见 doExportReport）。

  // P1 导出可读成长报告（月度 / 年度 / 全部，生成自包含 HTML 总结，可文件分享）
  exportReport() {
    const that = this;
    wx.showActionSheet({
      itemList: ['📅 本月报告', '📆 本年度报告', '📚 全部汇总'],
      success: (res) => {
        const map = ['month', 'year', 'all'];
        const period = map[res.tapIndex];
        if (!period) return;
        that.doExportReport(period);
      }
    });
  },
  // 纯函数：生成报告数据结构（便于回归测试，与 HTML/canvas 共用）
  buildReportModel(period) {
    const r = this._reportRange(period);
    const books = storage.list('books');
    const reads = storage.list('bookRead');
    const skills = storage.list('skills');
    const badges = storage.list('skillAchieved');
    const workouts = storage.list('workouts');
    const todos = storage.list('todos');

    const readingNow = books.filter(b => b.status !== 'read').length;
    const readDone = reads
      .filter(x => (x.finishedAt || 0) >= r.start && (x.finishedAt || 0) < r.end)
      .map(x => ({ title: x.title, rating: x.rating || 0 }));
    const skillsNow = skills.filter(s => s.status !== 'achieved').length;
    const badgesDone = badges
      .filter(x => (x.achievedAt || 0) >= r.start && (x.achievedAt || 0) < r.end)
      .map(x => ({ icon: x.icon || '🏆', name: x.name }));
    const workoutCnt = workouts.filter(w => (w.createdAt || 0) >= r.start && (w.createdAt || 0) < r.end).length;

    const startISO = util.toISO(new Date(r.start));
    const endISO = util.toISO(new Date(r.end));
    const periodTodos = todos.filter(t => t.date && t.date >= startISO && t.date < endISO);
    const todoDone = periodTodos.filter(t => t.done).length;
    const todoTotal = periodTodos.length;
    const todoRate = todoTotal ? Math.round(todoDone * 100 / todoTotal) : 0;

    return {
      label: r.label,
      genTime: this._nowStamp(),
      hero: [
        { n: readDone.length, l: '本读完' },
        { n: badgesDone.length, l: '新达成技能' },
        { n: workoutCnt, l: '次训练' },
        { n: todoRate + '%', l: '待办完成' }
      ],
      reading: {
        readingNow,
        readCount: readDone.length,
        list: readDone.map(x => (x.rating ? '★'.repeat(x.rating) + ' ' : '') + '《' + x.title + '》')
      },
      learning: {
        skillsNow,
        badgeCount: badgesDone.length,
        list: badgesDone.map(x => (x.icon ? x.icon + ' ' : '') + x.name)
      },
      fitness: { workoutCnt, total: workouts.length },
      todo: { done: todoDone, total: todoTotal, rate: todoRate }
    };
  },

  // 导出长图优先；canvas 不可用时降级为 HTML 文件分享
  doExportReport(period) {
    const model = this.buildReportModel(period);
    this.exportReportImage(period, model);
  },

  // canvas 绘制成长报告长图（便于分享）；任何失败都降级 buildReportHtml
  exportReportImage(period, model) {
    const that = this;
    try {
      if (typeof wx.canvasToTempFilePath !== 'function' || typeof wx.createCanvasContext !== 'function') throw new Error('no-canvas');
      const H = this._reportImageHeight(model);
      this.setData({ reportCanvasH: H }, () => {
        const ctx = wx.createCanvasContext('reportCard', this);
        const W = 600;
        this._drawReport(ctx, model, W, H);
        ctx.draw(true, () => {
          wx.canvasToTempFilePath({
            canvasId: 'reportCard',
            success: (res) => {
              const name = '宝哥成长报告_' + that._reportSuffix(period) + '.png';
              if (!wx.shareFileMessage) { that.fallbackReportHtml(period); return; }
              wx.shareFileMessage({
                filePath: res.tempFilePath, fileName: name,
                success: () => wx.showToast({ title: '已生成报告长图', icon: 'success', duration: 1200 }),
                fail: () => that.fallbackReportHtml(period)
              });
            },
            fail: () => that.fallbackReportHtml(period)
          }, that);
        });
      });
    } catch (err) {
      this.fallbackReportHtml(period);
    }
  },

  // 估算长图高度（与 _drawReport 布局一致）
  _reportImageHeight(model) {
    const listLen = m => Math.min((m && m.length) || 0, 8);
    let y = 96;            // 抬头
    y += 130;              // hero 卡
    y += 16 + (120 + listLen(model.reading.list) * 26);   // 读书卡
    y += 16 + (120 + listLen(model.learning.list) * 26);  // 学习卡
    y += 16 + 104;         // 健身卡
    y += 16 + 104;         // 待办卡
    y += 50;               // 页脚
    return Math.max(360, Math.min(Math.round(y), 1700));
  },

  // 在 canvas 上绘制报告（W=600）
  _drawReport(ctx, model, W, H) {
    const C = { bg: '#f7f5ee', card: '#FFFFFF', dark: '#2C2C2A', muted: '#888781', primary: '#534AB7' };
    ctx.setFillStyle(C.bg); ctx.fillRect(0, 0, W, H);
    // 抬头
    ctx.setFillStyle(C.dark); ctx.setFontSize(30); ctx.fillText('📈 宝哥成长报告', 28, 48);
    ctx.setFillStyle(C.muted); ctx.setFontSize(19); ctx.fillText(model.label + ' · 生成于 ' + model.genTime, 28, 76);
    // hero 四卡
    let y = 96;
    const heroH = 110, gap = 10, m = 28;
    const cw = Math.floor((W - m * 2 - gap * 3) / 4);
    model.hero.forEach((h, i) => {
      const x = m + i * (cw + gap);
      ctx.setFillStyle(C.card); ctx.fillRect(x, y, cw, heroH);
      ctx.setFillStyle(C.primary); ctx.setFontSize(26); ctx.fillText(String(h.n), x + 14, y + 52);
      ctx.setFillStyle(C.muted); ctx.setFontSize(18); ctx.fillText(h.l, x + 14, y + 82);
    });
    y += heroH + 16;
    // 读书卡
    y = this._reportSection(ctx, model.reading, y, W, m, '📚 读书', [
      { k: '在读中', v: model.reading.readingNow + ' 本' },
      { k: '本期读完', v: model.reading.readCount + ' 本' }
    ], C);
    // 学习卡
    y = this._reportSection(ctx, model.learning, y, W, m, '🎯 学习', [
      { k: '在学中', v: model.learning.skillsNow + ' 项' },
      { k: '本期达成', v: model.learning.badgeCount + ' 枚' }
    ], C);
    // 健身卡
    ctx.setFillStyle(C.card); ctx.fillRect(m, y, W - m * 2, 92);
    ctx.setFillStyle(C.dark); ctx.setFontSize(24); ctx.fillText('🏋 健身', m + 16, y + 30);
    ctx.setFillStyle(C.muted); ctx.setFontSize(20);
    ctx.fillText('本期训练  ' + model.fitness.workoutCnt + ' 次', m + 16, y + 60);
    ctx.fillText('累计训练  ' + model.fitness.total + ' 次', m + 16 + Math.floor((W - m * 2) / 2), y + 60);
    y += 92 + 16;
    // 待办卡
    ctx.setFillStyle(C.card); ctx.fillRect(m, y, W - m * 2, 92);
    ctx.setFillStyle(C.dark); ctx.setFontSize(24); ctx.fillText('✅ 待办', m + 16, y + 30);
    ctx.setFillStyle(C.muted); ctx.setFontSize(20);
    ctx.fillText('完成 / 总数  ' + model.todo.done + ' / ' + model.todo.total, m + 16, y + 60);
    ctx.fillText('完成率  ' + model.todo.rate + '%', m + 16 + Math.floor((W - m * 2) / 2), y + 60);
    y += 92 + 50;
    // 页脚
    ctx.setFillStyle(C.muted); ctx.setFontSize(18); ctx.fillText('宝哥工作台 · 本地优先 · 微信备份', m, y);
  },

  // 画一个「标题 + 行 + 列表」section 卡，返回下一节 y
  _reportSection(ctx, data, y, W, m, title, rows, C) {
    const list = (data.list || []).slice(0, 8);
    const h = 120 + list.length * 26;
    ctx.setFillStyle(C.card); ctx.fillRect(m, y, W - m * 2, h);
    ctx.setFillStyle(C.dark); ctx.setFontSize(24); ctx.fillText(title, m + 16, y + 30);
    ctx.setFillStyle(C.muted); ctx.setFontSize(20);
    rows.forEach((r, i) => ctx.fillText(r.k + '  ' + r.v, m + 16, y + 56 + i * 26));
    let ly = y + 56 + rows.length * 26 + 8;
    list.forEach(line => { ctx.setFillStyle(C.dark); ctx.setFontSize(19); ctx.fillText('· ' + line, m + 16, ly); ly += 26; });
    if ((data.list || []).length > 8) {
      ctx.setFillStyle(C.muted); ctx.setFontSize(17);
      ctx.fillText('…等共 ' + data.list.length + ' 条', m + 16, ly);
    }
    return y + h + 16;
  },

  // 降级：生成自包含 HTML 报告并文件分享（canvas 不可用 / 失败时使用）
  fallbackReportHtml(period) {
    const html = this.buildReportHtml(period);
    const suffix = this._reportSuffix(period);
    const name = '宝哥成长报告_' + suffix + '.html';
    const fs = wx.getFileSystemManager();
    fs.writeFile({
      filePath: wx.env.USER_DATA_PATH + '/' + name, data: html, encoding: 'utf8',
      success: () => {
        if (!wx.shareFileMessage) { wx.setClipboardData({ data: html, success: () => wx.showToast({ title: '已复制报告', icon: 'none' }) }); return; }
        wx.shareFileMessage({ filePath: wx.env.USER_DATA_PATH + '/' + name, fileName: name,
          success: () => wx.showToast({ title: '已分享报告', icon: 'success', duration: 1200 }),
          fail: () => wx.setClipboardData({ data: html, success: () => wx.showToast({ title: '已复制报告', icon: 'none' }) }) });
      },
      fail: () => wx.setClipboardData({ data: html, success: () => wx.showToast({ title: '已复制报告', icon: 'none' }) })
    });
  },
  // 计算报告区间边界（毫秒时间戳）
  _reportRange(period) {
    const now = new Date();
    if (period === 'month') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
      return { start, end, label: now.getFullYear() + '年' + (now.getMonth() + 1) + '月' };
    }
    if (period === 'year') {
      const start = new Date(now.getFullYear(), 0, 1).getTime();
      const end = new Date(now.getFullYear() + 1, 0, 1).getTime();
      return { start, end, label: now.getFullYear() + '年' };
    }
    return { start: 0, end: Date.now() + 2 * 86400000, label: '全部' };
  },
  // 生成自包含 HTML 成长报告
  buildReportHtml(period) {
    const r = this._reportRange(period);
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const books = storage.list('books');
    const reads = storage.list('bookRead');
    const skills = storage.list('skills');
    const badges = storage.list('skillAchieved');
    const workouts = storage.list('workouts');
    const todos = storage.list('todos');

    const readingNow = books.filter(b => b.status !== 'read').length;
    const readDone = reads.filter(x => (x.finishedAt || 0) >= r.start && (x.finishedAt || 0) < r.end);
    const skillsNow = skills.filter(s => s.status !== 'achieved').length;
    const badgesDone = badges.filter(x => (x.achievedAt || 0) >= r.start && (x.achievedAt || 0) < r.end);
    const workoutCnt = workouts.filter(w => (w.createdAt || 0) >= r.start && (w.createdAt || 0) < r.end).length;

    const startISO = util.toISO(new Date(r.start));
    const endISO = util.toISO(new Date(r.end));
    const periodTodos = todos.filter(t => t.date && t.date >= startISO && t.date < endISO);
    const todoDone = periodTodos.filter(t => t.done).length;
    const todoTotal = periodTodos.length;

    const genTime = d0 => { const p2 = n => (n < 10 ? '0' + n : '' + n); return d0.getFullYear() + '-' + p2(d0.getMonth() + 1) + '-' + p2(d0.getDate()) + ' ' + p2(d0.getHours()) + ':' + p2(d0.getMinutes()); };
    const readList = readDone.length
      ? '<ul>' + readDone.map(x => '<li>《' + esc(x.title) + '》' + (x.rating ? ' · ' + '★'.repeat(x.rating) : '') + '</li>').join('') + '</ul>'
      : '<p class="muted">本期还没有读完的书</p>';
    const badgeList = badgesDone.length
      ? '<ul>' + badgesDone.map(x => '<li>' + esc(x.icon || '🏆') + ' ' + esc(x.name) + '</li>').join('') + '</ul>'
      : '<p class="muted">本期还没有达成新技能</p>';

    return [
      '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>宝哥成长报告 · ' + esc(r.label) + '</title>',
      '<style>',
      'body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f7f5ee;color:#2C2C2A;margin:0;padding:24px 16px;}',
      '.wrap{max-width:640px;margin:0 auto;}.sub{color:#888780;font-size:13px;margin-bottom:20px;}',
      '.hero{display:flex;gap:10px;margin-bottom:18px;}.hero .c{flex:1;background:#fff;border-radius:12px;padding:14px;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.05);}',
      '.hero .n{font-size:22px;font-weight:600;}.hero .l{font-size:12px;color:#5F5E5A;margin-top:2px;}',
      '.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 2px 6px rgba(0,0,0,.05);}',
      '.card h2{font-size:16px;margin:0 0 10px;}.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee;font-size:14px;}.row:last-child{border-bottom:none;}',
      '.muted{color:#888780;font-size:13px;}ul{margin:8px 0 0;padding-left:18px;}li{font-size:14px;padding:3px 0;}',
      '.footer{text-align:center;color:#888780;font-size:12px;margin-top:8px;}</style></head><body><div class="wrap">',
      '<h1>📈 宝哥成长报告</h1>',
      '<div class="sub">' + esc(r.label) + ' · 生成于 ' + esc(genTime(new Date())) + '</div>',
      '<div class="hero">',
      '<div class="c"><div class="n">' + readDone.length + '</div><div class="l">本读完</div></div>',
      '<div class="c"><div class="n">' + badgesDone.length + '</div><div class="l">新达成技能</div></div>',
      '<div class="c"><div class="n">' + workoutCnt + '</div><div class="l">次训练</div></div>',
      '<div class="c"><div class="n">' + (todoTotal ? Math.round(todoDone * 100 / todoTotal) : 0) + '%</div><div class="l">待办完成</div></div>',
      '</div>',
      '<div class="card"><h2>📚 读书</h2>',
      '<div class="row"><span>在读中</span><span>' + readingNow + ' 本</span></div>',
      '<div class="row"><span>本期读完</span><span>' + readDone.length + ' 本</span></div>',
      readList,
      '</div>',
      '<div class="card"><h2>🎯 学习</h2>',
      '<div class="row"><span>在学中</span><span>' + skillsNow + ' 项</span></div>',
      '<div class="row"><span>本期达成</span><span>' + badgesDone.length + ' 枚</span></div>',
      badgeList,
      '</div>',
      '<div class="card"><h2>🏋 健身</h2>',
      '<div class="row"><span>本期训练</span><span>' + workoutCnt + ' 次</span></div>',
      '<div class="row"><span>累计训练</span><span>' + workouts.length + ' 次</span></div>',
      '</div>',
      '<div class="card"><h2>✅ 待办</h2>',
      '<div class="row"><span>本期完成 / 总数</span><span>' + todoDone + ' / ' + todoTotal + '</span></div>',
      '<div class="row"><span>完成率</span><span>' + (todoTotal ? Math.round(todoDone * 100 / todoTotal) : 0) + '%</span></div>',
      '</div>',
      '<div class="footer">宝哥工作台 · 本地优先 · 微信备份</div>',
      '</div></body></html>'
    ].join('\n');
  },

  // —— 恢复：从微信聊天里的文件 ——
  importFromFile() {
    const that = this;
    wx.showModal({
      title: '从备份文件恢复？',
      content: '会覆盖当前全部数据。恢复前我会自动把当前数据备份到剪贴板，可随时找回。',
      confirmText: '选择文件',
      success: (m) => {
        if (!m.confirm) return;
        that.autoBackupThen(() => {
          wx.showLoading({ title: '读取中' });
          backup.importFromFile().then(report => {
            wx.hideLoading();
            that.afterImport(report);
          }).catch(err => {
            wx.hideLoading();
            if (String(err.message).indexOf('取消') >= 0) return;
            wx.showModal({ title: '恢复失败', content: err.message || '无法解析该文件', showCancel: false });
          });
        });
      }
    });
  },

  // —— 恢复：从剪贴板 ——
  importFromClipboard() {
    const that = this;
    wx.showModal({
      title: '从剪贴板恢复？',
      content: '请先复制备份的 JSON 全文，此操作会覆盖当前数据。恢复前我会自动备份当前数据到剪贴板。',
      confirmText: '恢复',
      success: (m) => {
        if (!m.confirm) return;
        // 先取出用户要恢复的备份原文，避免被下面的"自动备份"覆盖掉
        wx.getClipboardData({
          success: (res) => {
            const userBackup = res.data;
            that.autoBackupThen(() => {
              wx.showLoading({ title: '解析中' });
              try {
                // 走容错通道：脏数据会被修复/跳过并汇总，不再因单条异常整体失败
                const report = backup.importSnapshotText(userBackup);
                wx.hideLoading();
                that.afterImport(report);
              } catch (err) {
                wx.hideLoading();
                wx.showModal({ title: '恢复失败', content: err.message || '剪贴板内容不是有效的备份', showCancel: false });
              }
            });
          },
          fail: () => wx.showToast({ title: '剪贴板读取失败', icon: 'none' })
        });
      }
    });
  },

  // 导入结果汇总：成功条数 + 自动修复 + 跳过脏数据 + 前几条告警
  afterImport(report) {
    const applied = report.applied || {};
    const names = { books: '在读书', bookRead: '已读书', skills: '技能', skillAchieved: '徽章', workouts: '训练', body: '身体', todos: '待办', countdown: '倒计时', templates: '训练模板' };
    const parts = Object.keys(applied).map(k => `${names[k] || k} ${applied[k]}`).join(' · ');
    this.refresh();

    const lines = [];
    if (parts) lines.push(parts);
    if (report.totalRepaired) lines.push(`自动修复 ${report.totalRepaired} 条（缺失编号/非法取值已纠正）`);
    if (report.totalSkipped) lines.push(`跳过 ${report.totalSkipped} 条无法识别的脏数据`);
    (report.warnings || []).slice(0, 2).forEach(w => lines.push('注意：' + w.msg));

    wx.showModal({
      title: (report.totalSkipped || report.totalRepaired) ? '恢复完成（部分数据已处理）' : '恢复完成',
      content: lines.join('\n') || '未找到可恢复的数据',
      showCancel: false
    });
  },

  clearAll() {
    wx.showModal({
      title: '清空全部数据？',
      content: '本地数据会被清空且不可恢复。建议先做一次备份。',
      confirmColor: '#A32D2D',
      success: (m) => {
        if (!m.confirm) return;
        backup.DATA_KEYS.forEach(k => { wx.removeStorageSync(storage.KEYS[k]); });
        this.refresh();
        wx.showToast({ title: '已清空', icon: 'none' });
      }
    });
  },

  // ===== 数据瘦身：备份过大时精准清理历史记录 =====
  // 流程固定为：体检 -> 试算预览 -> 归档留底 -> 执行。任何一步用户都能反悔。

  toggleCleanup() {
    if (this.data.cleanup.open) { this.setData({ 'cleanup.open': false }); return; }
    const a = cleanup.analyze();
    this.setData({
      'cleanup.open': true,
      'cleanup.totalText': cleanup.humanSize(a.totalBytes),
      'cleanup.thresholdText': cleanup.humanSize(a.threshold),
      'cleanup.overSized': a.overSized,
      'cleanup.items': a.items.map(it => ({
        key: it.key,
        name: it.name,
        count: it.count,
        sizeText: cleanup.humanSize(it.bytes),
        pct: it.pct,
        mode: it.mode
      }))
    });
  },

  // 一键瘦身：自动算出「清到目标体积以下所需的最小力度」
  suggestClean() {
    const sg = cleanup.suggest(backup.LARGE_SNAPSHOT_BYTES);
    if (!sg.needed) { wx.showToast({ title: '体积正常，无需瘦身', icon: 'none' }); return; }
    let content;
    if (sg.notEnough) {
      content = '自动清理最多能降到 ' + cleanup.humanSize(sg.afterBytes) +
        '，仍高于建议上限 ' + cleanup.humanSize(backup.LARGE_SNAPSHOT_BYTES) +
        '。建议再手动清掉占用最大的那张表。\n\n仍要按最大力度清理吗？';
    } else {
      content = '将清理 ' + sg.days + ' 天前的历史记录，' +
        '并为每本书／每项技能保留最近 30 条打卡流水。\n\n' +
        '预计删除 ' + sg.totalRemoved + ' 条，占用从 ' + cleanup.humanSize(sg.totalBytes) +
        ' 降到 ' + cleanup.humanSize(sg.afterBytes) + '。';
    }
    this._confirmClean(sg.plan, '一键瘦身', content);
  },

  // 单表清理：按该表的性质给出不同选项
  pickClean(e) {
    const key = e.currentTarget.dataset.key;
    const mode = e.currentTarget.dataset.mode;
    const name = e.currentTarget.dataset.name;
    const opts = [];
    if (mode === 'time') opts.push('清理半年以前', '清理一年以前', '清理两年以前', '只保留最近 100 条', '清空这张表');
    else if (mode === 'inner') opts.push('打卡流水只留最近 30 条', '打卡流水只留最近 60 条', '打卡流水全部清空');
    else opts.push('清空这张表');
    opts.push('取消');

    wx.showActionSheet({
      itemList: opts,
      success: (r) => {
        const idx = r.tapIndex;
        const label = opts[idx];
        if (!label || label === '取消') return;
        let plan = null;
        if (mode === 'time') {
          const days = [180, 365, 730][idx];
          if (days) plan = [{ key: key, mode: 'before', value: days }];
          else if (idx === 3) plan = [{ key: key, mode: 'keep', value: 100 }];
          else plan = [{ key: key, mode: 'all' }];
        } else if (mode === 'inner') {
          const n = [30, 60][idx];
          plan = [{ key: key, mode: 'trim', value: n || 0 }];
        } else {
          plan = [{ key: key, mode: 'all' }];
        }
        const pv = cleanup.preview(plan);
        if (!pv.totalRemoved) { wx.showToast({ title: '没有可清理的数据', icon: 'none' }); return; }
        this._confirmClean(plan, name + ' · ' + label,
          '将删除 ' + pv.totalRemoved + ' 条，释放 ' + cleanup.humanSize(pv.freedBytes) + '。');
      },
      fail: () => {}
    });
  },

  // 统一的「确认 -> 归档 -> 执行」。归档失败就中止，绝不裸删。
  _confirmClean(plan, title, content) {
    wx.showModal({
      title: title,
      content: content + '\n\n删除前会先把这些数据复制到剪贴板作为归档，随时可找回。',
      confirmText: '清理并归档',
      confirmColor: '#A32D2D',
      success: (m) => {
        if (!m.confirm) return;
        const ar = cleanup.buildArchive(plan);
        wx.setClipboardData({
          data: ar.text,
          success: () => {
            const r = cleanup.apply(plan);
            if (!r.ok) {
              wx.showModal({ title: '清理失败', content: (r.error || '未知错误') + '\n数据未改动。', showCancel: false });
              return;
            }
            this.refresh();
            this.setData({ 'cleanup.open': false });
            wx.showModal({
              title: '清理完成',
              content: '已删除 ' + r.totalRemoved + ' 条，占用降到 ' + cleanup.humanSize(r.afterBytes) +
                '。\n\n被删数据已复制到剪贴板——请粘贴到「文件传输助手」保存；' +
                '需要时用「从剪贴板恢复」就能找回。',
              showCancel: false
            });
          },
          fail: () => {
            wx.showModal({ title: '已中止', content: '归档复制失败，为安全起见没有删除任何数据，请重试。', showCancel: false });
          }
        });
      }
    });
  },

  // ===== 云备份（暂未开放）=====
  // 当前仅为入口占位：点击直接提示「功能升级中」，不触发任何云写入，与本地备份互不影响。
  cloudComingSoon() {
    wx.showToast({ title: '功能升级中', icon: 'none', duration: 1600 });
  },

  // P1 暗色模式开关
  toggleDark(e) {
    const dark = !!e.detail.value;
    const settings = wx.getStorageSync('baoge:settings') || {};
    settings.dark = dark;
    wx.setStorageSync('baoge:settings', settings);
    const app = getApp();
    if (app) app.globalData.themeDark = dark;
    this.setData({ dark });            // 让 switch 的 checked 立即跟随
    if (app && app.applyTheme) app.applyTheme(this);
    wx.showToast({ title: dark ? '已切暗色' : '已切亮色', icon: 'none', duration: 900 });
  }
});
