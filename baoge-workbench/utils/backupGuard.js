// utils/backupGuard.js
// 宝哥工作台 · 导入导出 容错校验层
//
// 职责：把脏备份挡在存储之外，并保证单条脏数据不影响整批导入。
// 设计原则：
//   1. 能修就修（_id 缺失/重复、可纠正的类型与非法值）——修完照常导入并记入报告
//   2. 修不了才跳过（元素不是对象、空对象）——跳过但整批继续
//   3. 绝不臆造业务语义：可选字段缺失只告警，不填默认值
//
// 与 backup.js 分工：本模块只做「校验 + 清洗 + 报告」，不碰存储、不碰 UI。

'use strict';

// ==================== 基础类型判定 ====================
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string';
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isBool = v => typeof v === 'boolean';
const isArr = Array.isArray;
const isDateISO = v => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTs = v => isNum(v) && v > 0;

// 各类型的判定函数表（供字段规格引用）
const TYPES = {
  string: isStr,
  number: isNum,
  boolean: isBool,
  array: isArr,
  object: isObj,
  date: isDateISO,
  timestamp: isTs
};

// ==================== 字段规格（按业务真实形状定义） ====================
// type 期望类型 | required 必须存在 | enum 允许值 | min/max 数值范围
// def 非法值时的纠正值（无 def 则仅告警并保留原值）| nullable 允许 null
// allowEmpty 允许空串 | itemType 数组元素类型（不符的元素会被剔除）
function S(type, opt) { return Object.assign({ type: type }, opt || {}); }

const COMMON = {
  _id: S('string', { required: true }),
  createdAt: S('timestamp')
};

