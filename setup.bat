@echo off
chcp 65001 >nul
title AI Fashion Review - Setup

echo ============================================================
echo   [AI Fashion Review] SETUP TỰ ĐỘNG CHO WINDOWS
echo ============================================================
echo.

cd /d "%~dp0playwright-service"

:: 1. Kiểm tra Node.js
where node >nul 2>nul
if %errorlevel% equ 0 goto :node_ok

if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%PATH%"
    goto :node_ok
)

if exist "%LocalAppData%\Programs\nodejs\node.exe" (
    set "PATH=%LocalAppData%\Programs\nodejs;%PATH%"
    goto :node_ok
)

echo [!] Máy của bạn chưa cài đặt Node.js.
echo [*] Vui lòng tải và cài đặt Node.js tại: https://nodejs.org/ (Khuyến nghị bản v20 LTS)
echo     Sau khi cài đặt xong, hãy mở lại file setup.bat này nhé!
echo.
pause
exit /b 1

:node_ok
echo [OK] Đã tìm thấy Node.js:
node -v
echo.

:: 2. Chạy setup.js (tạo thư mục, cài dependencies, cài Playwright Chromium, cấu hình .env, đăng nhập Google)
echo [*] Đang khởi chạy quá trình thiết lập tự động...
echo.
node setup.js

if %errorlevel% neq 0 (
    echo.
    echo ============================================================
    echo [!] Quá trình setup gặp lỗi (exit code %errorlevel%).
    echo ============================================================
    pause
    exit /b %errorlevel%
)

echo.
echo ============================================================
echo [OK] Setup hoàn tất thành công!
echo      Bạn có thể khởi động server bằng file start.bat
echo ============================================================
echo.
set /p START_NOW="Bạn có muốn khởi động server ngay bây giờ không? (y/n, mặc định y): "
if /i "%START_NOW%"=="n" goto :done

echo.
echo [*] Đang khởi động server...
cd /d "%~dp0"
call start.bat

:done
pause
