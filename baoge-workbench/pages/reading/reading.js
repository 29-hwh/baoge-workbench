// pages/reading/reading.js
// v0.5 基线 + v0.9 升级：①阅读记录改名/逐条删除/上限覆盖最早(保留创建时间)
//  ②加书单表单合并 ③阅读计时 ④书卡进度弧视觉增强 ⑤多行书评+标签 ⑥书墙排序 ⑦搜索
const app = getApp();
const storage = require('../../utils/storage');
const color = require('../../utils/color');
const util = require('../../utils/util');
const derive = require('../../utils/derive');

const MAX_RECORDS = 50;   // 每本书阅读记录上限

// 进度单位辅助
function unitWord(b) {
  const t = (b && b.progressType) || 'chapter';
  return t === 'page' ? '页' : (t === 'percent' ? '%' : '章');
}
function recLabel(b, at) {
  const t = (b && b.progressType) || 'chapter';
  if (t === 'page') return '读到 ' + at + ' 页';
  if (t === 'percent') return '至 ' + at + '%';
  return '读到第 ' + at + ' 章';
}

// 注：v1 已移除「读书计时」功能（readSeconds / startReadTimer / stopReadTimer 整体下线），
// 进度统一走「记进度」入口（滑块定位 + 读了一节合并）。

// 落一条阅读记录（带 createdAt）；达上限覆盖最早一条并保留其 createdAt
function pushRecord(book, rec) {
  const records = book.records || [];
  if (records.length >= MAX_RECORDS) {
    let ei = 0;
    for (let i = 1; i < records.length; i++) {
      if ((records[i].createdAt || 0) < (records[ei].createdAt || 0)) ei = i;
    }
    records[ei] = Object.assign({}, records[ei], rec);  // 保留最初 createdAt
  } else {
    records.push(rec);
  }
  book.records = records;
}

// （计时功能已移除，无需 fmtDuration）