const SPECS = {
  books: Object.assign({}, COMMON, {
    title: S('string', { required: true, def: '未命名' }),
    author: S('string', { def: '' }),
    progressType: S('string', { enum: ['chapter', 'page', 'percent'], def: 'percent' }),
    status: S('string', { def: 'reading' }),
    startDate: S('date', { allowEmpty: true, def: '' }),
    deadline: S('date', { allowEmpty: true, nullable: true, def: '' }),
    color: S('string', { def: '#534AB7' }),
    autoTodo: S('boolean', { def: false }),
    records: S('array', { def: [], itemType: 'object' }),
    totalChapters: S('number', { min: 0 }),
    currentChapter: S('number', { min: 0 }),
    totalPages: S('number', { min: 0 }),
    currentPage: S('number', { min: 0 }),
    progressPercent: S('number', { min: 0, max: 100, def: 0 })
  }),

  bookRead: Object.assign({}, COMMON, {
    title: S('string', { required: true, def: '未命名' }),
    author: S('string', { def: '' }),
    progressType: S('string', { enum: ['chapter', 'page', 'percent'], def: 'percent' }),
    status: S('string', { def: 'reading' }),
    startDate: S('date', { allowEmpty: true, def: '' }),
    color: S('string', { def: '#534AB7' }),
    records: S('array', { def: [], itemType: 'object' }),
    finishedAt: S('timestamp', { nullable: true }),
    finishedDate: S('date', { allowEmpty: true, def: '' }),
    tags: S('array', { def: [] }),
    review: S('string', { def: '' }),
    rating: S('number', { min: 1, max: 5, nullable: true, def: null }),
    progressPercent: S('number', { min: 0, max: 100, def: 100 })
  }),

  skills: Object.assign({}, COMMON, {
    name: S('string', { required: true, def: '未命名技能' }),
    goal: S('string', { def: '' }),
    icon: S('string', { def: '' }),
    cycleDays: S('number', { min: 1, def: 21 }),
    color: S('string', { def: '#534AB7' }),
    status: S('string', { enum: ['learning', 'achieved'], def: 'learning' }),
    stages: S('array', { def: [], itemType: 'object' }),
    records: S('array', { def: [], itemType: 'object' }),
    achievedAt: S('timestamp', { nullable: true })
  }),

  skillAchieved: Object.assign({}, COMMON, {
    name: S('string', { required: true, def: '未命名技能' }),
    goal: S('string', { def: '' }),
    icon: S('string', { def: '' }),
    cycleDays: S('number', { min: 1, def: 21 }),
    color: S('string', { def: '#534AB7' }),
    status: S('string', { enum: ['learning', 'achieved'], def: 'achieved' }),
    stages: S('array', { def: [], itemType: 'object' }),
    achievedAt: S('timestamp', { nullable: true })
  }),

  workouts: Object.assign({}, COMMON, {
    name: S('string', { required: true, def: '未命名训练' }),
    plan: S('string', { def: 'custom' }),
    date: S('date', { allowEmpty: true, def: '' }),
    cycleDays: S('number', { min: 1, def: 7 }),
    items: S('array', { def: [], itemType: 'object' }),
    completed: S('boolean', { def: false }),
    completedAt: S('timestamp', { nullable: true }),
    startedAt: S('timestamp', { nullable: true }),
    volume: S('number', { min: 0, def: 0 }),
    minutes: S('number', { min: 0 })
  }),

  body: Object.assign({}, COMMON, {
    date: S('date', { required: true, def: '' }),
    weight: S('number', { min: 1, max: 500 }),
    fat: S('number', { min: 0, max: 100, nullable: true })
  }),

  todos: Object.assign({}, COMMON, {
    title: S('string', { required: true, def: '未命名待办' }),
    desc: S('string', { def: '' }),
    date: S('date', { required: true, def: '' }),
    source: S('string', { enum: ['manual', 'reading', 'fitness'], def: 'manual' }),
    sourceKey: S('string', { nullable: true, def: null }),
    sourcePlanId: S('string', { nullable: true, def: null }),
    done: S('boolean', { def: false }),
    completedAt: S('timestamp', { nullable: true }),
    important: S('boolean', { def: false }),
    planned: S('boolean', { def: false })
  }),

  countdown: Object.assign({}, COMMON, {
    name: S('string', { required: true, def: '未命名' }),
    date: S('date', { required: true, def: '' }),
    annual: S('boolean', { def: false }),
    cdType: S('string', { enum: ['solar', 'lunar'], def: 'solar' }),
    desc: S('string', { def: '' })
  }),

  templates: Object.assign({}, COMMON, {
    name: S('string', { required: true, def: '未命名模板' }),
    items: S('array', { def: [], itemType: 'object' })
  })
};

// ==================== 工具 ====================
function typeName(v) {
  if (v === null) return 'null';
  if (v === undefined) return '未定义';
  if (Array.isArray(v)) return '数组';
  if (typeof v === 'object') return '对象';
  if (typeof v === 'number') return '数字';
  if (typeof v === 'boolean') return '布尔';
  if (typeof v === 'string') return '字符串';
  return typeof v;
}

