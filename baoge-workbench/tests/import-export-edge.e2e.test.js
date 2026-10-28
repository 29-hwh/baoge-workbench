/* 宝哥工作台 · 导入导出 边界往返测试（spec-aware） */
/* 目标：验证 导出->文件->导入->再导出 对【合法数据】完全无损（逐字段、类型敏感）。
   脏数据的修复/跳过行为由 backup-fault-tolerance.test.js 覆盖。 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.resolve(__dirname, '..');
const U = p => path.join(ROOT, p);

const store = {};
const wx = {
  env: { USER_DATA_PATH: os.tmpdir() },
  getStorageSync(k) { return store[k]; },
  setStorageSync(k, v) { store[k] = v; },
  removeStorageSync(k) { delete store[k]; },
  showToast() {}, showModal() {}, setClipboardData() {}, getClipboardData() {}
};
global.wx = wx;
global.getApp = () => ({ globalData: { cloudSync: false } });

const storage = require(U('utils/storage'));
const backup = require(U('utils/backup'));
const guard = require(U('utils/backupGuard'));

let passCount = 0, failCount = 0, leafCount = 0;
function rec(s) { console.log('  ' + s); }
function ok(c, m) {
  if (c) { passCount++; rec('  [ok] ' + m); return true; }
  failCount++; console.error('  [X] ' + m); return false;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pad = n => (n < 10 ? '0' + n : '' + n);
function hex(rng, n) { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(rng() * 16).toString(16); return s; }

const SPECIALS = [
  '双引号"测试',
  '反斜杠' + String.fromCharCode(92) + '测试',
  '换行\n制表\t',
  'emoji😀🎬📷',
  '控制符\u0000\u001f尾',
  '前后空格   ',
  'json结构{}[],:',
  '阿拉伯 rtl'
];
function longStr(rng) {
  const len = 1 + Math.floor(rng() * 20000);
  const pool = '中文字符abc汉字摄影📷0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += pool[Math.floor(rng() * pool.length)];
  return s;
}

// 任意合法 JSON（用于「规格外的自由字段」：校验层不认识 -> 必须原样透传）
function edgeAny(rng, d) {
  if (d >= 3) {
    const r = rng();
    if (r < 0.2) return null;
    if (r < 0.4) return '';
    if (r < 0.6) return Math.floor(rng() * 1e9);
    if (r < 0.8) return rng() < 0.5;
    return 'leaf_' + hex(rng, 4);
  }
  const r = rng();
  if (r < 0.12) return null;
  if (r < 0.24) return '';
  if (r < 0.38) return longStr(rng);
  if (r < 0.52) return SPECIALS[Math.floor(rng() * SPECIALS.length)];
  if (r < 0.68) return Math.floor(rng() * 1e9) + rng();
  if (r < 0.78) return rng() < 0.5;
  if (r < 0.9) {
    const a = []; const n = Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) a.push(edgeAny(rng, d + 1));
    return a;
  }
  const o = {}; const n = Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) o['k' + i + '_' + hex(rng, 2)] = edgeAny(rng, d + 1);
  return o;
}

// 生成【符合字段规格】但取值极端的合法值（保证清洗层不改动 -> 可断言完全无损）
function validValue(spec, rng) {
  if (spec.nullable && rng() < 0.15) return null;
  // 有枚举约束的字段必须取枚举值，否则会被清洗层判为非法值并纠正
  if (spec.enum && spec.enum.length) return spec.enum[Math.floor(rng() * spec.enum.length)];
  const t = spec.type;
  if (t === 'string') {
    if (spec.allowEmpty && rng() < 0.2) return '';
    if (rng() < 0.3) return longStr(rng);
    return SPECIALS[Math.floor(rng() * SPECIALS.length)];
  }
  if (t === 'number') {
    const min = spec.min !== undefined ? spec.min : -1e9;
    const max = spec.max !== undefined ? spec.max : 1e9;
    if (rng() < 0.35) {
      const pool = [min, max, 0].filter(v => v >= min && v <= max);
      return pool[Math.floor(rng() * pool.length)];
    }
    return min + rng() * (max - min);
  }
  if (t === 'boolean') return rng() < 0.5;
  if (t === 'date') {
    if (spec.allowEmpty && rng() < 0.15) return '';
    return '20' + (10 + Math.floor(rng() * 20)) + '-' + pad(1 + Math.floor(rng() * 12)) + '-' + pad(1 + Math.floor(rng() * 28));
  }
  if (t === 'timestamp') return Math.floor(rng() * 1e12) + 1;
  if (t === 'array') {
    const n = Math.floor(rng() * 3);
    if (spec.itemType === 'object') {
      const a = [];
      for (let i = 0; i < n; i++) a.push({ name: 'n' + i, done: rng() < 0.5, at: Math.floor(rng() * 1e12) + 1 });
      return a;
    }
    const a = [];
    for (let i = 0; i < n; i++) a.push('tag' + Math.floor(rng() * 1000));
    return a;
  }
  return null;
}

function makeRecord(key, rng) {
  const spec = guard.SPECS[key] || {};
  const rec = {};
  Object.keys(spec).forEach(f => {
    if (f === '_id') { rec._id = 'id_' + hex(rng, 10); return; }
    // 必填必出现；可选随机出现（缺失也应原样保留，不臆造默认值）
    if (spec[f].required || rng() < 0.7) rec[f] = validValue(spec[f], rng);
  });
  const extra = Math.floor(rng() * 4);
  for (let i = 0; i < extra; i++) rec['x_free_' + i] = edgeAny(rng, 0);
  return rec;
}

function buildDataset(rng) {
  const ds = {};
  backup.DATA_KEYS.forEach(k => {
    const n = Math.floor(rng() * 7);
    const a = [];
    for (let i = 0; i < n; i++) a.push(makeRecord(k, rng));
    ds[k] = a;
  });
  return ds;
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }

// ==================== 逐字段深度比对（类型敏感） ====================
function typeTag(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
function short(v) {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { s = String(v); }
  if (s && s.length > 48) s = s.slice(0, 48) + '...(' + s.length + ')';
  return s;
}
function deepDiff(a, b, p, diffs) {
  const ta = typeTag(a), tb = typeTag(b);
  if (ta !== tb) {
    diffs.push({ path: p, kind: 'type', detail: ta + '->' + tb + ' (' + short(a) + '/' + short(b) + ')' });
    leafCount++; return;
  }
  if (ta === 'array') {
    if (a.length !== b.length) { diffs.push({ path: p, kind: 'len', detail: a.length + '->' + b.length }); leafCount++; }
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) deepDiff(a[i], b[i], p + '[' + i + ']', diffs);
    return;
  }
  if (ta === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    const all = new Set([...ka, ...kb]);
    all.forEach(k => {
      const pp = p ? p + '.' + k : k;
      if (!(k in a)) { diffs.push({ path: pp, kind: 'lost', detail: short(a[k]) }); leafCount++; }
      else if (!(k in b)) { diffs.push({ path: pp, kind: 'extra', detail: short(b[k]) }); leafCount++; }
      else deepDiff(a[k], b[k], pp, diffs);
    });
    return;
  }
  leafCount++;
  if (a !== b) diffs.push({ path: p, kind: 'val', detail: short(a) + '->' + short(b) });
}

// ==================== 单轮往返：现场 -> 导出 -> 文件 -> 导入 -> 再导出 ====================
function runRoundTrip(state) {
  backup.DATA_KEYS.forEach(k => storage.set(k, clone(state[k])));
  const t1 = backup.snapshotToText();
  const tmp = path.join(os.tmpdir(), 'baoge_edge_' + process.pid + '_' + Math.floor(Math.random() * 1e9) + '.json');
  fs.writeFileSync(tmp, t1, 'utf8');
  const raw = fs.readFileSync(tmp, 'utf8');
  let applied;
  try { applied = backup.applySnapshot(backup.parseSnapshotText(raw)); }
  finally { try { fs.unlinkSync(tmp); } catch (e) {} }
  if (!applied) throw new Error('applySnapshot empty');
  const t2 = backup.snapshotToText();
  const s2 = JSON.parse(t2);
  const diffs = [];
  backup.DATA_KEYS.forEach(k => {
    deepDiff(state[k], s2.data[k], k, diffs);
    if (s2.counts[k] !== state[k].length) diffs.push({ path: k, kind: 'count', detail: s2.counts[k] + '!=' + state[k].length });
  });
  return diffs;
}
function mutate(state, rng) {
  const k = backup.DATA_KEYS[Math.floor(rng() * backup.DATA_KEYS.length)];
  const op = Math.floor(rng() * 3);
  if (op === 0 || state[k].length === 0) state[k].push(makeRecord(k, rng));
  else if (op === 1) { const i = Math.floor(rng() * state[k].length); state[k][i] = makeRecord(k, rng); }
  else { const i = Math.floor(rng() * state[k].length); state[k].splice(i, 1); }
}

function run() {
  console.log('=== Stage A: spec-valid edge datasets x rounds (lossless) ===');
  const rng = mulberry32(20260918);
  const DATASETS = 12, ROUNDS = 3;
  let total = 0, fail = 0;
  for (let d = 0; d < DATASETS; d++) {
    const state = buildDataset(rng);
    for (let r = 0; r < ROUNDS; r++) {
      if (r > 0) mutate(state, rng);
      total++;
      const diffs = runRoundTrip(state);
      if (diffs.length) {
        fail++;
        rec('dataset#' + d + ' round#' + r + ' X ' + diffs.length + ' diffs');
        diffs.slice(0, 8).forEach(df => rec('   - ' + df.path + ' | ' + df.kind + ' | ' + df.detail));
      } else {
        rec('dataset#' + d + ' round#' + r + ' ok');
      }
    }
  }
  ok(fail === 0, 'Stage A: ' + total + ' rounds fully lossless (fail=' + fail + ', leafCompares=' + leafCount + ')');

  console.log('=== Stage B: BOM / whitespace tolerance ===');
  const rngB = mulberry32(777);
  const stateB = buildDataset(rngB);
  backup.DATA_KEYS.forEach(k => storage.set(k, clone(stateB[k])));
  const tB = backup.snapshotToText();
  const bom = '\uFEFF' + tB;
  let rawThrow = false;
  try { JSON.parse(bom); } catch (e) { rawThrow = true; }
  ok(rawThrow, 'rootcause: bare JSON.parse throws on BOM');
  const apB = backup.applySnapshot(backup.parseSnapshotText(bom));
  ok(!!apB && typeof apB === 'object', 'parseSnapshotText strips BOM, applySnapshot ok');
  const sB2 = JSON.parse(backup.snapshotToText());
  const dB = [];
  backup.DATA_KEYS.forEach(k => deepDiff(stateB[k], sB2.data[k], k, dB));
  ok(dB.length === 0, 'BOM backup restored losslessly (diffs=' + dB.length + ')');
  const ws = '   \n\n' + tB + '\n';
  const apW = backup.applySnapshot(backup.parseSnapshotText(ws));
  ok(!!apW && typeof apW === 'object', 'leading/trailing whitespace tolerated');

  console.log('=== Summary ===');
  rec('pass=' + passCount + ' fail=' + failCount + ' leafCompares=' + leafCount);
  if (failCount === 0) { console.log('PASS: lossless round-trip for spec-valid edge data'); process.exit(0); }
  console.error('FAIL: ' + failCount + ' anomalies');
  process.exit(1);
}
run();
