@echo off
title AI Fashion Review Setup

echo ============================================================
echo  [AI Fashion Review] SETUP TU DONG CHO WINDOWS (YARN)
echo ============================================================
echo.

cd /d "%~dp0playwright-service"

where node >nul 2>nul
if %errorlevel% equ 0 goto :check_yarn

if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%PATH%"
    goto :check_yarn
)

if exist "%LocalAppData%\Programs\nodejs\node.exe" (
    set "PATH=%LocalAppData%\Programs\nodejs;%PATH%"
    goto :check_yarn
)

echo [!] May cua ban chua cai dat Node.js.
echo [*] Vui long tai va cai dat Node.js tai: https://nodejs.org/ (Ban v20 LTS)
echo     Sau khi cai xong, hay mo lai file setup.bat nay nhe!
echo.
goto :done

:check_yarn
echo [OK] Da tim thay Node.js.

where yarn >nul 2>nul
if %errorlevel% equ 0 goto :run_setup

echo [*] Dang cai dat Yarn package manager...
call npm install -g yarn

:run_setup
echo [*] Dang khoi chay qua trinh cai dat thu vien va cau hinh qua Yarn...
echo.
node setup.js

:done
echo.
echo ============================================================
echo [OK] Hoan tat. Nhan phim bat ky de thoat...
echo ============================================================
pause
