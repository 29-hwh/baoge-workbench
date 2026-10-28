// utils/color.js
// 书脊配色工具：按已有书数量轮换分配

const PALETTE = [
  '#378ADD', '#1D9E75', '#D85A30', '#534AB7',
  '#D4537E', '#BA7517', '#E24B4A', '#0F6E56',
  '#185FA5', '#993556', '#3B6D11', '#0F6E56'
];

function pickFor(existingCount) {
  return PALETTE[existingCount % PALETTE.length];
}

function pickManual(seed) {
  // 手动选择：按一个字符串 hash 选
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

module.exports = { PALETTE, pickFor, pickManual };