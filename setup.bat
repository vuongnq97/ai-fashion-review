@echo off
setlocal enabledelayedexpansion
title AI Fashion Review - Windows Setup

echo ============================================================
echo  [AI Fashion Review] SETUP TU DONG CHO WINDOWS
echo ============================================================
echo.

cd /d "%~dp0playwright-service"
if not exist "setup.js" (
    cd /d "%~dp0\playwright-service"
)

if not exist "setup.js" (
    echo [X] Khong tim thay thu muc playwright-service!
    echo     Thu muc hien tai: %CD%
    pause
    exit /b 1
)

:: Kiem tra Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;!PATH!"
    ) else if exist "%LocalAppData%\Programs\nodejs\node.exe" (
        set "PATH=%LocalAppData%\Programs\nodejs;!PATH!"
    ) else (
        echo [!] May cua ban chua cai dat Node.js.
        echo [*] Dang tu dong tai Node.js v20 LTS cho Windows...
        
        set "NODE_MSI=%TEMP%\nodejs_installer.msi"
        powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi', '%NODE_MSI%')"
        
        if exist "%NODE_MSI%" (
            echo [*] Dang cai dat Node.js v20 (Vui long nhan Yes/Agree neu co hop thoai)...
            start /wait msiexec.exe /i "%NODE_MSI%" /passive
            del "%NODE_MSI%" 2>nul
            set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;!PATH!"
        )
    )
)

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo [X] Chua tim thay Node.js. Vui long tai va cai dat Node.js tai: https://nodejs.org/
    echo     Sau khi cai xong, hay mo lai file setup.bat nay nhe!
    echo.
    pause
    exit /b 1
)

echo [OK] Da tim thay Node.js san sang!
echo [*] Dang khoi chay qua trinh cai dat thu vien va cau hinh...
echo.

node setup.js

echo.
echo ============================================================
echo [OK] Hoan tat setup. Nhan phim bat ky de thoat...
echo ============================================================
pause