Page({
  data: {
    tab: 'shelf', isShelf: true, isWall: false,
    books: [], reads: [],
    // 书摘本功能已下架（保留读书笔记 Markdown 导出、书评）
    avgPercent: 0,
    stats: { total: 0, month: 0, notes: 0 },
    week: { books: 0, steps: 0 },
    expandedId: '',
    readDetail: null,
    search: '',
    wallSort: 'time',   // time | rating
    wallAuthor: '',     // 按作者筛选（''=全部）
    authors: [],        // 已读作者去重列表（供筛选 chips）
    dateSel: { show: false, min: '', max: '', value: '' },
    jump: { show: false, id: '', title: '', mode: 'chapter', min: 0, max: 100, step: 1, val: 0, pct: 0, label: '' },
    // 加书单表单（合并：书名/作者/单位/总量一行 + 目标读完日 + 自动待办开关）
    bookSheet: { show: false, editId: '', title: '', author: '', unit: 'chapter', total: '', deadline: '', autoTodo: false, error: '' },
    // 书评编辑（多行 + 标签）
    reviewSheet: { show: false, id: '', review: '', tags: '' },
    // 进度满 100% 弹出的「上墙」填写界面：评分必填 + 书评选填
    finishSheet: { show: false, id: '', rating: 0, review: '' }
  },

  onShow() {
    const app = getApp();
    if (app.applyTheme) app.applyTheme(this);
    const expandId = app.globalData.expandBookId || '';
    app.globalData.expandBookId = '';
    if (expandId) {
      const book = storage.list('books').find(b => b._id === expandId);
      if (book && book.status !== 'read') {
        this.data.expandedId = expandId;
        this.setData({ tab: 'shelf', isShelf: true, isWall: false });
      } else if (book && book.status === 'read') {
        this._deepDetailId = expandId;
      } else {
        const r = storage.list('bookRead').find(it => it._id === expandId);
        if (r) this._deepDetailId = expandId;
      }
    }
    this.refresh();
  },

  refresh() {
    const q = (this.data.search || '').trim();
    let books = storage.list('books').filter(b => b.status !== 'read');
    if (q) books = books.filter(b => (b.title || '').indexOf(q) >= 0 || (b.author || '').indexOf(q) >= 0);

    // 已读作者去重（供按作者筛选）
    const allReads = storage.list('bookRead').slice();
    const authors = [];
    allReads.forEach(r => {
      const a = (r.author || '').trim();
      if (a && authors.indexOf(a) < 0) authors.push(a);
    });
    authors.sort((x, y) => x.localeCompare(y));

    let reads = allReads;
    if (this.data.wallAuthor) {
      reads = reads.filter(r => (r.author || '').trim() === this.data.wallAuthor);
    }
    // 1.2：搜索栏已迁移到书墙，按书名/作者过滤已读书
    if (q) {
      reads = reads.filter(r => (r.title || '').indexOf(q) >= 0 || (r.author || '').indexOf(q) >= 0);
    }
    if (this.data.wallSort === 'rating') {
      reads.sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.finishedAt || 0) - (a.finishedAt || 0));
    } else if (this.data.wallSort === 'author') {
      // 1.3：按作者姓名排序（缺作者排末尾），次级按读完时间倒序
      reads.sort((a, b) => (a.author || '一').localeCompare(b.author || '一') || (b.finishedAt || 0) - (a.finishedAt || 0));
    } else {
      reads.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    }

    const now = new Date();
    const curYM = now.getFullYear() * 100 + (now.getMonth() + 1);
    let monthCount = 0, notesCount = 0;
    allReads.forEach(r => {
      if (r.finishedAt) {
        const d = new Date(r.finishedAt);
        if (d.getFullYear() * 100 + (d.getMonth() + 1) === curYM) monthCount++;
      }
      if (r.records && r.records.length) notesCount += r.records.length;
    });
    books.forEach(b => { if (b.records && b.records.length) notesCount += b.records.length; });

    const expandedId = this.data.expandedId;

    // 1.4：书脊墙动态缩放——书越多，单根书脊越窄、略矮；大数量时书墙限高竖向滚动，保证观赏性与浏览体验
    const rn = reads.length;
    let spineW = 66, spineH = 224;
    if (rn > 80) { spineW = 42; spineH = 152; }
    else if (rn > 50) { spineW = 46; spineH = 172; }
    else if (rn > 30) { spineW = 52; spineH = 196; }
    else if (rn > 15) { spineW = 58; spineH = 212; }
    const wallScroll = rn > 40;

    reads.forEach(r => {
      if (r.finishedAt) {
        const d = new Date(r.finishedAt);
        const diff = Math.round((Date.now() - r.finishedAt) / 86400000);
        if (diff <= 0) r.finishedLabel = '今天读完';
        else if (diff === 1) r.finishedLabel = '昨天读完';
        else if (diff < 7) r.finishedLabel = diff + '天前读完';
        else r.finishedLabel = d.getFullYear() + '.' + (d.getMonth() + 1) + ' 读完';
      }
      if (r.startDate && r.finishedAt) {
        const days = util.diffDays(r.startDate, util.toISO(new Date(r.finishedAt)));
        r.durationLabel = days <= 0 ? '当天读完' : '历时 ' + days + ' 天';
      } else { r.durationLabel = ''; }
      r.ratingText = r.rating ? '★★★★★'.slice(0, r.rating) + '☆☆☆☆☆'.slice(0, 5 - r.rating) : '';
    });

    books.forEach(b => {
      const p = util.progressOf(b);
      b.percent = p.total ? p.percent : 0;
      b.arc = p.total ? p.percent : 0;
      const author = b.author ? b.author + ' · ' : '';
      b.subtitle = p.total ? util.progressDesc(b) : '未设定进度目标';
      b.unitText = unitWord(b);
      b.authorLine = author + (b.startDate ? util.formatCN(b.startDate) + ' 开始' : (b.author ? '' : '未填作者'));
      const dline = util.deadlineLabel(b.deadline);
      b.deadlineText = dline;
      b.overdue = !!b.deadline && util.isPast(b.deadline);
      b.recordCount = (b.records || []).length;
      b.isExpanded = expandedId === b._id;
      b.recExpanded = false;   // 阅读记录默认折叠（仅显示最后三条）
      b.recViews = (b.isExpanded && b.recordCount)
        ? (b.records || []).slice().sort((a, c) => (c.date || '').localeCompare(a.date || '') || (c.createdAt || 0) - (a.createdAt || 0))
            .slice(0, 50).map(rec => ({
              date: rec.date,
              createdAt: rec.createdAt || 0,
              label: recLabel(b, rec.chapter != null ? rec.chapter : rec.at),
              note: rec.note || ''
            }))
        : [];
    });

    const withTotal = books.filter(b => util.progressOf(b).total > 0);
    const avgPercent = withTotal.length
      ? Math.round(withTotal.reduce((s, b) => s + b.percent, 0) / withTotal.length)
      : 0;

    this.setData({
      books, reads, avgPercent,
      stats: { total: allReads.length, month: monthCount, notes: notesCount },
      week: this.buildWeekReport(),
      authors: authors,
      spineW, spineH, wallScroll,
      today: util.todayISO(),
      tab: this.data.tab
    }, () => {
      if (this._deepDetailId) {
        const id = this._deepDetailId;
        this._deepDetailId = '';
        if (reads.some(it => it._id === id)) {
          this.setData({ tab: 'wall', isShelf: false, isWall: true });
          this.openReadDetail(id);
        }
      }
    });
  },

  buildWeekReport() {
    const startTs = util.startOfWeek(Date.now());
    const startISO = util.toISO(new Date(startTs));
    const touched = new Set();
    let steps = 0;
    storage.list('books').forEach(b => {
      (b.records || []).forEach(rec => {
        if (rec.date && rec.date >= startISO) { touched.add(b._id); steps++; }
      });
      if (b.status === 'read' && b.finishedAt && b.finishedAt >= startTs) { touched.add(b._id); steps++; }
    });
    return { books: touched.size, steps };
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab, isShelf: tab === 'shelf', isWall: tab === 'wall' });
  },

  // ===== 搜索 / 书墙排序 / 作者筛选 =====
  onSearch(e) {
    this.setData({ search: e.detail.value }, () => this.refresh());
  },
  clearSearch() { this.setData({ search: '' }, () => this.refresh()); },
  setWallSort(e) {
    const s = e.currentTarget.dataset.sort;
    if (s === this.data.wallSort) return;
    this.setData({ wallSort: s }, () => this.refresh());
  },
  setWallAuthor(e) {
    const a = e.currentTarget.dataset.author;
    this.setData({ wallAuthor: a }, () => this.refresh());
  },

  // ===== 加书 / 编辑：单表单合并（书名 + 作者 + 单位 + 总量）=====
  addBook() { this.openBookSheet(null); },
  openBookSheet(book) {
    if (book) {
      this.setData({
        bookSheet: {
          show: true, editId: book._id, title: book.title, author: book.author || '',
          unit: book.progressType || 'chapter',
          total: book.progressType === 'percent' ? '' : (book.totalChapters || book.totalPages || ''),
          deadline: book.deadline || '',
          autoTodo: !!book.autoTodo,
          error: ''
        }
      });
    } else {
      this.setData({ bookSheet: { show: true, editId: '', title: '', author: '', unit: 'chapter', total: '', deadline: '', autoTodo: false, error: '' } });
    }
  },
  closeBookSheet() { this.setData({ 'bookSheet.show': false }); },
  onBookTitle(e) { this.setData({ 'bookSheet.title': e.detail.value }); },
  onBookAuthor(e) { this.setData({ 'bookSheet.author': e.detail.value }); },
  onBookUnit(e) { this.setData({ 'bookSheet.unit': e.currentTarget.dataset.unit }); },
  onBookTotal(e) { this.setData({ 'bookSheet.total': e.detail.value }); },
  // 加书表单：选填「目标读完日」（未来日期；不填则不写入 deadline）
  onBookDeadline(e) {
    const iso = e.detail.value;
    if (!iso) return;
    this.setData({ 'bookSheet.deadline': iso });
  },
  onBookAutoTodo(e) {
    const on = !!e.detail.value;
    if (on) {
      // 开启自动待办前置条件：必须已设目标读完日（编辑书看已存 deadline；新建书看表单里刚选的 deadline）
      const bs = this.data.bookSheet;
      const hasDeadline = bs.editId
        ? (() => { const b = storage.list('books').find(x => x._id === bs.editId); return !!(b && b.deadline); })()
        : !!bs.deadline;   // 新建书：表单里已选目标日即可
      if (!hasDeadline) {
        wx.showToast({ title: '请先设置目标读完日，再开启自动待办', icon: 'none', duration: 1500 });
        return;    // 保持开关关闭，不写入 autoTodo
      }
    }
    this.setData({ 'bookSheet.autoTodo': on });
  },
  saveBookSheet() {
    const s = this.data.bookSheet;
    const title = (s.title || '').trim();
    if (!title) { this.setData({ 'bookSheet.error': '请填书名' }); return; }
    // 书名查重：建立读书计划时检索所有书籍（在读/已读），确保书名唯一
    if (!s.editId) {
      const exist = storage.list('books').concat(storage.list('bookRead'))
        .some(b => (b.title || '').trim() === title);
      if (exist) { this.setData({ 'bookSheet.error': '书名已存在，换一个吧' }); return; }
    }
    // 自动待办门禁：开启前必须已设目标读完日（新建书看表单里刚选的 deadline；编辑书看已存 deadline）
    if (s.autoTodo) {
      const hasDeadline = s.editId ? (() => { const b = storage.list('books').find(x => x._id === s.editId); return !!(b && b.deadline); })() : !!s.deadline;
      if (!hasDeadline) { this.setData({ 'bookSheet.error': '请先设置目标读完日，再开启自动待办' }); return; }
    }
    const author = (s.author || '').trim();
    const unit = s.unit || 'chapter';
    const total = unit === 'percent' ? 0 : (parseInt(s.total, 10) || 0);
    if (unit !== 'percent' && total <= 0) {
      this.setData({ 'bookSheet.error': '请填写总量（页数/章数）' });
      return;
    }
    if (s.editId) {
      const book = storage.list('books').find(b => b._id === s.editId);
      if (book) {
        const oldUnit = book.progressType || 'chapter';
        const oldP = util.progressOf(book);
        const patch = { title, author, progressType: unit, autoTodo: !!s.autoTodo, deadline: s.deadline || '' };
        if (unit === 'percent') {
          patch.progressPercent = oldUnit !== unit ? Math.round(oldP.percent) : (book.progressPercent || 0);
        } else {
          if (unit === 'page') patch.totalPages = total; else patch.totalChapters = total;
          const putCur = v => { if (unit === 'page') patch.currentPage = v; else patch.currentChapter = v; };
          if (oldUnit !== unit) {
            if (oldP.total > 0 && total > 0) putCur(Math.round(oldP.percent / 100 * total));
            else putCur(0);
          } else if (total === 0) { putCur(0); }
          else {
            const oldTotal = unit === 'page' ? (book.totalPages || 0) : (book.totalChapters || 0);
            if (oldP.total > 0 && oldP.total !== total) putCur(Math.round(oldP.cur / oldP.total * total));
          }
        }
        storage.update('books', s.editId, patch);
        wx.showToast({ title: '已更新', icon: 'success', duration: 900 });
      }
    } else {
      const existing = storage.list('books');
      const nb = { title, author, progressType: unit, status: 'reading', startDate: util.todayISO(), records: [], color: color.pickFor(existing.length), autoTodo: !!s.autoTodo, deadline: s.deadline || '' };
      if (unit === 'page') { nb.totalPages = total; nb.currentPage = 0; }
      else if (unit === 'percent') { nb.progressPercent = 0; }
      else { nb.totalChapters = total; nb.currentChapter = 0; }
      storage.add('books', nb);
      wx.showToast({ title: '已上架', icon: 'success', duration: 900 });
    }
    this.closeBookSheet();
    this.refresh();
  },

  // ===== 记进度 =====
  openJump(e) {
    const id = e.currentTarget.dataset.id;
    const b = storage.list('books').find(it => it._id === id);
    if (!b) return;
    const p = util.progressOf(b);
    if (!p.total) { wx.showToast({ title: '先设进度目标（⋯管理 → 书名/作者）', icon: 'none', duration: 1800 }); return; }
    const mode = b.progressType || 'chapter';
    let max = p.total, step = 1;
    if (mode === 'percent') { max = 100; step = 5; }
    else if (mode === 'page') { step = p.total > 200 ? 10 : (p.total > 60 ? 5 : 1); }
    const val = Math.max(0, Math.min(p.cur, max));
    this.setData({ jump: { show: true, id, title: b.title, mode, min: 0, max, step, val, pct: max ? Math.round(val * 100 / max) : 0, label: this.jumpLabel(mode, val, max) } });
  },
  jumpLabel(mode, v, total) {
    if (mode === 'percent') return '已读 ' + v + '%';
    if (mode === 'page') return '读到第 ' + v + ' / ' + total + ' 页';
    return v <= 0 ? '还没开始（第 0 章）' : '已读到第 ' + v + ' / ' + total + ' 章';
  },
  onJumpChange(e) {
    const v = Number(e.detail.value);
    const j = this.data.jump;
    if (!j) return;
    this.setData({ 'jump.val': v, 'jump.pct': j.max ? Math.round(v * 100 / j.max) : 0, 'jump.label': this.jumpLabel(j.mode, v, j.max) });
  },
  commitJump() {
    const j = this.data.jump;
    if (!j || !j.id) return;
    this.closeJump();
    this.commitProgress(j.id, j.val, false);
  },
  closeJump() { this.setData({ 'jump.show': false }); },
  commitProgress(id, nextVal, isStep) {
    const books = storage.list('books');
    const b = books.find(it => it._id === id);
    if (!b) return;
    const p0 = util.progressOf(b);
    if (!p0.total) { wx.showToast({ title: '先设进度目标（⋯管理 → 书名/作者）', icon: 'none', duration: 1800 }); return; }
    const t = b.progressType || 'chapter';
    if (isStep) { util.stepProgress(b); }
    else {
      const v = Math.max(0, Math.min(Number(nextVal), p0.total));
      if (t === 'page') b.currentPage = v;
      else if (t === 'percent') b.progressPercent = v;
      else b.currentChapter = v;
    }
    const p = util.progressOf(b);
    pushRecord(b, { date: util.todayISO(), chapter: p.cur, note: '', createdAt: Date.now() });
    storage.update('books', id, Object.assign({ records: b.records }, this.curPatch(b)));
    if (this.data.jump && this.data.jump.show) this.closeJump();
    if (p.done) {
      // 进度到 100% → 弹出「上墙」填写界面（评分必填 + 书评选填），不直接上墙
      this.openFinishSheet(id);
    } else {
      this.refresh();
      wx.showToast({ title: (isStep ? '已记 · ' : '已定位 · ') + util.progressDesc(b), icon: 'none', duration: 900 });
    }
  },
  // 进度满 100% / 手动"读完全本" 共用的上墙弹层（评分必填、书评选填）
  openFinishSheet(id) {
    const b = storage.list('books').find(it => it._id === id);
    if (!b || b.status === 'read') return;
    this.setData({ finishSheet: { show: true, id, rating: 0, review: '' } });
  },
  onFinishRating(e) {
    const r = parseInt(e.currentTarget.dataset.r, 10);
    if (!r) return;
    this.setData({ 'finishSheet.rating': r });
  },
  onFinishReview(e) { this.setData({ 'finishSheet.review': e.detail.value }); },
  closeFinishSheet() { this.setData({ 'finishSheet.show': false }); },
  // 提交「上墙」：评分必填，缺评分工件不完成
  saveFinish() {
    const f = this.data.finishSheet;
    if (!f || !f.show) return;
    if (!f.rating) { wx.showToast({ title: '请先给个评分 ⭐', icon: 'none' }); return; }
    const id = f.id;
    this.setData({ 'finishSheet.show': false });
    this.autoFinishBook(id, util.todayISO(), f.rating, (f.review || '').trim());
    wx.showToast({ title: '🎉 已读完并自动上墙', icon: 'none', duration: 1800 });
  },
  // 进度满 100% / 手动"读完全本" 共用的上墙逻辑（评分 + 书评一并写入书脊墙）
  autoFinishBook(id, finishISO, rating, review) {
    const books = storage.list('books');
    const b = books.find(it => it._id === id);
    if (!b || b.status === 'read') return;
    const t = b.progressType || 'chapter';
    if (t === 'page') b.currentPage = b.totalPages || b.currentPage || 0;
    else if (t === 'percent') b.progressPercent = 100;
    else b.currentChapter = b.totalChapters || b.currentChapter || 0;
    b.status = 'read';
    b.finishedAt = util.parseISO(finishISO).getTime();
    b.finishedDate = finishISO;
    b.rating = rating || 0;
    b.review = review || '';
    wx.setStorageSync(storage.KEYS.books, books);
    const read = storage.list('bookRead').filter(it => it._id !== id);
    read.push(Object.assign({}, b, { finishedAt: b.finishedAt, finishedDate: finishISO, tags: b.tags || [], review: review || '' }));
    wx.setStorageSync(storage.KEYS.bookRead, read);
    this.refresh();
  },
  curPatch(b) {
    const t = b.progressType || 'chapter';
    if (t === 'page') return { currentPage: b.currentPage || 0 };
    if (t === 'percent') return { progressPercent: b.progressPercent || 0 };
    return { currentChapter: b.currentChapter || 0 };
  },

  // ===== 记一笔：阅读记录（随手保存，同样推进一节）=====
  addRecord(e) {
    const id = e.currentTarget.dataset.id;
    const books = storage.list('books');
    const b = books.find(it => it._id === id);
    if (!b) return;
    const p0 = util.progressOf(b);
    wx.showModal({
      title: '记一笔 · ' + b.title,
      editable: true,
      placeholderText: '阅读记录 / 金句 / 感受（留空则只记进度）',
      success: (r) => {
        if (!r.confirm) return;
        const note = (r.content || '').trim();
        let advanced = false;
        if (p0.total && !p0.done) { util.stepProgress(b); advanced = true; }
      const p = util.progressOf(b);
      pushRecord(b, { date: util.todayISO(), chapter: p.cur, note, createdAt: Date.now() });
      storage.update('books', id, Object.assign({ records: b.records }, this.curPatch(b)));
      this.data.expandedId = id;
      if (p.done) {
        this.openFinishSheet(id);
      } else {
        this.refresh();
        wx.showToast({ title: advanced ? '已记一笔并推进' : '已保存阅读记录', icon: 'success', duration: 1200 });
      }
      }
    });
  },

  // 删除单条阅读记录（按 createdAt 定位）
  deleteRecord(e) {
    const id = e.currentTarget.dataset.id;
    const ca = Number(e.currentTarget.dataset.ca);
    const books = storage.list('books');
    const b = books.find(it => it._id === id);
    if (!b) return;
    wx.showModal({
      title: '删除这条阅读记录？',
      success: (m) => {
        if (!m.confirm) return;
        b.records = (b.records || []).filter(rec => (rec.createdAt || 0) !== ca);
        storage.update('books', id, { records: b.records });
        this.refresh();
      }
    });
  },

  toggleExpand(e) {
    const id = e.currentTarget.dataset.id;
    this.data.expandedId = (this.data.expandedId === id ? '' : id);
    this.refresh();
  },
  // 书架书卡：阅读记录「查看全部 / 收起」（默认显示最后三条）
  toggleBookRecords(e) {
    const id = e.currentTarget.dataset.id;
    const books = this.data.books;
    const b = books.find(it => it._id === id);
    if (!b) return;
    b.recExpanded = !b.recExpanded;
    this.setData({ books });
  },

  // ===== 读完 → 日期 → 评分 → 书评 =====
  finishBook(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '读完啦？',
      content: '推上书脊墙，写下评分与一句话书评',
      success: (r) => { if (r.confirm) this.pickFinishDate(id); }
    });
  },
  pickFinishDate(id) {
    const that = this;
    const today = util.todayISO();
    const yes = util.addDaysISO(today, -1);
    wx.showActionSheet({
      itemList: ['今天完成（' + util.formatCN(today) + '）', '昨天完成（' + util.formatCN(yes) + '）', '更早（补记过去日期）…'],
      success: (r) => {
        if (r.tapIndex === 0) that.pickRating(id, today);
        else if (r.tapIndex === 1) that.pickRating(id, yes);
        else if (r.tapIndex === 2) that.pickPastDate(id);
      }
    });
  },
  pickPastDate(id) {
    const that = this;
    const today = util.todayISO();
    this._pastCb = (iso) => that.pickRating(id, iso);
    this.setData({ dateSel: { show: true, min: '2000-01-01', max: today, value: util.addDaysISO(today, -1) } });
  },
  onPastDateChange(e) {
    const val = e.detail.value;
    const cb = this._pastCb;
    this.setData({ dateSel: { show: false } });
    this._pastCb = null;
    if (cb && val) cb(val);
  },
  closePastSel() { this.setData({ dateSel: { show: false } }); this._pastCb = null; },
  pickRating(id, finishISO) {
    const that = this;
    wx.showActionSheet({
      itemList: ['★★★★★ 很棒', '★★★★ 不错', '★★★ 还行', '★★ 一般', '★ 不推荐', '暂不评分'],
      success: (r) => {
        const map = [5, 4, 3, 2, 1, 0];
        const rating = map[r.tapIndex] !== undefined ? map[r.tapIndex] : 0;
        that.openReviewSheet(id, finishISO, rating);
      },
      fail: () => that.openReviewSheet(id, finishISO, 0)
    });
  },
  // 书评编辑（多行 + 标签）
  openReviewSheet(id, finishISO, rating) {
    const r = storage.list('bookRead').find(it => it._id === id);
    const book = storage.list('books').find(it => it._id === id);
    this._reviewCtx = { id, finishISO, rating };
    this.setData({
      reviewSheet: {
        show: true, id,
        review: (r && r.review) || (book && book._pendingReview) || '',
        tags: (r && r.tags ? r.tags.join(' ') : '')
      }
    });
  },
  closeReviewSheet() { this.setData({ 'reviewSheet.show': false }); },
  onReviewInput(e) { this.setData({ 'reviewSheet.review': e.detail.value }); },
  onReviewTags(e) { this.setData({ 'reviewSheet.tags': e.detail.value }); },
  saveReviewSheet() {
    const ctx = this._reviewCtx;
    if (!ctx) return;
    const review = (this.data.reviewSheet.review || '').trim();
    const tags = (this.data.reviewSheet.tags || '').trim().split(/\s+/).filter(Boolean);
    this.closeReviewSheet();
    this.commitFinish(ctx.id, ctx.finishISO, ctx.rating, review, tags);
  },
  commitFinish(id, finishISO, rating, review, tags) {
    const finishTs = util.parseISO(finishISO).getTime();
    const books = storage.list('books');
    const b = books.find(it => it._id === id);
    if (!b) return;
    b.status = 'read';
    b.finishedAt = finishTs;
    b.finishedDate = finishISO;
    b.rating = rating || 0;
    b.review = review || '';
    b.tags = tags || [];
    const t = b.progressType || 'chapter';
    if (t === 'page') b.currentPage = b.totalPages || b.currentPage || 0;
    else if (t === 'percent') b.progressPercent = 100;
    else b.currentChapter = b.totalChapters || b.currentChapter || 0;
    wx.setStorageSync(storage.KEYS.books, books);
    const read = storage.list('bookRead').filter(it => it._id !== id);
    read.push(Object.assign({}, b, { finishedAt: finishTs, finishedDate: finishISO, tags: tags || [] }));
    wx.setStorageSync(storage.KEYS.bookRead, read);
    this.refresh();
    if (read.length % 10 === 0) { wx.showToast({ title: '🎉 第 ' + read.length + ' 本成就达成', icon: 'none', duration: 2000 }); }
    else { wx.showToast({ title: '🎉 已上墙 · 已打星', icon: 'none', duration: 1400 }); }
  },

  // ===== 书卡「⋯ 管理」菜单 =====
  editMenu(e) {
    const id = e.currentTarget.dataset.id;
    const book = storage.list('books').find(b => b._id === id);
    if (!book) return;
    const that = this;
    const autoOn = !!book.autoTodo;
    wx.showActionSheet({
      itemList: [autoOn ? '🔕 关闭自动待办' : '🔔 开启自动待办', '✅ 读完全本', '✏ 书名 / 作者', '🎯 目标读完日', '🗑 删除这本书'],
      success: (r) => {
        if (r.tapIndex === 0) {
          if (!autoOn && !book.deadline) {
            wx.showToast({ title: '请先设置目标读完日，再开启自动待办', icon: 'none', duration: 1500 });
            return;   // 未设目标读完日 → 禁止开启自动待办
          }
          storage.update('books', id, { autoTodo: !autoOn });
          derive.deriveDailyTodos();   // 同步首页今日待办（开启→出现；关闭→清除对应待办）
          that.refresh();
          wx.showToast({ title: autoOn ? '已关闭自动待办' : '已开启 · 每天进待办', icon: 'none', duration: 1200 });
        }
        else if (r.tapIndex === 1) that.markFullyRead(id);
        else if (r.tapIndex === 2) that.openBookSheet(book);
        else if (r.tapIndex === 3) that.pickDeadline(id);
        else if (r.tapIndex === 4) that.confirmDeleteBook(id);
      }
    });
  },
  // 管理菜单「读完全本」：进度补满并直接上墙（适合手动读完、未走记进度的情况）
  markFullyRead(id) {
    const book = storage.list('books').find(b => b._id === id);
    if (!book) return;
    if (book.status === 'read') { wx.showToast({ title: '已读完', icon: 'none' }); return; }
    const that = this;
    wx.showModal({
      title: '标记读完全本？',
      content: '《' + book.title + '》进度补满并上墙，记得评分～',
      success: (m) => {
        if (!m.confirm) return;
        that.openFinishSheet(id);
      }
    });
  },
  editBook(e) { this.editMenu(e); },
  confirmDeleteBook(id) {
    wx.showModal({
      title: '确认删除？', content: '这本书会从书架移除',
      success: (m) => { if (m.confirm) { storage.remove('books', id); this.refresh(); } }
    });
  },
  pickDeadline(id) {
    const that = this;
    const today = util.todayISO();
    const opts = [7, 30, 60, 90].map(d => d + ' 天后（' + util.formatCN(util.addDaysISO(today, d)) + '）');
    opts.push('自定义日期…', '清除目标');
    wx.showActionSheet({
      itemList: opts,
      success: (r) => {
        const book = storage.list('books').find(b => b._id === id);
        if (!book) return;
        if (r.tapIndex < 4) {
          const iso = util.addDaysISO(today, [7, 30, 60, 90][r.tapIndex]);
          storage.update('books', id, { deadline: iso });
          this.refresh();
          wx.showToast({ title: '目标 ' + util.formatCN(iso) + ' 前读完', icon: 'none', duration: 1500 });
        } else if (r.tapIndex === 4) { that.inputDeadline(id); }
        else if (r.tapIndex === 5) { storage.update('books', id, { deadline: '' }); this.refresh(); }
      }
    });
  },
  inputDeadline(id) {
    wx.showModal({
      title: '目标读完日期', editable: true, placeholderText: '格式 YYYY-MM-DD（今天或之后）',
      success: (m) => {
        if (!m.confirm) return;
        const iso = (m.content || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !util.parseISO(iso).getTime()) { wx.showToast({ title: '格式不对，如 2026-12-31', icon: 'none' }); return; }
        if (util.isPast(iso)) { wx.showToast({ title: '目标日不能在过去', icon: 'none' }); return; }
        storage.update('books', id, { deadline: iso });
        this.refresh();
        wx.showToast({ title: '已设目标日', icon: 'success', duration: 900 });
      }
    });
  },

  // ===== 书摘本功能已下架（v1 移除）；保留「导出读书笔记 Markdown」(exportNotes) 与书评 =====

  // ===== 导出读书笔记 Markdown =====
  exportNotes() {
    const md = this.buildMarkdown();
    const d = new Date();
    const p = n => (n < 10 ? '0' + n : '' + n);
    const name = '宝哥读书笔记_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.md';
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
    const books = storage.list('books').filter(b => b.status !== 'read');
    const reads = storage.list('bookRead').sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    const L = [];
    const d = new Date();
    const p = n => (n < 10 ? '0' + n : '' + n);
    L.push('# 📚 宝哥的读书笔记');
    L.push(''); L.push('> 导出时间 ' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())); L.push('');
    L.push('## 📖 在读 ' + books.length + ' 本');
    books.forEach(b => {
      const pg = util.progressOf(b);
      L.push(''); L.push('### 《' + b.title + '》' + (b.author ? ' — ' + b.author : ''));
      L.push('- 进度：' + util.progressDesc(b) + (pg.total ? '（' + pg.percent + '%）' : ''));
      if (b.startDate) L.push('- 开始阅读：' + util.formatCN(b.startDate));
      if (b.deadline) L.push('- 目标：' + util.deadlineLabel(b.deadline));
      const recs = (b.records || []).slice().sort((x, y) => (x.date || '').localeCompare(y.date || ''));
      if (recs.length) {
        L.push('- 阅读记录 ' + recs.length + ' 条：');
        recs.forEach(rec => L.push('  - ' + rec.date + ' ' + recLabel(b, rec.chapter != null ? rec.chapter : rec.at) + (rec.note ? '：' + rec.note : '')));
      }
    });
    L.push(''); L.push('## 🏆 已读 ' + reads.length + ' 本');
    reads.forEach(b => {
      L.push(''); L.push('### 《' + b.title + '》' + (b.author ? ' — ' + b.author : ''));
      L.push('- 读完：' + (b.finishedDate ? util.formatCN(b.finishedDate) : ''));
      L.push('- 评分：' + (b.rating ? '★'.repeat(b.rating) + '☆'.repeat(5 - b.rating) + '（' + b.rating + '/5）' : '未评分'));
      if (b.tags && b.tags.length) L.push('- 标签：' + b.tags.join(' / '));
      if (b.review) L.push('- 书评：' + b.review);
      const recs = (b.records || []).slice().sort((x, y) => (x.date || '').localeCompare(y.date || ''));
      if (recs.length) {
        L.push('- 阅读记录 ' + recs.length + ' 条：');
        recs.forEach(rec => L.push('  - ' + rec.date + ' ' + recLabel(b, rec.chapter != null ? rec.chapter : rec.at) + (rec.note ? '：' + rec.note : '')));
      }
    });
    return L.join('\n');
  },

  // ===== 书墙：长按弹详情 =====
  showReadDetail(e) { this.openReadDetail(e.currentTarget.dataset.id); },
  openReadDetail(id) {
    const r = storage.list('bookRead').find(it => it._id === id);
    if (!r) return;
    if (r.finishedAt) {
      const d = new Date(r.finishedAt);
      const diff = Math.round((Date.now() - r.finishedAt) / 86400000);
      if (diff <= 0) r.finishedLabel = '今天读完';
      else if (diff === 1) r.finishedLabel = '昨天读完';
      else if (diff < 7) r.finishedLabel = diff + '天前读完';
      else r.finishedLabel = d.getFullYear() + '.' + (d.getMonth() + 1) + ' 读完';
    }
    if (r.startDate && r.finishedAt) {
      const days = util.diffDays(r.startDate, util.toISO(new Date(r.finishedAt)));
      r.durationLabel = days <= 0 ? '当天读完' : '历时 ' + days + ' 天';
    } else { r.durationLabel = ''; }
    r.ratingText = r.rating ? '★★★★★'.slice(0, r.rating) + '☆☆☆☆☆'.slice(0, 5 - r.rating) : '点这里评分';
    r.startLabel = r.startDate ? util.formatCN(r.startDate) + ' 开始' : '';
    r.tagText = (r.tags && r.tags.length) ? r.tags.join(' / ') : '';
    const recs = (r.records || []).slice().sort((a, c) => (c.date || '').localeCompare(a.date || '') || (c.createdAt || 0) - (a.createdAt || 0));
    r.noteTotal = recs.length;
    r.noteShowAll = false;   // 书墙详情读书记录默认仅显示最后三条
    r.noteViews = recs.slice(0, 3).map(rec => ({ date: rec.date, createdAt: rec.createdAt || 0, label: recLabel(r, rec.chapter != null ? rec.chapter : rec.at), note: rec.note || '' }));
    this.setData({ readDetail: r });
  },
  // 书墙详情：读书记录「查看全部 / 收起」
  toggleNoteAll() {
    const r = this.data.readDetail;
    if (!r) return;
    const showAll = !r.noteShowAll;
    const recs = (r.records || []).slice().sort((a, c) => (c.date || '').localeCompare(a.date || '') || (c.createdAt || 0) - (a.createdAt || 0));
    this.setData({
      'readDetail.noteShowAll': showAll,
      'readDetail.noteViews': (showAll ? recs : recs.slice(0, 3)).map(rec => ({
        date: rec.date,
        createdAt: rec.createdAt || 0,
        label: recLabel(r, rec.chapter != null ? rec.chapter : rec.at),
        note: rec.note || ''
      }))
    });
  },
  closeReadDetail() { this.setData({ readDetail: null }); },
  noop() {},
  changeRating() {
    const r = this.data.readDetail;
    if (!r) return;
    const that = this;
    wx.showActionSheet({
      itemList: ['★★★★★ 很棒', '★★★★ 不错', '★★★ 还行', '★★ 一般', '★ 不推荐', '取消'],
      success: (m) => {
        const map = [5, 4, 3, 2, 1];
        if (m.tapIndex >= 5) return;
        const rating = map[m.tapIndex];
        const read = storage.list('bookRead');
        const idx = read.findIndex(it => it._id === r._id);
        if (idx >= 0) { read[idx].rating = rating; wx.setStorageSync(storage.KEYS.bookRead, read); }
        that.setData({ 'readDetail.rating': rating, 'readDetail.ratingText': '★★★★★'.slice(0, rating) + '☆☆☆☆☆'.slice(0, 5 - rating) });
        that.refresh();
        wx.showToast({ title: '已打星', icon: 'success', duration: 800 });
      }
    });
  },
  // 书评：打开发编辑弹层（多行 + 标签）
  openDetailReview() {
    const r = this.data.readDetail;
    if (!r) return;
    this._reviewCtx = { id: r._id, finishISO: r.finishedDate, rating: r.rating, isDetail: true };
    this.setData({ reviewSheet: { show: true, id: r._id, review: r.review || '', tags: (r.tags || []).join(' ') } });
  },
  deleteNoteFromDetail(e) {
    const ca = Number(e.currentTarget.dataset.ca);
    const r = this.data.readDetail;
    if (!r) return;
    wx.showModal({
      title: '删除这条阅读记录？',
      success: (m) => {
        if (!m.confirm) return;
        const read = storage.list('bookRead');
        const idx = read.findIndex(it => it._id === r._id);
        if (idx >= 0) {
          read[idx].records = (read[idx].records || []).filter(rec => (rec.createdAt || 0) !== ca);
          wx.setStorageSync(storage.KEYS.bookRead, read);
        }
        this.openReadDetail(r._id);
        this.refresh();
      }
    });
  },
  editReview() { this.openDetailReview(); },
  deleteFromDetail() {
    const r = this.data.readDetail;
    if (!r) return;
    const that = this;
    wx.showModal({
      title: '确认删除？', content: '这本书会从书脊墙移除',
      success: (m) => {
        if (!m.confirm) return;
        const arr = storage.list('bookRead');
        wx.setStorageSync(storage.KEYS.bookRead, arr.filter(it => it._id !== r._id));
        that.setData({ readDetail: null });
        that.refresh();
        wx.showToast({ title: '已删除', icon: 'none', duration: 800 });
      }
    });
  }
});
