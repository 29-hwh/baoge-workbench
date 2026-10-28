// utils/util.js
// 通用工具函数

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// Date → 'YYYY-MM-DD'（本地时区）
function toISO(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// 在 ISO 日期上加 n 天（n 可为负），返回 ISO
function addDaysISO(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

// 'YYYY-MM-DD' → Date（本地零点）
function parseISO(iso) {
  const p = String(iso).split('-').map(Number);
  return new Date(p[0], (p[1] || 1) - 1, p[2] || 1);
}

// 计算 b 相对 a 差几天（b - a，同日为 0，b 在未来为正）
function diffDays(aISO, bISO) {
  const da = parseISO(aISO);
  const db = parseISO(bISO);
  return Math.round((db - da) / 86400000);
}

// 某 ISO 日期是否已过去（早于今天）
function isPast(iso) {
  return diffDays(todayISO(), iso) < 0;
}

// 'YYYY-MM-DD' → '9月3日 周五'（附星期，可选）
function formatCN(iso, withWeek) {
  const d = parseISO(iso);
  const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const base = (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return withWeek ? base + ' ' + weeks[d.getDay()] : base;
}

// 倒计时核心：给定目标日期，返回距今天数。
// isAnnual=true 表示"每年这一天"（如生日/纪念日），会取最近一次未来日期计算
function countdownDays(targetISO, isAnnual) {
  const today = todayISO();
  let t = targetISO;
  if (isAnnual) {
    // 取今年的月日；若今年已过，看明年
    const cur = parseISO(targetISO);
    const now = new Date();
    const thisYear = cur.getFullYear() === now.getFullYear()
      ? parseISO(targetISO)
      : new Date(now.getFullYear(), cur.getMonth(), cur.getDate());
    t = toISO(thisYear);
    if (isPast(t)) t = addDaysISO(t, 366); // 粗略跳明年，避免闰年误判用 isPast 二次处理
    // 精确处理跨年与闰年：直接算下一个"月日">=今天
    if (isPast(t)) {
      t = toISO(new Date(now.getFullYear() + 1, cur.getMonth(), cur.getDate()));
    }
  }
  return diffDays(today, t);
}

function todayLabel() {
  const d = new Date();
  const weeks = ['日', '一', '二', '三', '四', '五', '六'];
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 · 周' + weeks[d.getDay()];
}

// 'YYYY-MM-DD' → 'M.D'（紧凑副标签，如 10.5）
function fmtMD(iso) {
  const d = parseISO(iso);
  return (d.getMonth() + 1) + '.' + d.getDate();
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatDate(ts) {
  const d = new Date(ts);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

function relativeDate(ts) {
  const now = Date.now();
  const diff = now - ts;
  const day = 86400000;
  if (diff < day) return '今天';
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return Math.floor(diff / day) + '天前';
  return formatDate(ts);
}

// 周一作为一周开始
function startOfWeek(ts) {
  const d = new Date(ts);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day); // 周日=0 时回退 6 天
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatTime(ts) {
  const d = new Date(ts);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 '
    + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 数值限定
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

// ===== 读书进度统一模型（P1：章 / 页 / 百分比 三单位共存）=====
// book.progressType: 'chapter'(缺省) | 'page' | 'percent'
//   chapter → totalChapters / currentChapter
//   page    → totalPages / currentPage
//   percent → progressPercent（0~100，无总量）
// 返回 { cur, total, percent(0-100), done }
function progressOf(b) {
  const t = (b && b.progressType) || 'chapter';
  if (t === 'page') {
    const cur = b.currentPage || 0, total = b.totalPages || 0;
    return { cur, total, percent: total ? Math.round(cur * 100 / total) : 0, done: total > 0 && cur >= total };
  }
  if (t === 'percent') {
    const p = clamp(b.progressPercent || 0, 0, 100);
    return { cur: p, total: 100, percent: p, done: p >= 100 };
  }
  const cur = b.currentChapter || 0, total = b.totalChapters || 0;
  return { cur, total, percent: total ? Math.round(cur * 100 / total) : 0, done: total > 0 && cur >= total };
}

// 步进一节：chapter +1 章；page +1 页；percent +5%（封顶总量/100）
function stepProgress(b) {
  const t = (b && b.progressType) || 'chapter';
  if (t === 'page') {
    const total = b.totalPages || 0;
    b.currentPage = Math.min((b.currentPage || 0) + 1, total > 0 ? total : Infinity);
  } else if (t === 'percent') {
    b.progressPercent = Math.min(100, (b.progressPercent || 0) + 5);
  } else {
    const total = b.totalChapters || 0;
    b.currentChapter = Math.min((b.currentChapter || 0) + 1, total > 0 ? total : Infinity);
  }
}

// 进度副标题文案
function progressDesc(b) {
  const t = (b && b.progressType) || 'chapter';
  if (t === 'page') {
    const total = b.totalPages || 0;
    return total ? '读到 ' + (b.currentPage || 0) + ' / ' + total + ' 页' : '阅读中';
  }
  if (t === 'percent') return '已读 ' + (b.progressPercent || 0) + '%';
  const total = b.totalChapters || 0;
  return total ? '读到第 ' + (b.currentChapter || 0) + ' / ' + total + ' 章' : '阅读中';
}

// "再读一节后"的目标文案（供首页派生待办描述下一步动作）
function progressNextDesc(b) {
  const t = (b && b.progressType) || 'chapter';
  if (t === 'page') {
    const total = b.totalPages || 0;
    return total ? '读到 ' + Math.min((b.currentPage || 0) + 1, total) + ' / ' + total + ' 页'
                 : '阅读中';
  }
  if (t === 'percent') return '读至 ' + Math.min(100, (b.progressPercent || 0) + 5) + '%';
  const total = b.totalChapters || 0;
  return total ? '读到第 ' + Math.min((b.currentChapter || 0) + 1, total) + ' / ' + total + ' 章'
               : '阅读中';
}

// 目标日文案：deadline(ISO) → 「目标 9月30日 · 剩N天 / 已超N天」
function deadlineLabel(deadline) {
  if (!deadline) return '';
  const left = diffDays(todayISO(), deadline);
  const cn = formatCN(deadline);
  if (left > 0) return '目标 ' + cn + ' 前读完 · 剩 ' + left + ' 天';
  if (left === 0) return '目标 ' + cn + ' · 就是今天';
  return '目标 ' + cn + ' · 已超 ' + (-left) + ' 天';
}

// ===== 农历（阴阳合历）1900-2099 =====
// lunarInfo 每项 20 位：低 4 位=闰月(0 表示无)，第 16 位=闰月大小(1=30天)，
// 其余位（bit15..bit4）从高位到低位表示正~腊（含闰月顺序）每月大小(1=30天)。
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,//1900-09
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,//1910-19
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,//1920-29
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,//1930-39
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,//1940-49
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,//1950-59
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,//1960-69
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,//1970-79
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,//1980-89
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,//1990-99
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,//2000-09
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,//2010-19
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,//2020-29
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,//2030-39
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,//2040-49
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,//2050-59
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,//2060-69
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,//2070-79
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,//2080-89
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,//2090-99
  0x0d520//2100
];

const LUNAR_MONTH_CN = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
const LUNAR_DAY_CN = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
const ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
const TIANGAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const DIZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

function lYearDays(y) {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - 1900] & i) ? 1 : 0;
  return sum + leapDays(y);
}
function leapDays(y) {
  if (leapMonth(y)) return (LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29;
  return 0;
}
function leapMonth(y) { return LUNAR_INFO[y - 1900] & 0xf; }
function monthDays(y, m) { return (LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29; }

// 公历 ISO → 农历对象
function solarToLunar(iso) {
  const p = String(iso).split('-').map(Number);
  const y = p[0], mo = p[1], d = p[2];
  // 全程用 UTC 做天数差，避免本地时区（如历史 LMT +8:05）造成跨世纪 1 天偏移
  const baseUTC = Date.UTC(1900, 0, 31);     // 农历 1900 正月初一（UTC 参照）
  const curUTC = Date.UTC(y, mo - 1, d);
  let offset = Math.round((curUTC - baseUTC) / 86400000);
  // 年：逐年农历年天数相减（offset 为当年已过的天数，0 = 正月初一）
  let year = 1900, temp = 0;
  for (year = 1900; year < 2101 && offset > 0; year++) {
    temp = lYearDays(year);
    offset -= temp;
  }
  if (offset < 0) { offset += temp; year--; }
  const leap = leapMonth(year);
  // 月：逐月（含闰月）推进，offset 为进入当月后已过天数，day = offset + 1
  let isLeap = false, month = 1, day = 1;
  while (month <= 12) {
    let len = monthDays(year, month);
    if (offset < len) { day = offset + 1; break; }
    offset -= len;
    // 闰月排在“当月”之后（如闰六月在六月之后）
    if (leap > 0 && month === leap) {
      len = leapDays(year);
      if (offset < len) { isLeap = true; day = offset + 1; break; }
      offset -= len;
    }
    month++;
  }
  const gzYear = TIANGAN[(year - 4) % 10] + DIZHI[(year - 4) % 12];
  const monthCn = (isLeap ? '闰' : '') + LUNAR_MONTH_CN[month - 1] + '月';
  const dayCn = LUNAR_DAY_CN[day - 1];
  return {
    year, month, day, isLeap, monthCn, dayCn,
    zodiac: ZODIAC[(year - 4) % 12],
    gzYear,
    label: '农历' + gzYear + '年 ' + monthCn + dayCn
  };
}

// 农历 → 公历 ISO（ly:农历年, lm:农历月(1-12), ld:日(1-30), isLeap:是否闰月）
// 全程 UTC 运算，规避本地时区历史偏移导致的 1 天误差
function lunarToSolar(ly, lm, ld, isLeap) {
  const baseUTC = Date.UTC(1900, 0, 31);
  let offset = 0;
  for (let y = 1900; y < ly; y++) offset += lYearDays(y);
  const leap = leapMonth(ly);
  for (let m = 1; m < lm; m++) {
    offset += monthDays(ly, m);
    if (leap > 0 && m === leap) offset += leapDays(ly);
  }
  if (isLeap) offset += monthDays(ly, lm);  // 闰月：先走正常月再走闰月
  offset += ld - 1;
  const dt = new Date(baseUTC + offset * 86400000);
  return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
}

// 农历某年包含的月份数组（含闰月项），供 picker 渲染
function lunarMonthsOf(y) {
  const leap = leapMonth(y);
  const arr = [];
  for (let m = 1; m <= 12; m++) {
    arr.push({ m, isLeap: false, label: LUNAR_MONTH_CN[m - 1] + '月', days: monthDays(y, m) });
    if (leap > 0 && m === leap) {
      arr.push({ m, isLeap: true, label: '闰' + LUNAR_MONTH_CN[m - 1] + '月', days: leapDays(y) });
    }
  }
  return arr;
}

module.exports = {
  pad, todayISO, toISO, addDaysISO, parseISO, diffDays, isPast, formatCN,
  todayLabel, startOfDay, countdownDays, fmtMD,
  formatDate, formatTime, relativeDate, startOfWeek, clamp,
  progressOf, stepProgress, progressDesc, progressNextDesc, deadlineLabel,
  solarToLunar, lunarToSolar, lunarMonthsOf
};