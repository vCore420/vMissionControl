@echo off
setlocal
set TASKNAME=MissionControlAutoStart

schtasks /Delete /TN "%TASKNAME%" /F

if errorlevel 1 (
    echo.
    echo Nothing to remove, or the delete failed — see the error above.
) else (
    echo.
    echo Removed. Mission Control will no longer start automatically at logon.
    echo Any instance already running keeps running; this only affects future logons.
)
pause
endlocal
