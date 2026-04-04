@echo off
REM ============================================
REM Anime Video Generator v2.0 — Windows Start
REM ============================================

echo.
echo ╔══════════════════════════════════════════╗
echo ║     🎬 Anime Edits Generator v2.0       ║
echo ╚══════════════════════════════════════════╝
echo.

REM ─── CHECK PREREQUISITES ─────────────────────

echo Checking prerequisites...

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Node.js not found. Install v18+: https://nodejs.org
    pause
    exit /b 1
)
echo   ✅ Node.js found

where python >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Python not found. Install 3.9+: https://python.org
    pause
    exit /b 1
)
echo   ✅ Python found

where ffmpeg >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ FFmpeg not found. Install: choco install ffmpeg
    pause
    exit /b 1
)
echo   ✅ FFmpeg found

REM ─── CHECK .env FILE ────────────────────────

if not exist "node-service\.env" (
    echo.
    echo ⚠️  No .env file found!
    echo    Copying template...
    copy node-service\.env.example node-service\.env >nul
    echo    → Edit node-service\.env and add your API keys!
    echo    → Then re-run this script.
    echo.
    echo    Required keys:
    echo      OPENAI_API_KEY or GEMINI_API_KEY  (for AI scripts)
    echo      PEXELS_API_KEY or PIXABAY_API_KEY (for images)
    echo.
    pause
    exit /b 0
)

REM ─── INSTALL DEPENDENCIES ──────────────────

echo.
echo Installing dependencies...

echo   📦 Node.js packages...
cd node-service
call npm install --silent 2>nul
cd ..

echo   🐍 Python packages...
cd python-tts-service
pip install -q -r requirements.txt 2>nul
cd ..

echo   ✅ Dependencies installed

REM ─── START SERVICES ────────────────────────

echo.
echo Starting services...

echo   🎤 Starting TTS service (port 5050)...
start "TTS Service" /min cmd /c "cd python-tts-service && python app.py"

timeout /t 2 /nobreak >nul

echo   🎬 Starting Node.js orchestrator (port 4000)...
start "Video Generator" /min cmd /c "cd node-service && node server.js"

timeout /t 2 /nobreak >nul

echo.
echo ╔══════════════════════════════════════════╗
echo ║         ✅ All services running!         ║
echo ╠══════════════════════════════════════════╣
echo ║  Backend:  http://localhost:4000         ║
echo ║  TTS:      http://localhost:5050         ║
echo ║  Frontend: Open frontend\index.html     ║
echo ║                                          ║
echo ║  Health:   http://localhost:4000/health  ║
echo ╚══════════════════════════════════════════╝
echo.

REM Open frontend in browser
start "" "frontend\index.html"

echo Press any key to stop all services...
pause >nul

REM Kill services
taskkill /FI "WINDOWTITLE eq TTS Service*" /F >nul 2>nul
taskkill /FI "WINDOWTITLE eq Video Generator*" /F >nul 2>nul
echo Services stopped.
pause
