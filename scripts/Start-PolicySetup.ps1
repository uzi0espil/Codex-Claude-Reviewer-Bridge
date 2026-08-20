[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$CodexArguments
)

. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
$resolvedProject = Resolve-ReviewBridgeProjectRoot $ProjectRoot
$env:CODEX_HOME = $script:ReviewerRoot

$prompt = 'Use $bridge-init-policy to inspect this application and create or refresh its private review policy and protocol.'
$arguments = @('-C', $resolvedProject, '--profile', 'bridge-review')
$arguments += $CodexArguments
$arguments += $prompt

& codex @arguments
exit $LASTEXITCODE
