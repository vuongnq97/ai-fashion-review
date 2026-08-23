@echo off
setlocal enabledelayedexpansion
title AI Fashion Review Server

cd /d "%~dp0playwright-service"
if not exist "server.js" (
    cd /d "%~dp0\playwright-service"
)

if not exist "server.js" (
    echo [X] Khong tim thay server.js trong thu muc playwright-service!
    echo     Thu muc hien tai: %CD%
    pause
    exit /b 1
)

where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;!PATH!"
    ) else (
        echo [X] Chua tim thay Node.js. Vui long chay file setup.bat truoc nhe!
        pause
        exit /b 1
    )
)

echo [*] Dang khoi dong AI Fashion Review Server...
node server.js

echo.
echo [!] Server da dung. Nhan phim bat ky de dong cua so...
pause
