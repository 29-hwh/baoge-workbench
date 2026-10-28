#!/bin/zsh
# 宝哥工作台 · 桌面版启动器
# 双击本文件即可用 Chrome 的「应用模式」打开工作台（无地址栏、无标签页，像原生 App）
# 若系统提示「无法打开，因为它来自身份不明的开发者」，右键 → 打开 → 打开，一次即可。

DIR="$(cd "$(dirname "$0")" && pwd)"
APP_FILE="${DIR}/宝哥工作台_桌面版.html"

if [ ! -f "${APP_FILE}" ]; then
  echo "✗ 找不到 ${APP_FILE}"
  echo "  请确认本启动器与「宝哥工作台_桌面版.html」在同一个文件夹里。"
  read -r "?按回车键退出…"
  exit 1
fi

CHROME="/Applications/Google Chrome.app"
EDGE="/Applications/Microsoft Edge.app"
BRAVE="/Applications/Brave Browser.app"

if [ -d "${CHROME}" ]; then
  BROWSER="Google Chrome"
elif [ -d "${EDGE}" ]; then
  BROWSER="Microsoft Edge"
elif [ -d "${BRAVE}" ]; then
  BROWSER="Brave Browser"
else
  BROWSER=""
fi

if [ -n "${BROWSER}" ]; then
  # 说明：这里刻意不指定 --user-data-dir。
  # 桌面版的数据存在浏览器 localStorage 里，而 localStorage 是按「浏览器配置」隔离的。
  # 若启动器另开一份配置，直接双击 HTML 打开时会读到空数据 —— 看着就像"数据丢了"。
  # 共用默认配置，才能保证「启动器打开」和「双击 HTML 打开」看到的是同一份数据。
  open -na "${BROWSER}" --args \
    --app="file://${APP_FILE}" \
    --no-first-run \
    --no-default-browser-check \
    --window-size=980,860
else
  # 兜底：交给系统默认浏览器
  open "${APP_FILE}"
fi
