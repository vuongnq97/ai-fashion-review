@echo off
setlocal enabledelayedexpansion
title AI Fashion Review - Windows 1-Click Setup

echo ============================================================
echo  [AI Fashion Review] SETUP TU DONG CHO WINDOWS
echo ============================================================
echo.

:: 1. Kiem tra Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] May cua ban chua co Node.js.
    echo [*] Dang tu dong tai va cai dat Node.js v20 LTS cho Windows...
    
    set "NODE_MSI=%TEMP%\nodejs_installer.msi"
    powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi', '%NODE_MSI%')"
    
    if exist "%NODE_MSI%" (
        echo [*] Dang cai dat Node.js v20 (Silent Install)...
        msiexec.exe /i "%NODE_MSI%" /qn /norestart
        del "%NODE_MSI%"
        
        :: Cap nhat PATH tam thoi cho session CMD hien tai
        set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%PATH%"
        echo [OK] Da cai dat Node.js thanh cong!
    ) else (
        echo [X] Khong the tai bo cai Node.js. Vui long tai thu cong tai https://nodejs.org/
        pause
        exit /b 1
    )
)

:: Kiem tra lai Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] Vui long khoi dong lai Command Prompt de nhan dien Node.js va chay lai setup.bat.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
for /f "tokens=*" %%v in ('npm -v') do set NPM_VER=%%v
echo [OK] Node.js version: %NODE_VER%
echo [OK] npm version: %NPM_VER%
echo.

:: 2. Chuyen vao thu muc playwright-service va chay setup.js
cd /d "%~dp0\playwright-service"
node setup.js

pause
