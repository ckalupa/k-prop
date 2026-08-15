[CmdletBinding()]
param(
    [string]$ProjectPath = "C:\Cloudflare\mlb-k-prop-app",
    [string]$DatabaseName = "mlb-k-prop-prod"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not (Test-Path $ProjectPath)) {
    throw "Project path not found: $ProjectPath"
}

Set-Location $ProjectPath

if (-not (Test-Path ".\migrations\0016_model_versioning_foundation.sql")) {
    throw "Build 1.1 migration is missing from $ProjectPath\migrations"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $ProjectPath "backups"
$backupPath = Join-Path $backupDir "$DatabaseName-pre-build-1.1-$timestamp.sql"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

Write-Host "`n[1/5] Confirming Wrangler access..." -ForegroundColor Cyan
npx wrangler whoami

Write-Host "`n[2/5] Exporting remote D1 backup..." -ForegroundColor Cyan
npx wrangler d1 export $DatabaseName --remote --output $backupPath
if (-not (Test-Path $backupPath)) {
    throw "D1 export did not create the expected backup: $backupPath"
}
Write-Host "Backup created: $backupPath" -ForegroundColor Green

Write-Host "`n[3/5] Showing pending migrations..." -ForegroundColor Cyan
npx wrangler d1 migrations list $DatabaseName --remote

Write-Host "`n[4/5] Applying remote migrations..." -ForegroundColor Cyan
npx wrangler d1 migrations apply $DatabaseName --remote

Write-Host "`n[5/5] Validating Build 1.1..." -ForegroundColor Cyan
npx wrangler d1 execute $DatabaseName --remote --file ".\build-1.1\validate-build-1.1.sql"

Write-Host "`nBuild 1.1 deployment complete." -ForegroundColor Green
Write-Host "Pre-build backup: $backupPath" -ForegroundColor Green
Write-Host "No Worker deploy is required because Build 1.1 is schema-only." -ForegroundColor Yellow
