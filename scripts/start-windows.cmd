@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%NO_PAUSE%"=="1" (
  echo.
  if "%EXIT_CODE%"=="0" (
    echo The application is ready. Press any key to close this launcher window.
  ) else (
    echo Startup did not complete. Review the message above, then press any key to close this window.
  )
  pause >nul
)
endlocal & exit /b %EXIT_CODE%
