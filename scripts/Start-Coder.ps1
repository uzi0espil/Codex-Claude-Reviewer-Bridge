[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Feature,
    [string]$ProjectRoot,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$ClaudeArguments
)

. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
& (Join-Path $PSScriptRoot 'Ensure-ReviewBridge.ps1') | Out-Null

$resolvedProject = Resolve-ReviewBridgeProjectRoot $ProjectRoot
$pair = Invoke-ReviewBridge -Route '/pair/claude' -Body @{
    feature = $Feature
    projectRoot = $resolvedProject
}

$env:REVIEW_BRIDGE_FEATURE = $pair.feature
$settings = Join-Path $script:ReviewerRoot 'claude-bridge.settings.json'
if (-not (Test-Path -LiteralPath $settings)) { throw 'Claude hook settings are missing; run Setup-ReviewBridge.ps1.' }
$arguments = @('--name', $pair.displayName, '--settings', $settings)
if ($pair.claudeSessionId) {
    if ($pair.claudeSessionStarted) { $arguments += @('--resume', $pair.claudeSessionId) }
    else { $arguments += @('--session-id', $pair.claudeSessionId) }
}
$arguments += $ClaudeArguments

Push-Location $resolvedProject
try {
    & claude @arguments
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
