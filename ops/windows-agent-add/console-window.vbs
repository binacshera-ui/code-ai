Option Explicit
Dim shell, mode, exitCode
Set shell = CreateObject("WScript.Shell")
mode = "Inspect"
If WScript.Arguments.Count > 0 Then mode = WScript.Arguments(0)
If mode <> "Inspect" And mode <> "Hide" Then WScript.Quit 43
exitCode = shell.Run("""C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\Users\showp\.code-ai\remote-agent\window-control\console-window.ps1"" -Mode " & mode, 0, True)
WScript.Quit exitCode
