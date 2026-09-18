@echo off
chcp 65001 >nul
setlocal

rem Always run from the project directory, including when opened by double-click.
cd /d "%~dp0"

rem The configuration TUI requires Node.js 22 or newer.
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 22 or newer first.
  echo.
  pause
  exit /b 1
)

rem npm runs the config script already defined in package.json.
where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm was not found. Check the Node.js installation and PATH.
  echo.
  pause
  exit /b 1
)

rem Do not install dependencies implicitly because that would access the network.
if not exist "node_modules\" (
  echo [ERROR] Dependencies are missing. Run npm install in this directory first.
  echo.
  pause
  exit /b 1
)

rem This command builds TypeScript first, then opens the Chinese configuration TUI.
call npm run config
set "CONFIG_EXIT_CODE=%ERRORLEVEL%"

rem Keep the window open only after a failure so the error remains visible.
if not "%CONFIG_EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] The server configuration TUI failed with exit code %CONFIG_EXIT_CODE%.
  echo Fix the error shown above and try again.
  echo.
  pause
)

exit /b %CONFIG_EXIT_CODE%
