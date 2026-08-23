#!/usr/bin/env bash
# AI Fashion Review - 1-Click Setup Script for macOS & Linux

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="${SCRIPT_DIR}/playwright-service"

echo "============================================================"
echo "🚀 [AI Fashion Review] Khởi động cài đặt tự động..."
echo "============================================================"

# Kiểm tra Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Lỗi: Node.js chưa được cài đặt trên máy này."
    echo "👉 Vui lòng cài đặt Node.js (phiên bản 18+ hoặc 20+) tại https://nodejs.org/"
    exit 1
fi

# Chạy setup.js
cd "${SERVICE_DIR}"
node setup.js
