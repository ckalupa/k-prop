$ErrorActionPreference = "Stop"

$Wrangler = Join-Path $PSScriptRoot "node_modules\.bin\wrangler.cmd"
$DatabaseName = "mlb-k-prop-prod"
$BoardId = 126
$RequiredConfirmation = "DELETE ACTIVE BOARD 126"

if (-not (Test-Path $Wrangler)) {
    throw "Wrangler was not found at: $Wrangler"
}

function Invoke-D1 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Sql
    )

    & $Wrangler d1 execute $DatabaseName --remote --command $Sql

    if ($LASTEXITCODE -ne 0) {
        throw "Wrangler query failed. Nothing further was changed."
    }
}

Write-Host ""
Write-Host "Board cleanup utility" -ForegroundColor Cyan
Write-Host "Database: $DatabaseName"
Write-Host "Board ID: $BoardId"

Write-Host ""
Write-Host "Target board:" -ForegroundColor Cyan

Invoke-D1 "SELECT board_id, board_date, board_name, status FROM boards WHERE board_id = $BoardId;"

Write-Host ""
Write-Host "Current props:" -ForegroundColor Cyan

Invoke-D1 "SELECT p.prop_id, pi.canonical_name AS pitcher, t.abbreviation AS opponent, p.strikeout_line, p.available_side, p.prop_type, p.status FROM props p JOIN pitchers pi ON pi.pitcher_id = p.pitcher_id LEFT JOIN teams t ON t.team_id = p.opponent_team_id WHERE p.board_id = $BoardId ORDER BY p.prop_id;"

Write-Host ""
Write-Host "WARNING: Board $BoardId is ACTIVE." -ForegroundColor Red
Write-Host "This deletes all props and related model/result data from this board."
Write-Host "The board record will remain ACTIVE."
Write-Host "Any Plays of the Day slips tied to this board will also be deleted." -ForegroundColor Yellow
Write-Host ""

$confirmation = Read-Host "Type $RequiredConfirmation to continue"

if ($confirmation -cne $RequiredConfirmation) {
    Write-Host ""
    Write-Host "Cancelled. Nothing was deleted." -ForegroundColor Yellow
    exit 0
}

$sql = @"
PRAGMA foreign_keys = ON;

DELETE FROM play_slip_legs
WHERE slip_id IN (
    SELECT slip_id
    FROM play_slips
    WHERE board_id = 126
);

DELETE FROM play_slip_rules
WHERE slip_id IN (
    SELECT slip_id
    FROM play_slips
    WHERE board_id = 126
);

DELETE FROM play_audit_events
WHERE slip_id IN (
    SELECT slip_id
    FROM play_slips
    WHERE board_id = 126
);

DELETE FROM play_slips
WHERE board_id = 126;

DELETE FROM prop_results
WHERE prop_id IN (
    SELECT prop_id
    FROM props
    WHERE board_id = 126
);

DELETE FROM feature_snapshots
WHERE prop_id IN (
    SELECT prop_id
    FROM props
    WHERE board_id = 126
);

DELETE FROM recommendations
WHERE prop_id IN (
    SELECT prop_id
    FROM props
    WHERE board_id = 126
);

DELETE FROM props
WHERE board_id = 126;

UPDATE boards
SET updated_at = CURRENT_TIMESTAMP
WHERE board_id = 126;
"@

$tempSql = Join-Path $env:TEMP "clear-board-126.sql"

try {
    $sql | Set-Content -Path $tempSql -Encoding UTF8

    Write-Host ""
    Write-Host "Deleting board contents..." -ForegroundColor Cyan

    & $Wrangler d1 execute $DatabaseName --remote --file $tempSql

    if ($LASTEXITCODE -ne 0) {
        throw "The delete operation failed. Review the Wrangler error above."
    }
}
finally {
    Remove-Item $tempSql -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Verification:" -ForegroundColor Cyan

Invoke-D1 "SELECT b.board_id, b.board_date, b.board_name, b.status, COUNT(p.prop_id) AS remaining_props FROM boards b LEFT JOIN props p ON p.board_id = b.board_id WHERE b.board_id = $BoardId GROUP BY b.board_id, b.board_date, b.board_name, b.status;"

Write-Host ""
Write-Host "Board $BoardId cleanup complete." -ForegroundColor Green
Write-Host "Confirm remaining_props is 0, then refresh Board Editor and import the corrected board."