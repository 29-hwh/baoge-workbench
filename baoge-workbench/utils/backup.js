// utils/backup.js
// 宝哥工作台 · 备份与恢复（纯本地方案，无需云开发）
//
// 设计要点：
//   1. 导出为 JSON 文件 -> 通过 wx.shareFileMessage 发给微信好友/文件传输助手
//      这是小程序里唯一能"把数据搬到电脑"的官方通道，无需域名、无需服务器
//   2. 恢复走 wx.chooseMessageFile —— 直接从聊天记录里选中刚才那个文件
//   3. 数据量小（个人使用通常 < 200KB），剪贴板作为降级通道
//   4. 快照带 version / exportedAt / checksum，导入时做校验，防止误导入与截断文件
//
// 容错策略（v0.10 增强）：
//   · 导入：文件级校验（JSON/标识/结构）失败 -> 整体拒绝，不动任何数据
//           记录级校验（字段缺失/类型错误/非法值）-> 能修就修、修不了才跳过，逐条记入报告
//           写入阶段出错 -> 自动回滚到导入前的完整数据
//   · 导出：空数据仅告警不阻断；序列化后做自检（反序列化比对校验和）；
//           写文件失败自动重试（默认 3 次）并读回校验，仍失败则降级剪贴板
//   · 全程写日志（getLog），单条数据异常绝不影响整批任务

const storage = require('./storage');
const util = require('./util');
const guard = require('./backupGuard');

const SNAPSHOT_VERSION = 1;
// 备份范围 = 全部"业务数据"表（数组型）。
// templates(健身·用户自定义/收藏训练模板) 为业务数据，v0.9 起纳入备份；
// settings(dark 主题 / lastBackupAt) 为设备偏好对象，刻意不入快照：换机后主题按新设备重设、
// lastBackupAt 缺失会自然触发"该备份了"提醒，语义正确。
const DATA_KEYS = ['books', 'bookRead', 'skills', 'skillAchieved', 'workouts', 'body', 'todos', 'countdown', 'templates'];

// 大备份阈值：5MB。
// 实测 2000 条长字段即可让快照达到 13MB；小程序 JS 引擎一次性 JSON.parse 十几 MB
// 文本容易出现卡顿乃至失败。达到该阈值时在导出结果里给出明确提示，并在导入解析
// 失败时优先指向「文件过大」而不是笼统的「文件损坏」，避免用户误判为数据损坏。
const LARGE_SNAPSHOT_BYTES = 5 * 1024 * 1024;
// 纯 JS 的 UTF-8 字节长度（不依赖任何小程序/Node 专有 API）
function bytesOf(text) {
  const s = String(text == null ? '' : text);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; } // 代理对（emoji 等）
    else n += 3;
  }
  return n;
}
function humanSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

// ==================== 日志 ====================
const LOG = [];
const LOG_MAX = 300;
function log(level, code, msg, extra) {
  const e = { t: Date.now(), level: level, code: code, msg: msg };
  if (extra !== undefined) e.extra = extra;
  LOG.push(e);
  if (LOG.length > LOG_MAX) LOG.shift();
  try {
    if (level === 'error' || level === 'warn') {
      const line = '[baoge:backup] ' + level + ' ' + code + ' - ' + msg;
      if (level === 'error') console.error(line); else console.warn(line);
    }
  } catch (e2) { /* 日志打印失败不影响主流程 */ }
  return e;
}
function getLog() { return LOG.slice(); }
function getRecentLog(n) { return LOG.slice(-(n || 20)); }
function clearLog() { LOG.length = 0; }

// ==================== 快照生成 ====================
function buildSnapshot() {
  const data = {};
  DATA_KEYS.forEach(k => { data[k] = storage.list(k); });
  const counts = {};
  DATA_KEYS.forEach(k => { counts[k] = data[k].length; });
  const snap = {
    app: 'baoge-workbench',
    version: SNAPSHOT_VERSION,
    exportedAt: Date.now(),
    counts: counts,
    data: data
  };
  // 校验和：用于导入时判断内容是否被截断/篡改（旧备份没有此字段，导入时放行）
  snap.checksum = guard.checksum(JSON.stringify(data));
  return snap;
}

