@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)

rem Check whether something is already listening on port 5000 before
rem starting a second instance - Node throws EADDRINUSE otherwise.
netstat -ano | findstr /R /C:":5000[^0-9]" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo Mission Control already appears to be running on port 5000.
    echo Opening it in your browser instead of starting a second instance.
    start "" http://localhost:5000
    exit /b 0
)

echo Starting Mission Control server...
start "Mission Control Server" cmd /k "npm start"

rem A ping against localhost as the delay, not `timeout` - timeout needs a
rem real console to read a cancel keypress from and can fail outright
rem somewhere that isn't one (e.g. run non-interactively).
ping -n 3 127.0.0.1 >nul
start "" http://localhost:5000

endlocal
