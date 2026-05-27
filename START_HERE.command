#!/bin/zsh
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js，再重新双击这个文件。"
  echo
  read "?按回车关闭窗口..."
  exit 1
fi

if [ -f dist/tools/yolo-wizard.js ]; then
  node dist/tools/yolo-wizard.js
else
  node --import tsx tools/yolo-wizard.ts
fi

echo
read "?按回车关闭窗口..."