// 序列化 + 完整性自检：确保生成的文本能被完整还原
function snapshotToText() {
  const snap = buildSnapshot();
  let text;
  try {
    text = JSON.stringify(snap, null, 2);
  } catch (e) {
    log('error', 'SERIALIZE_FAILED', '导出序列化失败：' + (e && e.message));
    throw new Error('导出失败：数据无法序列化（' + (e && e.message) + '）');
  }
  try {
    const back = JSON.parse(text);
    if (guard.checksum(JSON.stringify(back.data)) !== snap.checksum) {
      throw new Error('反序列化后校验和不一致');
    }
  } catch (e) {
    log('error', 'SNAPSHOT_SELFCHECK_FAILED', '导出自检失败：' + (e && e.message));
    throw new Error('导出失败：生成的备份自检未通过，已阻止导出损坏文件');
  }
  const total = DATA_KEYS.reduce((a, k) => a + (snap.counts[k] || 0), 0);
  if (total === 0) log('warn', 'EMPTY_DATA', '当前没有任何业务数据，导出的是一份空备份');
  return text;
}

// 解析备份文本：兼容 UTF-8 BOM / 首尾空白。
// 真实通道里，文件经微信会话传输或剪贴板粘贴可能在前部带上 BOM 或多余空白，
// 而 JSON.parse 对 BOM 会直接抛 SyntaxError，导致「整份备份无法恢复」。
function parseSnapshotText(text) {
  const t = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim();
  return JSON.parse(t);
}

function fileName() {
  const d = new Date();
  const p = n => (n < 10 ? '0' + n : '' + n);
  return '宝哥工作台备份_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.json';
}

// ==================== 导入：校验 + 清洗 + 回滚 ====================
function sumObj(o) { return Object.keys(o).reduce((a, k) => a + (o[k] || 0), 0); }

