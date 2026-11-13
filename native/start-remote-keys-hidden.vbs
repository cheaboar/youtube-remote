Option Explicit
Dim shell, fso, base, script
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
script = base & "\RemoteKeysBridge.ps1"
' 0 = hidden window, False = do not wait. The tray icon is still shown.
shell.Run "powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """", 0, False
