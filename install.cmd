@echo off
set SCRIPT_DIR=%~dp0
node "%SCRIPT_DIR%deploy\code-ai\install.mjs" %*
exit /b %ERRORLEVEL%
