@echo off
rem One reliable way to restart, instead of closing whatever window it's
rem running in (unreliable on Windows - see stop.bat) and re-running
rem start.bat by hand.
setlocal
cd /d "%~dp0"

call stop.bat
ping -n 2 127.0.0.1 >nul
call start.bat

endlocal
