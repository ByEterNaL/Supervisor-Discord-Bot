@echo off
setlocal ENABLEDELAYEDEXPANSION
cd /d "%~dp0"
set "PROJECT_ROOT=%CD%"

if not exist settings.json (
  copy /Y settings.example.json settings.json >nul
  echo settings.json olusturuldu. Once Discord ve veritabani bilgilerini doldur.
  start "" notepad "%CD%\settings.json"
  pause
  exit /b 0
)

where git >nul 2>&1
if not errorlevel 1 (
  if exist .git (
    echo Guncellemeler kontrol ediliyor...
    git fetch origin main >nul 2>&1
    for /f %%i in ('git rev-list HEAD...origin/main --count 2^>nul') do set UPDATE_COUNT=%%i
    if "!UPDATE_COUNT!" NEQ "0" if "!UPDATE_COUNT!" NEQ "" (
      echo ===================================================
      echo [UYARI] Yeni bir guncelleme var! ^(!UPDATE_COUNT! commit geridesiniz^)
      echo [UYARI] Botu kapatip 'update.bat' dosyasini calistirin.
      echo ===================================================
      timeout /t 5
    )
  )
)

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js bulunamadi. Node.js kurup tekrar dene.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo npm bulunamadi. Node.js kurulumu eksik.
  pause
  exit /b 1
)

where python >nul 2>&1
if errorlevel 1 (
  echo Python bulunamadi. Python 3.13+ kurup tekrar dene.
  pause
  exit /b 1
)

python --version >nul 2>&1
if errorlevel 1 (
  echo Python duzgun calismiyor veya yuklu degil ^(Windows App Store yonlendirmesi olabilir^).
  echo Lutfen https://www.python.org/downloads/ adresinden Python 3.13+ kurun.
  pause
  exit /b 1
)

echo Node paketleri kuruluyor...
call npm install
if errorlevel 1 goto :error

if exist .venv\Scripts\python.exe (
  .venv\Scripts\python.exe --version >nul 2>&1
  if errorlevel 1 (
    echo Mevcut Python sanal ortami bozuk, yenileniyor...
    rmdir /s /q .venv
  )
)

if not exist .venv\Scripts\python.exe (
  echo Python sanal ortami olusturuluyor...
  python -m venv .venv
  if errorlevel 1 goto :error
)

echo Python paketleri kuruluyor...
call .venv\Scripts\python.exe -m pip install --upgrade pip
if errorlevel 1 goto :error
call .venv\Scripts\python.exe -m pip install -r services\panel\requirements.txt
if errorlevel 1 goto :error

set REDIS_URL=disabled

echo Yerel PostgreSQL hazirlaniyor...
call powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\ensure-local-postgres.ps1" -ProjectRoot "%PROJECT_ROOT%"
if errorlevel 1 (
  echo PostgreSQL hazirlama adimi basarisiz oldu.
  pause
  exit /b 1
)

echo Veritabani migration'lari uygulaniyor...
call npm run migrate
if errorlevel 1 (
  echo Migration basarisiz. PostgreSQL hazirlama adimi eksik ya da veritabani acilamadi.
  pause
  exit /b 1
)

for /f %%i in ('powershell -NoProfile -Command "(Get-Content '%PROJECT_ROOT%\settings.json' -Raw | ConvertFrom-Json).panel.host"') do set PANEL_HOST=%%i
for /f %%i in ('powershell -NoProfile -Command "(Get-Content '%PROJECT_ROOT%\settings.json' -Raw | ConvertFrom-Json).panel.port"') do set PANEL_PORT=%%i

if "%PANEL_HOST%"=="" set PANEL_HOST=127.0.0.1
if "%PANEL_PORT%"=="" set PANEL_PORT=5231

echo Mevcut bot, worker ve panel surecleri temizleniyor...
powershell -NoProfile -Command "$projectRoot = '%PROJECT_ROOT%'; $patterns = @('npm run bot','npm run worker','services/bot/src/index.ts','services/worker/src/index.ts','uvicorn app.main:app'); function Test-SupervisorProcess($process) { if (-not $process.CommandLine) { return $false }; if ($process.ProcessId -eq $PID) { return $false }; $name = ($process.Name | ForEach-Object { $_.ToLowerInvariant() }); if (($name -ne 'cmd.exe') -and ($name -ne 'node.exe') -and (-not $name.StartsWith('python')) -and ($name -ne 'powershell.exe') -and ($name -ne 'pwsh.exe')) { return $false }; $commandLine = [string]$process.CommandLine; $parentCommandLine = ''; if ($process.ParentProcessId) { try { $parent = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $process.ParentProcessId); if ($parent -and $parent.CommandLine) { $parentCommandLine = [string]$parent.CommandLine } } catch {} }; $matchedPattern = $null; foreach ($pattern in $patterns) { if (($commandLine -like ('*' + $pattern + '*')) -or ($parentCommandLine -like ('*' + $pattern + '*'))) { $matchedPattern = $pattern; break } }; if (-not $matchedPattern) { return $false }; if ($matchedPattern -eq 'uvicorn app.main:app') { return $true }; if (($commandLine -like ('*' + $projectRoot + '*')) -or ($parentCommandLine -like ('*' + $projectRoot + '*'))) { return $true }; return $false }; for ($i = 0; $i -lt 6; $i++) { $targets = Get-CimInstance Win32_Process | Where-Object { Test-SupervisorProcess $_ }; if (-not $targets) { break }; $targets | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }; Start-Sleep -Milliseconds 700 }" >nul 2>&1

echo Bot, worker ve panel baslatiliyor...
start "Supervisor Discord Bot Bot" cmd /k "cd /d %PROJECT_ROOT% && set REDIS_URL=disabled && npm run bot"
start "Supervisor Discord Bot Worker" cmd /k "cd /d %PROJECT_ROOT% && set REDIS_URL=disabled && npm run worker"
start "Supervisor Discord Bot Panel" cmd /k "cd /d %PROJECT_ROOT% && set REDIS_URL=disabled && .venv\Scripts\python.exe -m uvicorn app.main:app --app-dir services/panel --host %PANEL_HOST% --port %PANEL_PORT%"

echo Panel yaniti bekleniyor...
for /L %%i in (1,1,30) do (
  powershell -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing 'http://%PANEL_HOST%:%PANEL_PORT%/overview' -TimeoutSec 2; if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 goto :panel_ready
  timeout /t 1 /nobreak >nul
)

echo Panel baslatilamadi. Panel penceresindeki hatayi kontrol et.
pause
exit /b 1

:panel_ready
call powershell -NoProfile -Command "Start-Process 'http://%PANEL_HOST%:%PANEL_PORT%/overview'" >nul 2>&1

echo Panel acildi: http://%PANEL_HOST%:%PANEL_PORT%/overview
echo Not: Redis bu akista opsiyonel calisir; PostgreSQL yerel veya harici erisilebilir olmali.
exit /b 0

:error
echo Kurulum veya baslatma adimlarindan biri basarisiz oldu.
pause
exit /b 1
