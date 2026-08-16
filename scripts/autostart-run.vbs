' Hidden wrapper around autostart-run.bat — Task Scheduler launches this
' (via wscript.exe) instead of the .bat directly so the server starts with
' no visible console window. Waits for the batch file and forwards its
' exit code so Task Scheduler's run history reflects success/failure.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
exitCode = shell.Run("""" & scriptDir & "\autostart-run.bat""", 0, True)
WScript.Quit(exitCode)
