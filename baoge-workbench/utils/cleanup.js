// utils/cleanup.js
// 宝哥工作台 · 数据瘦身（清理历史记录）
//
// 背景：备份体积过大时（> 5MB），小程序端解析十几 MB 的 JSON 会卡顿甚至失败。
//      只提示「请清理历史记录」等于把难题甩给用户，所以这里提供一整套闭环：
//        体检（谁占了多少） -> 试算（清完能省多少） -> 归档（删之前先留底） -> 执行
//
// 三条铁律：
//   1. 先看清再动手：所有删除都支持 dry-run 预览，先算出「删几条 / 省多少」
//   2. 删之前先留底：默认把将被删除的数据导出为一份「归档备份」，清理 ≠ 丢失
//   3. 绝不误删在用的：倒计时/训练模板/在读书籍不参与自动清理，只能手动清空
//
// 分工：本模块只做「分析 + 试算 + 删除」，不碰 UI、不做弹窗。

'use strict';

const storage = require('./storage');
const backup = require('./backup');

const DATA_KEYS = backup.DATA_KEYS;

const KEY_NAMES = {
  books: '在读书籍',
  bookRead: '已读书籍',
  skills: '在学技能',
  skillAchieved: '已达成徽章',
  workouts: '训练记录',
  body: '身体记录',
  todos: '待办',
  countdown: '倒计时',
  templates: '训练模板'
};

// 可按时间安全清理的历史流水（越老越没用，删了不影响当前使用）
const TIME_CLEANABLE = ['bookRead', 'workouts', 'body', 'todos'];
// 只能瘦身「内部 records 数组」的表：它们本身代表进行中的事，不能按时间整条删，
// 但内部每天累积的打卡流水是真正的体积大户
const INNER_TRIMMABLE = ['books', 'skills', 'skillAchieved'];
// 受保护：倒计时多为未来事件、模板是用户配置，均不参与任何自动清理
const PROTECTED = ['countdown', 'templates'];

// 智能推荐的清理档位（天）：从最小力度开始试，取第一个能把总量降到目标以下的
const SUGGEST_STEPS = [180, 365, 730, 1095, 1825];
// 内部 records 的保留上限：每本书/每项技能最多留这么多条打卡流水
const SUGGEST_TRIM_KEEP = 30;

// ==================== 时间与体积基础 ====================
function dayStart(daysAgo) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

// 取一条记录的「发生时间」——优先用业务日期，回退到创建时间
function timeOf(rec) {
  if (!rec || typeof rec !== 'object') return 0;
  if (typeof rec.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rec.date)) {
    const t = new Date(rec.date + 'T00:00:00').getTime();
    if (Number.isFinite(t)) return t;
  }
  if (typeof rec.finishedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rec.finishedDate)) {
    const t = new Date(rec.finishedDate + 'T00:00:00').getTime();
    if (Number.isFinite(t)) return t;
  }
  const ts = rec.finishedAt || rec.achievedAt || rec.completedAt || rec.startedAt || rec.createdAt || 0;
  return typeof ts === 'number' && ts > 0 ? ts : 0;
}

// 单条记录的序列化体积（UTF-8 字节）
function bytesOfRecord(rec) {
  try { return backup.bytesOf(JSON.stringify(rec)); }
  catch (e) { return 0; }
}

