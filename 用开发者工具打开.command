#!/bin/zsh
# 用微信开发者工具打开「宝哥工作台」
# 双击即可。若提示「服务端口已关闭」，按提示到 设置 → 安全设置 打开一次即可长期生效。

DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ="${DIR}/baoge-workbench"
CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"

if [ ! -d "${PROJ}" ]; then
  echo "✗ 找不到项目目录：${PROJ}"
  echo "  请确认本脚本与 baoge-workbench 文件夹在同一层。"
  read -r "?按回车键退出…"; exit 1
fi

if [ ! -f "${CLI}" ]; then
  echo "✗ 未找到微信开发者工具：${CLI}"
  echo "  请先安装开发者工具，或手动打开后「导入项目」选择："
  echo "  ${PROJ}"
  read -r "?按回车键退出…"; exit 1
fi

echo "正在打开：${PROJ}"
OUT=$("${CLI}" open --project "${PROJ}" 2>&1)
echo "${OUT}"

if echo "${OUT}" | grep -q "服务端口"; then
  echo ""
  echo "────────────────────────────────────────"
  echo "工具的服务端口没开，两条路任选其一："
  echo ""
  echo "  A. 手动导入（最快）"
  echo "     开发者工具 → 导入项目 → 选择下面这个目录"
  echo "     ${PROJ}"
  echo ""
  echo "  B. 开一次服务端口（以后本脚本可一键打开）"
  echo "     开发者工具 → 设置 → 安全设置 → 服务端口：开启"
  echo "     然后重新双击本脚本"
  echo "────────────────────────────────────────"
  open -R "${PROJ}"
  read -r "?按回车键退出…"
fi
