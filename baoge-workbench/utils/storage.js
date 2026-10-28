// utils/storage.js
// 宝哥工作台 · 统一存储层
//
// 设计要点：
//   1. 单一接口面向业务页面（get / add / update / remove / list）
//   2. 底层默认走 wx.setStorageSync（本地优先，无需任何后端即可运行）
//   3. 当全局 cloudSync=true 时，写操作同步上云（云数据库名称与 key 同名）
//   4. 业务页面完全无需关心当前是本地模式还是云模式

const KEYS = {
  books:        'baoge:books',          // 读书 · 在读书籍
  bookRead:     'baoge:bookRead',       // 读书 · 已读（书脊墙）
  skills:       'baoge:skills',         // 学习 · 技能计划
  skillAchieved:'baoge:skillAchieved',  // 学习 · 已达成（徽章）
  workouts:     'baoge:workouts',       // 健身 · 训练记录
  body:         'baoge:body',           // 健身 · 体重/体脂记录
  todos:        'baoge:todos',          // 待办（date 决定归属哪天）
  countdown:    'baoge:countdown',      // 倒计时（节日/事件）
  templates:    'baoge:templates',      // 健身 · 用户自定义/收藏训练模板
  settings:     'baoge:settings'        // 设置（云同步开关等）
};

function list(key) {
  return wx.getStorageSync(KEYS[key]) || [];
}

function set(key, data) {
  wx.setStorageSync(KEYS[key], data);
}

function genId() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// 异步云同步（失败不影响主流程）
// 注意：wx.cloud.database() 必须在 try 内调用 —— 若用户开了云同步但云环境未初始化/
// 不可用，database() 会同步抛异常；若它在 try 外，会穿透 storage.add 导致「写入成功但
// 后续 UI 收尾（关弹层/刷新/Toast）全部中断」，真机表现为「添加记一笔 / 倒记时都不成功」。
function syncToCloud(key, op, id, data) {
  try {
    const app = getApp();
    if (!app || !app.globalData.cloudSync || !wx.cloud) return;
    const collName = KEYS[key];
    if (!collName) return;
    const db = wx.cloud.database();
    if (op === 'add')    db.collection(collName).add({ data: Object.assign({}, data, { _localId: id }) });
    if (op === 'update') db.collection(collName).where({ _localId: id }).update({ data });
    if (op === 'remove') db.collection(collName).where({ _localId: id }).remove();
  } catch (e) {
    console.warn('[baoge] cloud sync failed (ignored, local data safe)', key, op, e);
  }
}

function add(key, item) {
  if (!item._id) item._id = genId();
  if (!item.createdAt) item.createdAt = Date.now();
  const arr = list(key);
  arr.push(item);
  set(key, arr);
  syncToCloud(key, 'add', item._id, item);
  return item;
}

function update(key, id, patch) {
  const arr = list(key);
  const idx = arr.findIndex(it => it._id === id);
  if (idx < 0) return null;
  arr[idx] = Object.assign({}, arr[idx], patch, { updatedAt: Date.now() });
  set(key, arr);
  syncToCloud(key, 'update', id, patch);
  return arr[idx];
}

function remove(key, id) {
  const arr = list(key);
  const idx = arr.findIndex(it => it._id === id);
  if (idx < 0) return false;
  arr.splice(idx, 1);
  set(key, arr);
  syncToCloud(key, 'remove', id);
  return true;
}

// 业务快捷方法：根据类型过滤列表
function listBy(key, predicate) {
  const arr = list(key);
  return predicate ? arr.filter(predicate) : arr;
}

module.exports = {
  KEYS,
  list,
  listBy,
  add,
  update,
  remove,
  genId,
  set  // 直接覆盖整个列表（如批量同步本地→云时使用）
};