// 与 storage.genId 同格式，保证 id 风格一致
function genId() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// FNV-1a 校验和：用于验证导出文本/文件是否被截断或篡改
function checksum(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

// 安全纠正：能纠正返回值，不能纠正返回 undefined
function coerce(sp, v) {
  if (sp.type === 'string') {
    if (isNum(v) || isBool(v)) return String(v);
    return undefined;
  }
  if (sp.type === 'number') {
    if (isStr(v) && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    if (isBool(v)) return v ? 1 : 0;
    return undefined;
  }
  if (sp.type === 'boolean') return !!v;
  if (sp.type === 'timestamp') {
    if (isStr(v)) { const n = Number(v); if (Number.isFinite(n) && n > 0) return n; }
    return undefined;
  }
  return undefined;
}

// ==================== 单条记录校验 / 清洗 ====================
// 返回 { action:'pass'|'repair'|'skip', value, issues, changed }
function sanitizeRecord(key, rec, idx, seenIds) {
  const spec = SPECS[key] || {};
  const issues = [];
  const at = '第 ' + (idx + 1) + ' 条';
  const tag = key + ' ' + at;

  // 元素本身不是对象 -> 无法理解，跳过（整批继续）
  if (!isObj(rec)) {
    return {
      action: 'skip', value: null, changed: false,
      issues: [{ index: idx, field: '<record>', code: 'NOT_OBJECT', action: 'skip', msg: tag + '不是对象（' + typeName(rec) + '），已跳过' }]
    };
  }

  const out = {};
  Object.keys(rec).forEach(f => { out[f] = rec[f]; });
  let changed = false;

  // _id：缺失/非法 -> 生成；同列表内重复 -> 重新生成
  // 注意：跨列表同 _id 是设计行为（完本书 books<->bookRead、技能 skills<->skillAchieved），只查本列表
  if (!isStr(out._id) || out._id === '') {
    out._id = genId(); changed = true;
    issues.push({ index: idx, field: '_id', code: 'ID_INVALID', action: 'repair', msg: tag + ' _id 缺失或非法，已自动生成' });
  } else if (seenIds.has(out._id)) {
    out._id = genId(); changed = true;
    issues.push({ index: idx, field: '_id', code: 'ID_DUPLICATE', action: 'repair', msg: tag + ' _id 与前面重复，已重新生成' });
  }
  seenIds.add(out._id);

  // 逐字段校验
  Object.keys(spec).forEach(f => {
    if (f === '_id') return;
    const sp = spec[f];
    if (!Object.prototype.hasOwnProperty.call(out, f)) {
      // 字段缺失：只告警，绝不臆造业务默认值（避免污染真实数据）
      if (sp.required) {
        issues.push({ index: idx, field: f, code: 'MISSING_REQUIRED', action: 'warn', msg: tag + '缺少必填字段「' + f + '」' });
      }
      return;
    }
    const v = out[f];

    if (v === null || v === undefined) {
      if (!sp.nullable) {
        if ('def' in sp) {
          out[f] = sp.def; changed = true;
          issues.push({ index: idx, field: f, code: 'NULL_NOT_ALLOWED', action: 'repair', msg: tag + '「' + f + '」为空，已置为默认值' });
        } else {
          issues.push({ index: idx, field: f, code: 'NULL_NOT_ALLOWED', action: 'warn', msg: tag + '「' + f + '」为空' });
        }
      }
      return;
    }

    if (sp.allowEmpty && v === '') return;

    const t = TYPES[sp.type];
    if (t && !t(v)) {
      const fixed = coerce(sp, v);
      const target = fixed !== undefined ? fixed : ('def' in sp ? sp.def : undefined);
      if (target !== undefined) {
        out[f] = target; changed = true;
        issues.push({ index: idx, field: f, code: 'TYPE_INVALID', action: 'repair', msg: tag + '「' + f + '」应为' + sp.type + '（实际' + typeName(v) + '），已纠正' });
      } else {
        issues.push({ index: idx, field: f, code: 'TYPE_INVALID', action: 'warn', msg: tag + '「' + f + '」应为' + sp.type + '（实际' + typeName(v) + '），无法自动纠正' });
      }
      return;
    }

    if (sp.enum && sp.enum.indexOf(v) < 0) {
      if ('def' in sp) {
        out[f] = sp.def; changed = true;
        issues.push({ index: idx, field: f, code: 'ENUM_INVALID', action: 'repair', msg: tag + '「' + f + '」取值「' + v + '」不在允许范围，已置为「' + sp.def + '」' });
      } else {
        issues.push({ index: idx, field: f, code: 'ENUM_INVALID', action: 'warn', msg: tag + '「' + f + '」取值「' + v + '」不在允许范围' });
      }
      return;
    }

    if (sp.type === 'number' && isNum(v)) {
      let nv = v;
      if (sp.min !== undefined && nv < sp.min) nv = sp.min;
      if (sp.max !== undefined && nv > sp.max) nv = sp.max;
      if (nv !== v) {
        out[f] = nv; changed = true;
        issues.push({ index: idx, field: f, code: 'OUT_OF_RANGE', action: 'repair', msg: tag + '「' + f + '」=' + v + ' 超出范围，已收敛为 ' + nv });
      }
    }

    if (sp.type === 'array' && sp.itemType === 'object' && isArr(out[f])) {
      const arr = out[f];
      const bad = arr.filter(x => !isObj(x)).length;
      if (bad > 0) {
        out[f] = arr.filter(x => isObj(x)); changed = true;
        issues.push({ index: idx, field: f, code: 'ARRAY_ITEM_INVALID', action: 'repair', msg: tag + '「' + f + '」含 ' + bad + ' 个非对象元素，已剔除' });
      }
    }
  });

  const action = changed ? 'repair' : 'pass';
  return { action: action, value: out, changed: changed, issues: issues };
}

// ==================== 整表清洗 ====================
// 返回 { list, skipped, repaired, issues } —— 单条异常只影响自己，整批继续
function sanitizeList(key, arr) {
  const seen = new Set();
  const list = [];
  const issues = [];
  let skipped = 0, repaired = 0;
  arr.forEach((rec, i) => {
    const r = sanitizeRecord(key, rec, i, seen);
    r.issues.forEach(x => issues.push(x));
    if (r.action === 'skip') { skipped++; return; }
    if (r.changed) repaired++;
    list.push(r.value);
  });
  return { list: list, skipped: skipped, repaired: repaired, issues: issues };
}

// ==================== 快照外形校验（文件级，失败即整体拒绝） ====================
// 返回 { ok, errors, warnings, data }
function validateSnapshotShape(snapshot, opts) {
  const o = opts || {};
  const errors = [];
  const warnings = [];
  const expectApp = o.app || 'baoge-workbench';

  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    errors.push({ code: 'NOT_OBJECT', msg: '备份内容不是一个有效的 JSON 对象' });
    return { ok: false, errors: errors, warnings: warnings, data: null };
  }
  if (snapshot.app !== expectApp) {
    errors.push({ code: 'APP_MISMATCH', msg: '不是宝哥工作台的备份文件' });
    return { ok: false, errors: errors, warnings: warnings, data: null };
  }
  if (!snapshot.data || typeof snapshot.data !== 'object' || Array.isArray(snapshot.data)) {
    errors.push({ code: 'DATA_MISSING', msg: '备份内容损坏：缺少 data 字段' });
    return { ok: false, errors: errors, warnings: warnings, data: null };
  }
  if (typeof snapshot.version === 'number' && o.version && snapshot.version > o.version) {
    warnings.push({ code: 'VERSION_NEWER', msg: '备份版本 ' + snapshot.version + ' 高于当前程序支持的 ' + o.version + '，可能含无法识别的字段' });
  }
  return { ok: true, errors: errors, warnings: warnings, data: snapshot.data };
}

// 校验和比对：验证快照数据是否被截断/篡改（无 checksum 字段的老备份直接放行）
function verifyChecksum(snapshot) {
  if (!snapshot || typeof snapshot.checksum !== 'string') return { ok: true, skipped: true };
  const actual = checksum(JSON.stringify(snapshot.data));
  return { ok: actual === snapshot.checksum, expected: snapshot.checksum, actual: actual, skipped: false };
}

module.exports = {
  TYPES: TYPES,
  SPECS: SPECS,
  isObj: isObj, isStr: isStr, isNum: isNum, isBool: isBool, isArr: isArr,
  isDateISO: isDateISO, isTs: isTs,
  typeName: typeName, genId: genId, checksum: checksum, coerce: coerce,
  sanitizeRecord: sanitizeRecord,
  sanitizeList: sanitizeList,
  validateSnapshotShape: validateSnapshotShape,
  verifyChecksum: verifyChecksum
};