// ==================== ① 体检：谁占了多少 ====================
// 返回 { totalBytes, totalCount, items:[{key,name,count,bytes,pct,oldest,newest,cleanable}], overSized }
function analyze() {
  const items = [];
  let totalBytes = 0, totalCount = 0;

  DATA_KEYS.forEach(k => {
    const list = storage.list(k) || [];
    let bytes = 0, oldest = 0, newest = 0;
    list.forEach(r => {
      bytes += bytesOfRecord(r);
      const t = timeOf(r);
      if (t > 0) {
        if (!oldest || t < oldest) oldest = t;
        if (t > newest) newest = t;
      }
    });
    totalBytes += bytes;
    totalCount += list.length;
    items.push({
      key: k,
      name: KEY_NAMES[k] || k,
      count: list.length,
      bytes: bytes,
      pct: 0,
      oldest: oldest,
      newest: newest,
      // 能否被自动策略清理（受保护表返回 false，UI 上不给自动选项）
      cleanable: PROTECTED.indexOf(k) < 0,
      mode: TIME_CLEANABLE.indexOf(k) >= 0 ? 'time'
        : (INNER_TRIMMABLE.indexOf(k) >= 0 ? 'inner' : 'manual')
    });
  });

  items.forEach(it => { it.pct = totalBytes ? +(it.bytes / totalBytes * 100).toFixed(1) : 0; });
  items.sort((a, b) => b.bytes - a.bytes);

  return {
    totalBytes: totalBytes,
    totalCount: totalCount,
    items: items,
    overSized: totalBytes >= backup.LARGE_SNAPSHOT_BYTES,
    threshold: backup.LARGE_SNAPSHOT_BYTES
  };
}

// ==================== ② 试算（dry-run）：这个方案能删掉什么 ====================
// plan: [{ key, mode, value }]
//   mode='before'  value=天数   删除「N 天之前」的记录（仅 time 类表）
//   mode='keep'    value=条数   只保留最近 N 条（仅 time 类表）
//   mode='all'                  清空整表（任何表，但受保护表需调用方显式确认）
//   mode='trim'    value=条数   每条记录内部 records 只保留最近 N 条（仅 inner 类表）
//
// 返回 { removes:[{key,name,count,bytes}], totalRemoved, totalBytes, freedBytes, afterBytes, affects:[] }
function preview(plan) {
  const removes = [];
  const affects = [];
  let freed = 0, removed = 0;
  let beforeTotal = 0;

  DATA_KEYS.forEach(k => {
    const list = storage.list(k) || [];
    list.forEach(r => { beforeTotal += bytesOfRecord(r); });
  });

  (plan || []).forEach(p => {
    const key = p.key;
    if (DATA_KEYS.indexOf(key) < 0) return;
    const list = storage.list(key) || [];
    if (!list.length) return;

    let keep = list;
    let changed = 0, freedBytes = 0;

    if (p.mode === 'all') {
      changed = list.length;
      list.forEach(r => { freedBytes += bytesOfRecord(r); });
      keep = [];
    } else if (p.mode === 'before' && TIME_CLEANABLE.indexOf(key) >= 0) {
      const cut = dayStart(p.value || 0);
      keep = list.filter(r => {
        const t = timeOf(r);
        // 取不到时间的记录一律保留（宁可多留，也不能误删）
        if (!t) return true;
        if (t < cut) { changed++; freedBytes += bytesOfRecord(r); return false; }
        return true;
      });
    } else if (p.mode === 'keep' && TIME_CLEANABLE.indexOf(key) >= 0) {
      const n = p.value || 0;
      if (list.length > n) {
        // 按时间倒序保留最近的 n 条
        const sorted = list.slice().sort((a, b) => timeOf(b) - timeOf(a));
        const drop = sorted.slice(n);
        changed = drop.length;
        drop.forEach(r => { freedBytes += bytesOfRecord(r); });
        const keepSet = new Set(sorted.slice(0, n));
        keep = list.filter(r => keepSet.has(r));
      }
    } else if (p.mode === 'trim' && INNER_TRIMMABLE.indexOf(key) >= 0) {
      const n = p.value || 0;
      keep = list.map(r => {
        const recs = r && Array.isArray(r.records) ? r.records : null;
        if (!recs || recs.length <= n) return r;
        const drop = recs.length - n;
        const sorted = recs.slice().sort((a, b) => timeOf(b) - timeOf(a));
        const trimmed = sorted.slice(0, n);
        freedBytes += bytesOfRecord(recs) - bytesOfRecord(trimmed);
        changed += drop;
        const out = {};
        Object.keys(r).forEach(f => { out[f] = r[f]; });
        out.records = trimmed;
        return out;
      });
    }

    if (changed > 0) {
      removes.push({ key: key, name: KEY_NAMES[key] || key, count: changed, bytes: freedBytes, mode: p.mode, value: p.value });
      affects.push({ key: key, list: keep });
      freed += freedBytes;
      removed += changed;
    }
  });

  return {
    removes: removes,
    // affects 是「清理后应保留的列表」，apply 直接拿它落库。
    // 必须与 removes 同源，保证「预览说删哪些」==「实际删哪些」。
    affects: affects,
    totalRemoved: removed,
    totalBytes: beforeTotal,
    freedBytes: freed,
    afterBytes: beforeTotal - freed
  };
}

