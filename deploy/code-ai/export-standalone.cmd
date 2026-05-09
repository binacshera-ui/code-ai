@echo off
set SCRIPT_DIR=%~dp0
node "%SCRIPT_DIR%export-standalone.mjs" %*
exit /b %ERRORLEVEL%
