#!/usr/bin/env bash
# AI Fashion Review - 1-Click Setup Script for macOS & Linux

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="${SCRIPT_DIR}/playwright-service"

echo "============================================================"
echo "🚀 [AI Fashion Review] Khởi động cài đặt tự động..."
echo "============================================================"

# Kiểm tra nếu nvm đã có trong hệ thống nhưng chưa nạp vào shell hiện tại
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# 1. Kiểm tra và tự động cài Node.js nếu chưa có
if ! command -v node &> /dev/null; then
    echo "⚠️  Phát hiện máy chưa cài đặt Node.js."
    echo "⏳ Đang tự động tải và cài đặt Node.js v20 (LTS)..."

    if [[ "$OSTYPE" == "darwin"* ]] && command -v brew &> /dev/null; then
        echo "🍺 Cài đặt Node.js qua Homebrew..."
        brew install node@20
        brew link --force --overwrite node@20 || true
    else
        echo "📦 Cài đặt Node.js qua NVM (Node Version Manager)..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        nvm install 20
        nvm use 20
    fi

    if ! command -v node &> /dev/null; then
        echo "❌ Không thể tự động cài Node.js. Vui lòng tải Node.js tại https://nodejs.org/"
        exit 1
    fi
    echo "✅ Đã cài đặt Node.js thành công: $(node -v)"
fi

echo "📦 Node.js phiên bản: $(node -v)"
echo "📦 npm phiên bản: $(npm -v)"

# 2. Chạy setup.js
cd "${SERVICE_DIR}"
node setup.js