// ==================== ③ 归档：把「将被删除的数据」单独导出留底 ====================
// 与 preview 用同一套判定逻辑，保证「预览说删哪些」和「归档留了哪些」完全一致
function buildArchive(plan) {
  const data = {};
  DATA_KEYS.forEach(k => { data[k] = []; });

  (plan || []).forEach(p => {
    const key = p.key;
    if (DATA_KEYS.indexOf(key) < 0) return;
    const list = storage.list(key) || [];
    if (!list.length) return;

    if (p.mode === 'all') {
      data[key] = list.slice();
    } else if (p.mode === 'before' && TIME_CLEANABLE.indexOf(key) >= 0) {
      const cut = dayStart(p.value || 0);
      data[key] = list.filter(r => { const t = timeOf(r); return t && t < cut; });
    } else if (p.mode === 'keep' && TIME_CLEANABLE.indexOf(key) >= 0) {
      const n = p.value || 0;
      if (list.length > n) {
        const sorted = list.slice().sort((a, b) => timeOf(b) - timeOf(a));
        data[key] = sorted.slice(n);
      }
    } else if (p.mode === 'trim' && INNER_TRIMMABLE.indexOf(key) >= 0) {
      const n = p.value || 0;
      list.forEach(r => {
        const recs = r && Array.isArray(r.records) ? r.records : null;
        if (!recs || recs.length <= n) return;
        const sorted = recs.slice().sort((a, b) => timeOf(b) - timeOf(a));
        const dropped = sorted.slice(n);
        if (!dropped.length) return;
        const shell = {};
        Object.keys(r).forEach(f => { shell[f] = r[f]; });
        shell.records = dropped;
        data[key].push(shell);
      });
    }
  });

  const counts = {};
  let total = 0;
  DATA_KEYS.forEach(k => { counts[k] = data[k].length; total += data[k].length; });

  return {
    archived: counts,
    totalArchived: total,
    text: JSON.stringify({
      app: 'baoge-workbench',
      type: 'cleanup-archive',
      version: backup.SNAPSHOT_VERSION,
      exportedAt: Date.now(),
      note: '本文件是被清理掉的历史数据归档，可用「从剪贴板恢复」找回（恢复会覆盖当前数据，请先备份当前数据）',
      counts: counts,
      data: data
    }, null, 2)
  };
}

// ==================== ④ 执行：真正删除（调用前应先归档） ====================
// 返回 { ok, removed:{key:n}, totalRemoved, freedBytes, afterBytes }
function apply(plan) {
  const pv = preview(plan);
  if (!pv.totalRemoved) {
    return { ok: true, removed: {}, totalRemoved: 0, freedBytes: 0, afterBytes: pv.afterBytes };
  }
  const affects = pv.affects || [];
  // 防御：试算说有可删数据、却拿不到保留列表，属于内部不一致，必须显式报错而不是静默跳过
  if (!affects.length) {
    return { ok: false, error: '试算结果缺少待写入列表，已中止（未改动任何数据）', removed: {}, totalRemoved: 0, freedBytes: 0 };
  }
  const removed = {};
  try {
    affects.forEach(a => {
      removed[a.key] = (storage.list(a.key) || []).length - a.list.length;
      storage.set(a.key, a.list);
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) || '写入失败', removed: removed, totalRemoved: 0, freedBytes: 0 };
  }
  return {
    ok: true,
    removed: removed,
    totalRemoved: pv.totalRemoved,
    freedBytes: pv.freedBytes,
    afterBytes: pv.afterBytes
  };
}