// 核心导入：接收已解析的快照对象，返回完整报告（不抛异常即代表已成功写入）
function applySnapshotObject(snapshot, opts) {
  const o = opts || {};

  // 文件级校验：失败即整体拒绝，绝不碰存储
  const shape = guard.validateSnapshotShape(snapshot, { app: o.app || 'baoge-workbench', version: SNAPSHOT_VERSION });
  if (!shape.ok) {
    const msg = (shape.errors[0] && shape.errors[0].msg) || '备份格式不正确';
    log('error', 'SNAPSHOT_INVALID', msg);
    throw new Error(msg);
  }
  const warnings = shape.warnings.slice();
  const issues = [];

  // 校验和：判断内容是否被截断/篡改（旧备份无此字段则放行）
  const ck = guard.verifyChecksum(snapshot);
  if (!ck.ok) {
    warnings.push({ code: 'CHECKSUM_MISMATCH', msg: '备份内容与校验和不一致，可能已被截断或篡改，已尽力恢复' });
    log('warn', 'CHECKSUM_MISMATCH', '校验和不一致（期望 ' + ck.expected + '，实际 ' + ck.actual + '）');
  }

  // 逐表清洗：单条异常只跳过自己，整批继续
  const clean = {}; const skipped = {}; const repaired = {}; const skippedKeys = [];
  DATA_KEYS.forEach(k => {
    const arr = shape.data[k];
    if (arr === undefined) { skippedKeys.push(k); return; }        // 老备份缺该表 -> 保留原有数据
    if (!Array.isArray(arr)) {
      warnings.push({ code: 'KEY_NOT_ARRAY', msg: '备份里「' + k + '」不是数组，已跳过该组（保留原有数据）' });
      log('warn', 'KEY_NOT_ARRAY', '备份里「' + k + '」不是数组，已跳过该组');
      return;
    }
    const r = guard.sanitizeList(k, arr);
    clean[k] = r.list; skipped[k] = r.skipped; repaired[k] = r.repaired;
    r.issues.forEach(x => issues.push(Object.assign({ key: k }, x)));
  });

  // 写入：先留旧值用于回滚，写后逐表读回校验
  const before = {};
  DATA_KEYS.forEach(k => { before[k] = wx.getStorageSync(storage.KEYS[k]); });
  const applied = {};
  try {
    Object.keys(clean).forEach(k => {
      storage.set(k, clean[k]);
      applied[k] = clean[k].length;
      const back = storage.list(k);
      if (!Array.isArray(back) || back.length !== clean[k].length) {
        throw new Error('「' + k + '」写入后校验失败（期望 ' + clean[k].length + ' 条，实际 ' + (back ? back.length : 0) + ' 条）');
      }
    });
  } catch (e) {
    // 回滚：把导入前的数据原样还原，保证不留半截状态
    DATA_KEYS.forEach(k => {
      try {
        if (before[k] === undefined || before[k] === '') wx.removeStorageSync(storage.KEYS[k]);
        else wx.setStorageSync(storage.KEYS[k], before[k]);
      } catch (e2) { log('error', 'ROLLBACK_FAILED', '回滚「' + k + '」失败'); }
    });
    log('error', 'IMPORT_ROLLBACK', '导入失败，已回滚到导入前数据：' + (e && e.message));
    throw new Error('导入失败，已自动回滚到导入前的数据（' + (e && e.message) + '）');
  }

  const report = {
    ok: true,
    applied: applied, skipped: skipped, repaired: repaired,
    skippedKeys: skippedKeys, issues: issues, warnings: warnings,
    totalApplied: sumObj(applied), totalSkipped: sumObj(skipped), totalRepaired: sumObj(repaired),
    checksumOk: ck.ok,
    logTail: getRecentLog(10)
  };
  if (report.totalSkipped || report.totalRepaired) {
    log('warn', 'IMPORT_WITH_ISSUES', '导入完成但有问题：成功 ' + report.totalApplied + '，修复 ' + report.totalRepaired + '，跳过 ' + report.totalSkipped);
  } else {
    log('info', 'IMPORT_OK', '导入完成：' + report.totalApplied + ' 条');
  }
  return report;
}

// 兼容旧调用：只返回各表条数（profile 旧写法与既有测试依赖此形状）
function applySnapshot(snapshot) {
  return applySnapshotObject(snapshot).applied;
}

// 从文本导入（文件 / 剪贴板共用），返回完整报告
function importSnapshotText(text, opts) {
  let snap;
  try {
    snap = parseSnapshotText(text);
  } catch (e) {
    const size = bytesOf(text);
    log('error', 'PARSE_FAILED', '备份解析失败：' + (e && e.message) + '（体积 ' + humanSize(size) + '）');
    // 体积过大是比「文件损坏」更常见的解析失败原因，优先指向它，避免用户误判为数据损坏
    if (size >= LARGE_SNAPSHOT_BYTES) {
      throw new Error('备份文件过大（' + humanSize(size) + '），当前设备无法解析。请清理部分历史记录后重新导出一份较小的备份');
    }
    throw new Error('不是有效的 JSON 备份文件（可能已损坏或在传输中被截断）');
  }
  return applySnapshotObject(snap, opts);
}

// ==================== 导出：重试 + 读回校验 + 降级 ====================
// 同步写入后立刻读回比对，确保落盘文件完整；失败重试 tries 次
function writeFileWithRetry(fs, filePath, text, tries) {
  const max = tries || 3;
  let lastErr = null;
  for (let i = 1; i <= max; i++) {
    try {
      fs.writeFileSync(filePath, text, 'utf8');
      const back = fs.readFileSync(filePath, 'utf8');
      if (back === text) return { ok: true, attempts: i };
      lastErr = new Error('写回内容与预期不一致（文件可能不完整）');
      log('warn', 'WRITE_VERIFY_MISMATCH', '第 ' + i + ' 次写入后校验未通过，准备重试');
    } catch (e) {
      lastErr = e;
      log('warn', 'WRITE_FAILED', '第 ' + i + ' 次写入失败：' + (e && e.message));
    }
  }
  return { ok: false, attempts: max, error: lastErr };
}

