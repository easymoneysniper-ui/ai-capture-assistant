@echo off
REM ===============================================================
REM  AI Screenshot Helper - Global Hotkey Launcher
REM  This file is ASCII-only on purpose: cmd.exe reads .bat using the
REM  system ANSI codepage (GBK on Chinese Windows), so non-ASCII text
REM  here can be split into garbage commands.
REM ===============================================================
setlocal
cd /d "%~dp0"

title AI Screenshot Helper - Global Hotkey

echo ============================================
echo   AI Screenshot Helper
echo ============================================
echo.
echo   Hotkey : Ctrl+Alt+S   (works in any window)
echo   Tray   : right-click the icon for menu
echo.

if not exist "%~dp0hotkey.ps1" (
    echo [ERROR] hotkey.ps1 not found in this folder.
    pause
    exit /b 1
)

where pwsh >nul 2>nul
if %errorlevel%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0hotkey.ps1"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0hotkey.ps1"
)

set RC=%errorlevel%
echo.
echo [INFO] Helper exited with code %RC%
pause
