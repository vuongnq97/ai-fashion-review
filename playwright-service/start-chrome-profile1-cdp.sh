#!/bin/bash
CDP_DATA_DIR="$HOME/Library/Application Support/Google/Chrome-CDP"
ORIGINAL_PROFILE="$HOME/Library/Application Support/Google/Chrome/Profile 1"

echo "🚀 Đang kiểm tra cổng 9222..."
if curl -s http://127.0.0.1:9222/json/version | grep -q "webSocketDebuggerUrl"; then
  echo "✅ Chrome CDP đã đang chạy tại port 9222!"
  exit 0
fi

# Tạo thư mục Chrome-CDP riêng (Chrome bắt buộc phải có --user-data-dir riêng mới chịu mở port 9222)
mkdir -p "$CDP_DATA_DIR/Default"

# Nếu thư mục CDP chưa có cookie, đồng bộ nhanh từ Profile 1 sang
if [ ! -f "$CDP_DATA_DIR/Default/Cookies" ] && [ -d "$ORIGINAL_PROFILE" ]; then
  echo "📋 Đang sao chép thông tin đăng nhập từ Profile 1 sang Chrome-CDP..."
  rsync -a --exclude="Singleton*" "$ORIGINAL_PROFILE/" "$CDP_DATA_DIR/Default/"
fi

# Tắt tiến trình Chrome-CDP cũ nếu bị treo
pkill -f "Chrome-CDP" 2>/dev/null
sleep 1

echo "🚀 Đang mở Chrome thật với Profile 1 tại port 9222..."
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --user-data-dir="$CDP_DATA_DIR" \
  --remote-debugging-port=9222 \
  --remote-allow-origins="*" \
  --restore-last-session >/dev/null 2>&1 &

for i in {1..8}; do
  sleep 1
  if curl -s http://127.0.0.1:9222/json/version | grep -q "webSocketDebuggerUrl"; then
    echo ""
    echo "🎉 THÀNH CÔNG: Chrome Profile 1 đã sẵn sàng lắng nghe tại port 9222!"
    exit 0
  fi
done

echo ""
echo "❌ LỖI: Cổng 9222 vẫn chưa mở sau 8 giây."
exit 1

