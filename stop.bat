@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":5000[^0-9]" ^| findstr "LISTENING"') do (
    set FOUND=1
    set SERVERPID=%%p
)

if "%FOUND%"=="0" (
    echo Nothing is listening on port 5000 - Mission Control isn't running.
    goto :end
)

echo Found Mission Control running as PID %SERVERPID% on port 5000.
echo Asking it to shut down gracefully...
taskkill /PID %SERVERPID% >nul 2>&1

rem Give server/index.js's SIGINT/SIGTERM handler (stops the health/host
rem timers, closes the WebSocket server, logs the shutdown) a moment to
rem actually run before assuming it needs a harder push. Whether a plain
rem taskkill even reaches a console-less/detached node process reliably on
rem Windows is inconsistent - that inconsistency is the whole reason this
rem script verifies and falls back instead of assuming it worked.
rem A ping against localhost is used as the delay instead of `timeout`
rem here - `timeout` needs a real console it can read a cancel keypress
rem from and fails outright ("Input redirection is not supported") when
rem run somewhere that isn't one (found while testing this very script).
ping -n 4 127.0.0.1 >nul

netstat -ano | findstr /R /C:":5000[^0-9]" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo Still running - closing it forcefully instead.
    taskkill /PID %SERVERPID% /F >nul 2>&1
) else (
    echo Stopped cleanly.
)

rem start.bat opens the server in its own titled console window - if
rem that's still sitting open (now idle, since its node child just
rem exited), close it too rather than leaving a dead window behind.
taskkill /FI "WINDOWTITLE eq Mission Control Server*" /F >nul 2>&1

:end
endlocal
