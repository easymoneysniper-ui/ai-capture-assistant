@echo off
chcp 65001 >nul
title AI 截屏录屏助手 - 本地启动
setlocal
cd /d "%~dp0"

echo ============================================
echo   AI 截屏录屏助手 - 一键启动
echo ============================================
echo.

set "PORT=8787"
set "PAGE=ai-capture-assistant.html"

REM ---- 端口选择：被别的程序占用时自动换端口，避免把别人的页面当成自己的 ----
call :isOurs %PORT%
if "%OURS%"=="1" goto :open
call :isFree %PORT%
if "%FREE%"=="1" goto :start
echo [提示] 端口 %PORT% 已被其它程序占用，改用 8792 ...
set "PORT=8792"
call :isFree 8792
if "%FREE%"=="1" goto :start
echo [提示] 8792 也被占用，改用 8793 ...
set "PORT=8793"
call :isFree 8793
if "%FREE%"=="1" goto :start
echo [错误] 8787 / 8792 / 8793 都被占用，请先关闭占用端口的程序后重试。
pause
exit /b 1

:start
REM 注意：where python 会命中 Microsoft Store 的占位程序（python.exe 根本不是解释器），
REM 所以必须真正执行一次 --version，只有退出码为 0 才算可用。
set "PYCMD="
python --version >nul 2>&1
if %errorlevel%==0 set "PYCMD=python"
if not defined PYCMD (
    py -3 --version >nul 2>&1
    if %errorlevel%==0 set "PYCMD=py -3"
)
if defined PYCMD (
    echo [1/2] 使用 %PYCMD% 启动本地服务，端口 %PORT%
    start "AI Capture Server (%PORT%)" cmd /k "chcp 65001>nul && cd /d "%~dp0" && %PYCMD% -m http.server %PORT% --bind 127.0.0.1"
    goto :waitup
)
node --version >nul 2>&1
if %errorlevel%==0 (
    REM 不依赖 npx 联网下载：优先用本目录自带的零依赖服务脚本，
    REM 断网、npm 缓存被占用、代理受限时都能正常启动。
    if exist "%~dp0serve.js" (
        echo [1/2] 使用 Node 启动本地服务，端口 %PORT%
        start "AI Capture Server (%PORT%)" cmd /k "chcp 65001>nul && cd /d "%~dp0" && node "%~dp0serve.js" %PORT% 127.0.0.1"
        goto :waitup
    )
    echo [提示] 未找到 serve.js，回退到 npx（需联网下载，首次较慢）
    start "AI Capture Server (%PORT%)" cmd /k "chcp 65001>nul && cd /d "%~dp0" && npx --yes http-server -p %PORT% -a 127.0.0.1 -c-1"
    goto :waitup
)
echo [错误] 未检测到可用的 Python 或 Node.js，无法自动启动本地服务。
echo.
echo 若你「装了 Python 却仍报此错」：从应用商店装的 python.exe 只是占位程序，
echo 无法真正运行 http.server。请到 python.org 安装正式版，并在安装时勾选
echo "Add python.exe to PATH"，然后重新运行本脚本。
echo.
echo 也可自行用任意静态服务器托管本目录后访问；截图/录屏必须在
echo http://localhost 或 https 下才可用。
pause
exit /b 1

:waitup
echo [2/2] 等待服务就绪...
REM 服务启动需要一点时间，轮询确认页面能取到再开浏览器（最多等约 15 秒）
set /a TRIES=0
:ping
call :isOurs %PORT%
if "%OURS%"=="1" goto :open
set /a TRIES+=1
if %TRIES% GEQ 15 (
    echo [提示] 服务未在预期时间内响应，仍尝试打开页面。
    goto :open
)
timeout /t 1 >nul
goto :ping

:open
set "URL=http://127.0.0.1:%PORT%/%PAGE%"
echo.
echo 正在打开浏览器：%URL%
start "" "%URL%"

echo.
echo 已启动。如浏览器未自动打开，请手动访问上面的地址。
echo 关闭此窗口不会中断服务；如需停止服务，
echo 请关闭弹出的名为 "AI Capture Server" 的命令行窗口。
echo.
echo 按任意键关闭本窗口（服务仍会继续运行）...
pause >nul
exit /b 0

REM ---- 子过程：端口上是否已有本工具的页面（能取到本页就是） ----
:isOurs
set "OURS=0"
powershell -NoProfile -Command "try{ $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%~1/%PAGE%'; if($r.StatusCode -eq 200){exit 0} else {exit 1} } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 set "OURS=1"
exit /b 0

REM ---- 子过程：端口是否空闲 ----
:isFree
set "FREE=0"
netstat -ano | findstr ":%~1 " | findstr "LISTENING" >nul 2>&1
if not %errorlevel%==0 set "FREE=1"
exit /b 0
