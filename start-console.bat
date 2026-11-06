@echo off
rem ============================================================
rem memu-bench-714 一键启动：宿主(39771) → cookie → 面板(39772) → 浏览器
rem 约束：DSH 路径与本仓库路径均无空格，故子命令里不加引号以免 cmd 嵌套引号问题；
rem       每步都幂等——端口已在监听就直接跳过，可反复双击。
rem ============================================================
chcp 65001 >nul
title Memu Bench 控制台启动器
cd /d "%~dp0"
set "DSH_HOME=%APPDATA%/in.dsh-plug.dsh-launcher/homes/0.2.2-rc.1"
set "DSH_BIN=%APPDATA%/in.dsh-plug.dsh-launcher/versions/0.2.2-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js"
if not exist logs mkdir logs

rem ---- 1) 记忆宿主 :39771 ----
netstat -ano | findstr ":39771" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 goto host_up
echo [宿主] 启动中（端口 39771）...
del /q logs\host.log 2>nul
start "memu-bench-host" /min cmd /c "cd /d %~dp0workspace && node %DSH_BIN% --profile memubench --no-open --port 39771 > ..\logs\host.log 2>&1"
set /a tries=0
:wait_token
ping -n 3 127.0.0.1 >nul
findstr /c:"dsh web" logs\host.log >nul 2>&1
if %errorlevel%==0 goto token_ok
set /a tries+=1
if %tries% lss 30 goto wait_token
echo [宿主] 60 秒内未取得 token，见 logs\host.log
pause
exit /b 1
:token_ok
rem 取最后一个 dsh web 行的完整 URL（含 token）写入 host-url.txt
node -e "const fs=require('fs');const t=fs.readFileSync('logs/host.log','utf8');const m=t.match(/http:\/\/127\.0\.0\.1:39771\/\?token=\S+/g);if(!m)process.exit(1);fs.writeFileSync('logs/host-url.txt',m[m.length-1]);console.log('token 已写入 logs/host-url.txt')"
if errorlevel 1 (
  echo [宿主] token 提取失败，见 logs\host.log
  pause
  exit /b 1
)
node scripts\host-client.mjs init
if errorlevel 1 (
  echo [宿主] cookie 初始化失败，3 秒后重试一次...
  ping -n 4 127.0.0.1 >nul
  node scripts\host-client.mjs init
)
goto host_done
:host_up
echo [宿主] 已在运行（端口 39771）
if not exist logs\host-cookie.txt (
  if exist logs\host-url.txt (
    echo [宿主] 补做 cookie 初始化...
    node scripts\host-client.mjs init
  ) else (
    echo [宿主] 警告：缺少 logs\host-url.txt，无法补 cookie；若考试报 cookie 错误请重启宿主或重跑本脚本
  )
)
:host_done

rem ---- 2) 可视化面板 :39772 ----
netstat -ano | findstr ":39772" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 goto dash_up
echo [面板] 启动中（端口 39772）...
start "memu-dashboard" /min cmd /c "cd /d %~dp0 && node dashboard\server.mjs > logs\dashboard.log 2>&1"
ping -n 3 127.0.0.1 >nul
:dash_up
echo [面板] http://127.0.0.1:39772

rem ---- 3) 打开浏览器 ----
start "" "http://127.0.0.1:39772/"
echo 启动完成，窗口可关闭（宿主与面板在各自最小化窗口里运行）。
ping -n 6 127.0.0.1 >nul
