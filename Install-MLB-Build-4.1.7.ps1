$ErrorActionPreference = "Stop"
$Build = "4.1.7"
$ZipName = "mlb-k-prop-app-release-3.3-build-4.1.7.zip"
$Downloads = Join-Path $env:USERPROFILE "Downloads"
$ZipPath = Join-Path $Downloads $ZipName
$ProjectPath = "C:\Cloudflare\mlb-k-prop-app"
$BackupRoot = "C:\Cloudflare\_deployment-backups"
$D1BackupDir = Join-Path $ProjectPath "backups"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$TempRoot = Join-Path $env:TEMP "mlb-build-4-1-7-$Stamp"
$ExtractedProject = Join-Path $TempRoot "mlb-k-prop-app"
$SourceBackup = Join-Path $BackupRoot "mlb-k-prop-app-pre-build-$Build-$Stamp.zip"
$D1Backup = Join-Path $D1BackupDir "mlb-k-prop-prod-pre-build-$Build-$Stamp.sql"
Write-Host "MLB K-Prop Release 3.3 - Build 4.1.7" -ForegroundColor Cyan
Write-Host "Archive Historical Reconstruction" -ForegroundColor Cyan
if (-not (Test-Path $ZipPath)) { throw "Build ZIP not found: $ZipPath" }
New-Item -ItemType Directory -Force -Path $BackupRoot,$D1BackupDir | Out-Null
Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null
Write-Host "[1/9] Extracting update..." -ForegroundColor Yellow
Expand-Archive -Path $ZipPath -DestinationPath $TempRoot -Force
if (-not (Test-Path (Join-Path $ExtractedProject "BUILD_4_1_7_README.txt"))) { throw "Expected Build 4.1.7 release files were not found." }
Write-Host "[2/9] Backing up current project source..." -ForegroundColor Yellow
Compress-Archive -Path (Join-Path $ProjectPath "*") -DestinationPath $SourceBackup -Force
Write-Host "[3/9] Copying Build 4.1.7 into project..." -ForegroundColor Yellow
& robocopy $ExtractedProject $ProjectPath /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP /XD node_modules .wrangler backups | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Robocopy failed with exit code $LASTEXITCODE." }
Set-Location $ProjectPath
Write-Host "[4/9] Installing/verifying Node dependencies..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
Write-Host "[5/9] Checking TypeScript..." -ForegroundColor Yellow
npx tsc -p tsconfig.check.json --noEmit
if ($LASTEXITCODE -ne 0) { throw "TypeScript validation failed." }
Write-Host "[6/9] Confirming Wrangler authentication and backing up D1..." -ForegroundColor Yellow
npx wrangler whoami
if ($LASTEXITCODE -ne 0) { throw "Wrangler authentication check failed." }
npx wrangler d1 export mlb-k-prop-prod --remote --output $D1Backup
if ($LASTEXITCODE -ne 0) { throw "Remote D1 backup failed. Deployment was not attempted." }
Write-Host "[7/9] Applying pending D1 migrations..." -ForegroundColor Yellow
npx wrangler d1 migrations apply mlb-k-prop-prod --remote
if ($LASTEXITCODE -ne 0) { throw "Build 4.1.7 D1 migration failed." }
Write-Host "[8/9] Validating Build 4.1.7 schema..." -ForegroundColor Yellow
$Sql = "SELECT COUNT(*) AS archive_reconstruction_tables FROM sqlite_master WHERE type='table' AND name IN ('archive_historical_reconstruction_runs','archive_historical_reconstructions'); SELECT COUNT(*) AS foreign_key_violations FROM pragma_foreign_key_check;"
$ok=$false
for($i=1;$i -le 4;$i++){ npx wrangler d1 execute mlb-k-prop-prod --remote --command $Sql; if($LASTEXITCODE -eq 0){$ok=$true;break}; if($i -lt 4){Start-Sleep -Seconds 7} }
if(-not $ok){throw "Build 4.1.7 database validation failed after 4 attempts."}
Write-Host "[9/9] Deploying Worker and static assets..." -ForegroundColor Yellow
Remove-Item -Recurse -Force .\.wrangler -ErrorAction SilentlyContinue
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { throw "Worker deployment failed." }
Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Build 4.1.7 installed successfully." -ForegroundColor Green
Write-Host "Project source backup: $SourceBackup"
Write-Host "D1 backup:             $D1Backup"
Write-Host "Admin page:            https://admin.mlb.kalupa.net/backtest-archive-reconstruction.html"
