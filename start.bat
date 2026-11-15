@echo off
rem INKOS: installs itself on the first run, then opens the app in your browser.
cd /d "%~dp0"

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY goto nopython
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" || goto nopython

if exist .venv\Scripts\python.exe goto run
echo First run: setting up INKOS in %cd%\.venv
echo This downloads PyTorch and takes a few minutes. Later starts are instant.
%PY% -m venv .venv || goto failed
.venv\Scripts\python -m pip install --upgrade pip >nul
.venv\Scripts\python -m pip install -r requirements.txt || goto failed

:run
echo Starting INKOS. Leave this window open while you use it; close it to stop INKOS.
.venv\Scripts\python -m inkos serve --open
pause
exit /b

:nopython
echo INKOS needs Python 3.10 or newer. Install it from https://www.python.org/downloads/
echo (tick "Add python.exe to PATH") and run this again.
pause
exit /b 1

:failed
if exist .venv rmdir /s /q .venv
echo Installing the requirements failed (see above). Check your internet connection and run this again.
pause
exit /b 1
