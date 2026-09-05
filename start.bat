@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title AI Fashion Review - Server (node server.js)

cd /d "%~dp0playwright-service"

if not exist "server.js" (
    echo [X] Lỗi: Không tìm thấy server.js trong thư mục playwright-service!
    echo     Thư mục hiện tại: %CD%
    pause
    exit /b 1
)

:: Kiểm tra Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;!PATH!"
    ) else if exist "%LocalAppData%\Programs\nodejs\node.exe" (
        set "PATH=%LocalAppData%\Programs\nodejs;!PATH!"
    ) else (
        echo [X] Chưa tìm thấy Node.js trên máy!
        echo     Vui lòng cài Node.js tại https://nodejs.org/ hoặc chạy setup.bat trước.
        pause
        exit /b 1
    )
)

:: Kiểm tra thư mục node_modules
if not exist "node_modules" (
    echo [!] Chưa tìm thấy thư mục node_modules.
    echo [*] Vui lòng chạy setup.bat trước để cài đặt thư viện!
    pause
    exit /b 1
)

:: Kiểm tra file .env
if not exist ".env" (
    if exist ".env.example" (
        copy /y ".env.example" ".env" >nul
        echo [!] Đã tự động tạo file .env từ .env.example.
        echo     Vui lòng kiểm tra và điền TELEGRAM_BOT_TOKEN vào file .env nếu cần!
    )
)

echo ============================================================
echo   [AI Fashion Review] KHỞI ĐỘNG SERVER (node server.js)
echo   Thư mục: %CD%
echo   Node.js: 
node -v
echo ============================================================
echo.

node server.js

echo.
echo ============================================================
echo [!] Server đã dừng. Nhấn phím bất kỳ để đóng cửa sổ...
echo ============================================================
pause
