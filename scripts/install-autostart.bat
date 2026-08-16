@echo off
setlocal
rem Registers a Task Scheduler task that starts Mission Control, hidden,
rem whenever you log into Windows — so it's already up by the time you
rem open a browser, instead of needing start.bat run by hand every time.
rem Re-run this any time (e.g. after moving the project folder) to
rem re-register with the current path; it overwrites the old task.

set TASKNAME=MissionControlAutoStart
set VBSPATH=%~dp0autostart-run.vbs

schtasks /Create /TN "%TASKNAME%" /TR "wscript.exe \"%VBSPATH%\"" /SC ONLOGON /RL LIMITED /F

if errorlevel 1 (
    echo.
    echo Failed to register the task. See the error above.
    pause
    exit /b 1
)

echo.
echo Installed. Mission Control will start hidden the next time you log
echo into Windows on this account. To start it right now without logging
echo out, run: schtasks /Run /TN "%TASKNAME%"
echo To remove it later, run scripts\uninstall-autostart.bat.
pause
endlocal