// —— 导出：JSON 文件 + 分享到微信 ——
function exportAndShare(opts) {
  const o = opts || {};
  const tries = o.tries || 3;
  let text;
  try { text = snapshotToText(); }
  catch (e) { return Promise.reject(e); }

  const warnings = [];
  const size = bytesOf(text);

  // 体积预警：过大时明确告知用户，避免「发出去了但在另一台设备上导入失败」的困惑
  if (size >= LARGE_SNAPSHOT_BYTES) {
    const msg = '备份体积较大（' + humanSize(size) + '），在部分设备上导入可能较慢或失败；建议定期清理历史记录后重新备份';
    warnings.push(msg);
    log('warn', 'SNAPSHOT_TOO_LARGE', msg);
  }

  let fs = null;
  try { fs = wx.getFileSystemManager && wx.getFileSystemManager(); } catch (e) { fs = null; }

  if (!fs || !fs.writeFileSync) {
    fallbackToClipboard(text);
    log('warn', 'NO_FS', '当前环境不支持文件写入，已降级为剪贴板导出');
    return Promise.resolve({ channel: 'clipboard', reason: 'no-fs', bytes: size, attempts: 0, warnings: warnings });
  }

  const dir = (wx.env && wx.env.USER_DATA_PATH) ? wx.env.USER_DATA_PATH : '';
  const filePath = dir + '/' + fileName();
  const w = writeFileWithRetry(fs, filePath, text, tries);
  if (!w.ok) {
    fallbackToClipboard(text);
    log('error', 'EXPORT_WRITE_FAILED', '连续 ' + tries + ' 次写入失败，已降级为剪贴板');
    warnings.push('文件写入失败（已重试 ' + tries + ' 次），已改用剪贴板导出');
    return Promise.resolve({ channel: 'clipboard', reason: 'write-failed', bytes: size, attempts: w.attempts, warnings: warnings });
  }

  return new Promise((resolve) => {
    if (!wx.shareFileMessage) {
      fallbackToClipboard(text);
      log('warn', 'SHARE_UNSUPPORTED', '当前环境不支持直接发文件，已降级为剪贴板');
      resolve({ channel: 'clipboard', reason: 'unsupported', path: filePath, bytes: size, attempts: w.attempts, warnings: warnings });
      return;
    }
    wx.shareFileMessage({
      filePath: filePath,
      fileName: fileName(),
      success: () => {
        log('info', 'EXPORT_OK', '导出成功：' + text.length + ' 字符');
        resolve({ channel: 'wechat', path: filePath, bytes: size, attempts: w.attempts, warnings: warnings });
      },
      fail: (err) => {
        log('warn', 'SHARE_FAILED', '分享失败，已降级为剪贴板：' + (err && err.errMsg));
        fallbackToClipboard(text);
        resolve({ channel: 'clipboard', reason: 'share-failed', path: filePath, bytes: size, attempts: w.attempts, warnings: warnings });
      }
    });
  });
}

// ==================== 恢复：从聊天文件 / 剪贴板 ====================
function importFromFile() {
  return new Promise((resolve, reject) => {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) { reject(new Error('未选择文件')); return; }
        let fs = null;
        try { fs = wx.getFileSystemManager(); } catch (e) { fs = null; }
        if (!fs || !fs.readFileSync) { reject(new Error('当前环境无法读取文件')); return; }
        let raw;
        try {
          raw = fs.readFileSync(file.path, 'utf8');
        } catch (e) {
          log('error', 'READ_FAILED', '文件读取失败：' + (e && e.message));
          reject(new Error('文件读取失败，请确认文件未损坏'));
          return;
        }
        try { resolve(importSnapshotText(raw)); }
        catch (e) { reject(e); }
      },
      fail: () => reject(new Error('已取消'))
    });
  });
}

