param(
    [string]$Database = "mlb-k-prop-prod",
    [switch]$DryRun,
    [int]$DelayMilliseconds = 100
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$SqlOutput = Join-Path $PSScriptRoot "refresh-pitcher-teams.sql"

$TeamMap = @{
    108 = "LAA"
    109 = "AZ"
    110 = "BAL"
    111 = "BOS"
    112 = "CHC"
    113 = "CIN"
    114 = "CLE"
    115 = "COL"
    116 = "DET"
    117 = "HOU"
    118 = "KC"
    119 = "LAD"
    120 = "WSH"
    121 = "NYM"
    133 = "ATH"
    134 = "PIT"
    135 = "SD"
    136 = "SEA"
    137 = "SF"
    138 = "STL"
    139 = "TB"
    140 = "TEX"
    141 = "TOR"
    142 = "MIN"
    143 = "PHI"
    144 = "ATL"
    145 = "CWS"
    146 = "MIA"
    147 = "NYY"
    158 = "MIL"
}

function Get-WranglerJson {
    $query = "SELECT * FROM pitchers WHERE mlb_id IS NOT NULL ORDER BY canonical_name;"

    $output = & npx wrangler d1 execute $Database `
        --remote `
        --json `
        --command="$query" 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw "Wrangler failed:`n$($output -join [Environment]::NewLine)"
    }

    $jsonText = ($output -join [Environment]::NewLine)

    try {
        return $jsonText | ConvertFrom-Json
    }
    catch {
        throw "Could not parse Wrangler JSON output.`nRaw output:`n$jsonText"
    }
}

function Get-CurrentMlbTeam {
    param(
        [Parameter(Mandatory = $true)]
        [int]$MlbId
    )

    $url = "https://statsapi.mlb.com/api/v1/people/$($MlbId)?hydrate=currentTeam"

    $response = Invoke-RestMethod `
        -Uri $url `
        -Method Get `
        -Headers @{
            Accept = "application/json"
            "User-Agent" = "mlb-k-prop-app-team-refresh/1.0"
        } `
        -TimeoutSec 30

    $person = @($response.people) | Select-Object -First 1

    if (-not $person) {
        throw "MLB returned no player record."
    }

    if (-not $person.currentTeam -or -not $person.currentTeam.id) {
        return $null
    }

    [pscustomobject]@{
        TeamId   = [int]$person.currentTeam.id
        TeamName = [string]$person.currentTeam.name
    }
}

Write-Host "Reading pitchers from D1..." -ForegroundColor Cyan

$queryResult = Get-WranglerJson
$firstResult = @($queryResult) | Select-Object -First 1
$pitchers = @($firstResult.results)

if ($pitchers.Count -eq 0) {
    throw "No pitchers with MLB IDs were returned from D1."
}

Write-Host "Found $($pitchers.Count) pitchers." -ForegroundColor Cyan

$sqlStatements = New-Object System.Collections.Generic.List[string]
$sqlStatements.Add("BEGIN TRANSACTION;")

$changed = 0
$unchanged = 0
$noCurrentTeam = 0
$failed = 0

foreach ($pitcher in $pitchers) {
    $name = [string]$pitcher.canonical_name

    try {
        $mlbId = [int]$pitcher.mlb_id
        $team = Get-CurrentMlbTeam -MlbId $mlbId

        if ($null -eq $team) {
            Write-Warning "${name}: MLB returned no current team."
            $noCurrentTeam++
            continue
        }

        if (-not $TeamMap.ContainsKey($team.TeamId)) {
            Write-Warning "${name}: unknown MLB team ID $($team.TeamId) ($($team.TeamName))."
            $failed++
            continue
        }

        $newTeam = [string]$TeamMap[$team.TeamId]
        $oldTeam = [string]$pitcher.current_team

        if ($oldTeam -eq $newTeam) {
            $unchanged++
            continue
        }

        $pitcherId = [int]$pitcher.pitcher_id
        $safeTeam = $newTeam.Replace("'", "''")

        $sqlStatements.Add(
            "UPDATE pitchers SET current_team='$safeTeam', updated_at=CURRENT_TIMESTAMP WHERE pitcher_id=$pitcherId;"
        )

        Write-Host "${name}: $oldTeam -> $newTeam"
        $changed++
    }
    catch {
        Write-Warning "${name}: $($_.Exception.Message)"
        $failed++
    }

    if ($DelayMilliseconds -gt 0) {
        Start-Sleep -Milliseconds $DelayMilliseconds
    }
}

$sqlStatements.Add("COMMIT;")
$sqlStatements | Set-Content -Path $SqlOutput -Encoding UTF8

Write-Host ""
Write-Host "Changed:         $changed"
Write-Host "Unchanged:       $unchanged"
Write-Host "No current team: $noCurrentTeam"
Write-Host "Failed:          $failed"
Write-Host "SQL file:        $SqlOutput"

if ($DryRun) {
    Write-Host ""
    Write-Host "Dry run complete. No D1 updates were applied." -ForegroundColor Yellow
    exit 0
}

if ($changed -eq 0) {
    Write-Host ""
    Write-Host "No team changes to apply." -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "Applying $changed team update(s) to D1..." -ForegroundColor Cyan

& npx wrangler d1 execute $Database `
    --remote `
    --file=$SqlOutput

if ($LASTEXITCODE -ne 0) {
    throw "D1 update failed. The generated SQL remains at $SqlOutput."
}

Write-Host ""
Write-Host "Refresh complete." -ForegroundColor Green
