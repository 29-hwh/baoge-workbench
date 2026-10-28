// utils/trend.js
// 轻量趋势折线数据（供健身「身体」页：体重 / 体脂曲线）
// 纯函数、零依赖（仅 util），可单测：buildTrendSeries(records, metric, range)
// records: [{ date:'YYYY-MM-DD', weight:70.2, fat:18.5 }...]（weight/fat 可缺省）
// metric: 'weight' | 'fat'
// range : '1m' | '3m' | '6m' | 'all'
// 返回 { points:[{date,v}], min, max }，min/max 已含 8% 边距，画布可直接用

const util = require('./util');

function fmt(n) {
  return Math.round(n * 10) / 10;
}

function buildTrendSeries(records, metric, range) {
  const key = metric === 'fat' ? 'fat' : 'weight';
  const today = util.todayISO();
  let from = '';
  if (range === '1m') from = util.addDaysISO(today, -30);
  else if (range === '3m') from = util.addDaysISO(today, -90);
  else if (range === '6m') from = util.addDaysISO(today, -180);

  const pts = [];
  (records || []).forEach(r => {
    if (!r || !r.date) return;
    if (from && r.date < from) return;
    if (r.date > today) return;
    const v = parseFloat(r[key]);
    if (!isFinite(v)) return;
    pts.push({ date: r.date, v });
  });
  if (!pts.length) return { points: [], min: 0, max: 0 };

  // 同一天多笔 → 取平均（通常一天只记一笔）
  const byDate = new Map();
  pts.forEach(p => {
    const arr = byDate.get(p.date) || [];
    arr.push(p.v);
    byDate.set(p.date, arr);
  });
  const agg = [];
  byDate.forEach((vs, d) => {
    agg.push({ date: d, v: vs.reduce((s, x) => s + x, 0) / vs.length });
  });
  agg.sort((a, b) => a.date.localeCompare(b.date));

  // 点数 > 60 时抽稀（保留首尾）
  let data = agg;
  if (agg.length > 60) {
    data = [];
    const stride = Math.ceil(agg.length / 60);
    for (let i = 0; i < agg.length; i += stride) data.push(agg[i]);
    const last = agg[agg.length - 1];
    if (data[data.length - 1].date !== last.date) data.push(last);
  }

  let min = Infinity, max = -Infinity;
  data.forEach(p => { if (p.v < min) min = p.v; if (p.v > max) max = p.v; });
  if (!isFinite(min) || !isFinite(max)) return { points: [], min: 0, max: 0 };
  if (min === max) { min -= 1; max += 1; }
  const pad = Math.max(0.5, (max - min) * 0.08);
  min -= pad;
  max += pad;

  return {
    points: data.map(p => ({ date: p.date, v: fmt(p.v) })),
    min: fmt(min),
    max: fmt(max)
  };
}

module.exports = { buildTrendSeries };