function importFromClipboard() {
  return new Promise((resolve, reject) => {
    wx.getClipboardData({
      success: (res) => {
        try { resolve(importSnapshotText(res.data)); }
        catch (e) { reject(e); }
      },
      fail: () => reject(new Error('剪贴板读取失败'))
    });
  });
}

// ==================== 降级通道 ====================
function fallbackToClipboard(text) {
  wx.setClipboardData({
    data: text,
    success: () => {
      wx.showModal({
        title: '已复制到剪贴板',
        content: '当前环境不支持直接发文件。请粘贴到微信「文件传输助手」保存，恢复时在下方选「从剪贴板恢复」。',
        showCancel: false
      });
    },
    fail: () => wx.showToast({ title: '导出失败', icon: 'none' })
  });
}

function copyToClipboard() {
  let text;
  try { text = snapshotToText(); }
  catch (e) {
    wx.showToast({ title: '导出失败', icon: 'none' });
    return;
  }
  wx.setClipboardData({
    data: text,
    success: () => {
      wx.showModal({
        title: '已复制',
        content: '粘贴到微信「文件传输助手」即可存档。恢复时用「从剪贴板恢复」。',
        showCancel: false
      });
    },
    fail: () => wx.showToast({ title: '复制失败', icon: 'none' })
  });
}

// ==================== 人可读进度速览 ====================
function buildReadableSummary() {
  const books = storage.list('books');
  const reads = storage.list('bookRead');
  const skills = storage.list('skills');
  const d = new Date();
  const pad = n => (n < 10 ? '0' + n : '' + n);
  const lines = [];
  lines.push('宝哥工作台 · 进度速览');
  lines.push(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
  lines.push('');
  lines.push('【在读 ' + books.length + ' 本】');
  books.forEach(b => {
    const pr = util.progressOf(b);
    lines.push('  · ' + b.title + '  ' + util.progressDesc(b) + '  ' + (pr.total ? pr.percent + '%' : ''));
  });
  lines.push('');
  lines.push('【已读 ' + reads.length + ' 本】');
  reads.slice(0, 20).forEach(b => lines.push('  · ' + b.title));
  if (reads.length > 20) lines.push('  …… 另有 ' + (reads.length - 20) + ' 本');
  lines.push('');
  lines.push('【在学技能 ' + skills.length + ' 项】');
  skills.forEach(s => {
    const stages = s.stages || [];
    const done = stages.filter(x => x.done).length;
    const next = stages.find(x => !x.done);
    lines.push('  · ' + s.name + '  ' + done + '/' + stages.length + ' 阶段' + (next ? '  下一步：' + next.name : '  已达成'));
  });
  return lines.join('\n');
}

module.exports = {
  SNAPSHOT_VERSION: SNAPSHOT_VERSION,
  DATA_KEYS: DATA_KEYS,
  buildSnapshot: buildSnapshot,
  snapshotToText: snapshotToText,
  parseSnapshotText: parseSnapshotText,
  applySnapshot: applySnapshot,
  applySnapshotObject: applySnapshotObject,
  importSnapshotText: importSnapshotText,
  exportAndShare: exportAndShare,
  copyToClipboard: copyToClipboard,
  writeFileWithRetry: writeFileWithRetry,
  importFromFile: importFromFile,
  importFromClipboard: importFromClipboard,
  buildReadableSummary: buildReadableSummary,
  LARGE_SNAPSHOT_BYTES: LARGE_SNAPSHOT_BYTES,
  bytesOf: bytesOf,
  humanSize: humanSize,
  getLog: getLog,
  getRecentLog: getRecentLog,
  clearLog: clearLog
};
