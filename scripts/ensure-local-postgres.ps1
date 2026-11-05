param(
  [string]$ProjectRoot = (Get-Location).Path
)

$ErrorActionPreference = "Stop"

function Test-TcpPort {
  param(
    [string]$TargetHost,
    [int]$Port
  )

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connectTask = $client.ConnectAsync($TargetHost, $Port)
    $completed = $connectTask.Wait(1000)
    if (-not $completed) {
      return $false
    }

    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Test-PostgresReady {
  param(
    [string]$PsqlPath,
    [string]$User,
    [int]$Port
  )

  $result = & $PsqlPath -h 127.0.0.1 -p $Port -U $User -d postgres -tAc "SELECT 1" 2>$null
  return $LASTEXITCODE -eq 0 -and ([string]$result).Trim() -eq "1"
}

function Wait-ForPostgresReady {
  param(
    [string]$PsqlPath,
    [string]$User,
    [int]$Port,
    [int]$TimeoutSeconds = 30
  )

  for ($attempt = 0; $attempt -lt $TimeoutSeconds; $attempt++) {
    if ((Test-TcpPort -TargetHost "127.0.0.1" -Port $Port) -and
        (Test-PostgresReady -PsqlPath $PsqlPath -User $User -Port $Port)) {
      return $true
    }

    Start-Sleep -Seconds 1
  }

  return $false
}

function Get-DbSettings {
  param([string]$SettingsPath)

  $settings = Get-Content $SettingsPath -Raw | ConvertFrom-Json
  $databaseUrl = [string]$settings.runtime.databaseUrl
  $uri = [Uri]$databaseUrl
  $userInfoParts = $uri.UserInfo.Split(":", 2)

  return [pscustomobject]@{
    Host     = $uri.Host
    Port     = $uri.Port
    User     = if ($userInfoParts.Length -ge 1) { $userInfoParts[0] } else { "postgres" }
    Password = if ($userInfoParts.Length -eq 2) { $userInfoParts[1] } else { "" }
    Database = $uri.AbsolutePath.TrimStart("/")
  }
}

$settingsPath = Join-Path $ProjectRoot "settings.json"
if (-not (Test-Path $settingsPath)) {
  throw "settings.json bulunamadi."
}

$db = Get-DbSettings -SettingsPath $settingsPath
$localHosts = @("localhost", "127.0.0.1", "::1")

if ($localHosts -notcontains $db.Host) {
  Write-Host "Remote veritabani algilandi. Yerel PostgreSQL bootstrap atlandi."
  exit 0
}

$serverRunning = Test-TcpPort -TargetHost "127.0.0.1" -Port $db.Port

$runtimeRoot = Join-Path $ProjectRoot ".runtime\postgres"
$archivePath = Join-Path $runtimeRoot "postgresql-binaries.zip"
$extractRoot = Join-Path $runtimeRoot "extract"
$pgsqlRoot = Join-Path $extractRoot "pgsql"
$binRoot = Join-Path $pgsqlRoot "bin"
$dataRoot = Join-Path $runtimeRoot "data"
$logPath = Join-Path $runtimeRoot "postgres.log"
$pwFile = Join-Path $runtimeRoot "pg-password.txt"
$downloadUrl = "https://get.enterprisedb.com/postgresql/postgresql-17.9-2-windows-x64-binaries.zip"

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

if (-not (Test-Path (Join-Path $binRoot "psql.exe"))) {
  if (-not (Test-Path $archivePath)) {
    Write-Host "PostgreSQL binary zip indiriliyor..."
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath
  }

  Write-Host "PostgreSQL binary'leri aciliyor..."
  Expand-Archive -Path $archivePath -DestinationPath $extractRoot -Force
}

$initdb = Join-Path $binRoot "initdb.exe"
$pgCtl = Join-Path $binRoot "pg_ctl.exe"
$psql = Join-Path $binRoot "psql.exe"
$createdb = Join-Path $binRoot "createdb.exe"
$pidFile = Join-Path $dataRoot "postmaster.pid"
$env:PGPASSWORD = $db.Password
$env:PGCONNECT_TIMEOUT = "5"

if (-not $serverRunning -and -not (Test-Path (Join-Path $dataRoot "PG_VERSION"))) {
  if (Test-Path $dataRoot) {
    Remove-Item -Path $dataRoot -Recurse -Force
  }
  Write-Host "PostgreSQL data dizini olusturuluyor..."
  Set-Content -Path $pwFile -Value $db.Password -NoNewline
  & $initdb -D $dataRoot -U $db.User -A scram-sha-256 --pwfile=$pwFile --encoding=UTF8 --locale=C | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "initdb basarisiz oldu."
  }
}

if (-not $serverRunning) {
  if (Test-Path $pidFile) {
    Write-Host "Eski PostgreSQL pid dosyasi temizleniyor..."
    Remove-Item -Path $pidFile -Force -ErrorAction SilentlyContinue
  }

  Write-Host "PostgreSQL baslatiliyor..."
  & $pgCtl -D $dataRoot -l $logPath -o "-p $($db.Port) -h 127.0.0.1" start -w
  $pgCtlExitCode = $LASTEXITCODE

  if (-not (Wait-ForPostgresReady -PsqlPath $psql -User $db.User -Port $db.Port)) {
    if ($pgCtlExitCode -ne 0) {
      throw "pg_ctl start basarisiz oldu."
    }
    throw "PostgreSQL beklenen surede hazir olmadi."
  }
} else {
  Write-Host "PostgreSQL zaten $($db.Port) portunda calisiyor."
}

$dbExists = & $psql -h 127.0.0.1 -p $db.Port -U $db.User -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$($db.Database)'" 2>$null
if ($LASTEXITCODE -ne 0) {
  throw "PostgreSQL acildi fakat veritabani kontrolu basarisiz."
}

$dbExistsValue = if ($null -eq $dbExists) { "" } else { [string]$dbExists }
if ($dbExistsValue.Trim() -ne "1") {
  Write-Host "Veritabani olusturuluyor: $($db.Database)"
  & $createdb -h 127.0.0.1 -p $db.Port -U $db.User $db.Database | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Veritabani olusturma basarisiz oldu."
  }
}

if (-not (Wait-ForPostgresReady -PsqlPath $psql -User $db.User -Port $db.Port -TimeoutSeconds 5)) {
  throw "PostgreSQL son hazirlik testi basarisiz."
}

Write-Host "Yerel PostgreSQL hazir."
