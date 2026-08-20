[CmdletBinding()]
param([switch]$DeviceAuth)

$reviewerHome = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:CODEX_HOME = $reviewerHome

& codex login status
if ($LASTEXITCODE -eq 0) {
    Write-Host "Codex is already authenticated for $reviewerHome"
    exit 0
}

if ($DeviceAuth) { & codex login --device-auth } else { & codex login }
exit $LASTEXITCODE
