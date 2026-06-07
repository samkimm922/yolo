#!/bin/zsh
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js，再重新双击这个文件。"
  echo
  read "?按回车关闭窗口..."
  exit 1
fi

if [ -f dist/bin/yolo.js ]; then
  node dist/bin/yolo.js status
else
  node --import tsx bin/yolo.ts status
fi

echo
echo "稳定入口: yolo status | demand | spec | tasks | run | check | review | release"
read "?按回车关闭窗口..."