// ==================== ⑤ 智能推荐：清到目标体积以下的最小方案 ====================
// 从「清理半年」开始逐步加大力度，返回第一个能把总量降到 targetBytes 以下的方案。
// 力度从小到大，保证「少删、够用」——不做一刀切。
function suggest(targetBytes) {
  const target = targetBytes || backup.LARGE_SNAPSHOT_BYTES;
  const base = analyze();
  // 判定口径就是「当前体积是否超过目标」，与 5MB 告警阈值解耦，
  // 这样上层既能瘦身到 5MB 以下，也能指定任意更小的目标。
  if (base.totalBytes <= target) {
    return { needed: false, plan: [], totalBytes: base.totalBytes, afterBytes: base.totalBytes, freedBytes: 0, steps: [] };
  }

  const steps = [];
  for (let i = 0; i < SUGGEST_STEPS.length; i++) {
    const days = SUGGEST_STEPS[i];
    const plan = TIME_CLEANABLE.map(k => ({ key: k, mode: 'before', value: days }))
      .concat(INNER_TRIMMABLE.map(k => ({ key: k, mode: 'trim', value: SUGGEST_TRIM_KEEP })));
    const pv = preview(plan);
    steps.push({ days: days, afterBytes: pv.afterBytes, freedBytes: pv.freedBytes, removed: pv.totalRemoved });
    if (pv.afterBytes <= target) {
      return {
        needed: true,
        plan: plan,
        days: days,
        totalBytes: base.totalBytes,
        afterBytes: pv.afterBytes,
        freedBytes: pv.freedBytes,
        totalRemoved: pv.totalRemoved,
        removes: pv.removes,
        steps: steps
      };
    }
  }
  // 所有档位都降不到目标：返回力度最大的一档，由用户决定是否手动清空某张表
  const last = steps[steps.length - 1];
  const plan = TIME_CLEANABLE.map(k => ({ key: k, mode: 'before', value: SUGGEST_STEPS[SUGGEST_STEPS.length - 1] }))
    .concat(INNER_TRIMMABLE.map(k => ({ key: k, mode: 'trim', value: SUGGEST_TRIM_KEEP })));
  return {
    needed: true,
    plan: plan,
    days: SUGGEST_STEPS[SUGGEST_STEPS.length - 1],
    totalBytes: base.totalBytes,
    afterBytes: last.afterBytes,
    freedBytes: last.freedBytes,
    totalRemoved: last.removed,
    notEnough: true,
    steps: steps
  };
}

// ==================== 描述文案 ====================
function humanSize(n) { return backup.humanSize(n); }

function describePlan(pv) {
  if (!pv || !pv.removes || !pv.removes.length) return '没有可清理的数据';
  return pv.removes.map(r => {
    const what = r.mode === 'trim' ? '打卡流水' : '条';
    return r.name + ' ' + r.count + ' ' + what + '（省 ' + humanSize(r.bytes) + '）';
  }).join('；');
}

module.exports = {
  DATA_KEYS: DATA_KEYS,
  KEY_NAMES: KEY_NAMES,
  TIME_CLEANABLE: TIME_CLEANABLE,
  INNER_TRIMMABLE: INNER_TRIMMABLE,
  PROTECTED: PROTECTED,
  SUGGEST_STEPS: SUGGEST_STEPS,
  dayStart: dayStart,
  timeOf: timeOf,
  bytesOfRecord: bytesOfRecord,
  analyze: analyze,
  preview: preview,
  buildArchive: buildArchive,
  apply: apply,
  suggest: suggest,
  describePlan: describePlan,
  humanSize: humanSize
};
