Option Explicit
Dim shell, exitCode
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Users\showp\.code-ai\remote-agent\releases\20261008-v1"
exitCode = shell.Run("""C:\Users\showp\AppData\Local\Programs\NodeJS\node-v24.20.0-win-x64\node.exe"" ""C:\Users\showp\.code-ai\remote-agent\releases\20261008-v1\runner.mjs""", 0, True)
WScript.Quit exitCode
