@echo off
setlocal
rem Headless entrypoint used by the auto-start scheduled task — no visible
rem window, no browser tab. See autostart-run.vbs for the hidden wrapper
rem and install-autostart.bat for what registers the task. start.bat is
rem still the right thing to double-click by hand; this is only meant to
rem be launched by Task Scheduler.
cd /d "%~dp0.."

if not exist "node_modules" (
    call npm install >> "%~dp0autostart.log" 2>&1
    if errorlevel 1 exit /b 1
)

rem Someone already started it manually (or a previous login's task is
rem still up) — succeed without spawning a second instance.
netstat -ano | findstr /R /C:":5000[^0-9]" | findstr "LISTENING" >nul
if %errorlevel%==0 exit /b 0

rem Runs in the foreground on purpose: if node crashes, this batch file's
rem exit code reflects it, which the wrapping .vbs passes on to Task
rem Scheduler's own history/status for that run.
node server\index.js >> "%~dp0autostart.log" 2>&1

endlocal
