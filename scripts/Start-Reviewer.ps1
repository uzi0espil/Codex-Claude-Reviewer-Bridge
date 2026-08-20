[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Prompt,
    [string]$Feature,
    [ValidateSet('off', 'manual', 'once', 'auto')][string]$Profile,
    [switch]$Resume,
    [switch]$Last,
    [string]$Session,
    [string]$ProjectRoot,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$CodexArguments
)

. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
$resolvedProject = Resolve-ReviewBridgeProjectRoot $ProjectRoot
if (-not (Test-Path -LiteralPath (Join-Path $resolvedProject '.git'))) {
    throw "ProjectRoot is not a Git repository: $resolvedProject"
}

$resumeSelectors = @(@([bool]$Resume, [bool]$Last, [bool]$Session) | Where-Object { $_ })
if ($resumeSelectors.Count -gt 1) { throw 'Use only one of -Resume, -Last, or -Session.' }
if ($Resume -and $Prompt) { throw 'The session picker cannot accept an initial prompt.' }
if ($Feature -and ($Resume -or $Last -or $Session -or $Prompt)) {
    throw 'Paired mode uses the stored feature mapping; do not combine -Feature with another session selector or prompt.'
}

$env:CODEX_HOME = $script:ReviewerRoot
$launchArguments = @()
if ($Feature) {
    & (Join-Path $PSScriptRoot 'Ensure-ReviewBridge.ps1') | Out-Null
    $pair = Invoke-ReviewBridge -Route '/pair/codex' -Body @{ feature = $Feature; projectRoot = $resolvedProject }
    if ($PSBoundParameters.ContainsKey('Profile')) {
        $pair = Invoke-ReviewBridge -Route '/mode' -Body @{ feature = $pair.feature; mode = $Profile }
    } else {
        $Profile = $pair.mode
    }
    $launchArguments += @('--remote', $pair.appServerUrl, 'resume', $pair.codexThreadId, '-C', $resolvedProject, '--profile', "bridge-$Profile")
} elseif ($Session) {
    $launchArguments += @('resume', $Session, '-C', $resolvedProject)
} elseif ($Last) {
    $launchArguments += @('resume', '--last', '-C', $resolvedProject)
} elseif ($Resume) {
    $launchArguments += @('resume', '-C', $resolvedProject)
} else {
    $launchArguments += @('-C', $resolvedProject)
}

$launchArguments += $CodexArguments
if ($Prompt) { $launchArguments += $Prompt }
& codex @launchArguments
exit $LASTEXITCODE
