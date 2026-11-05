@echo off
setlocal ENABLEDELAYEDEXPANSION
cd /d "%~dp0"

echo ===================================================
echo Supervisor Discord Bot - Otomatik Guncelleme Araci
echo ===================================================
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo [HATA] Git yuklu degil. Lutfen VDS uzerine Git kurup tekrar deneyin.
  pause
  exit /b 1
)

echo [1/3] En son kodlar GitHub'dan cekiliyor...
git pull origin main
if errorlevel 1 (
  echo [HATA] Kodlari cekerken bir sorun olustu. (Eger degisiklik yaptiysaniz cakisiyor olabilir)
  pause
  exit /b 1
)

echo.
echo [2/3] Node paketleri guncelleniyor...
call npm install

echo.
echo [3/3] Python paketleri guncelleniyor...
if exist .venv\Scripts\python.exe (
  call .venv\Scripts\python.exe -m pip install -r services\panel\requirements.txt
)

echo.
echo ===================================================
echo Guncelleme tamamlandi!
echo Yeni surumu kullanmak icin acik olan pencereleri
echo kapatin ve 'start.bat' dosyasini yeniden calistirin.
echo ===================================================
pause
