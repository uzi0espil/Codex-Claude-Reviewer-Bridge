[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Feature,
    [ValidateSet('off', 'manual', 'once', 'auto')][string]$Profile,
    [string]$ProjectRoot,
    [string[]]$ClaudeArguments
)

. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
$resolvedProject = Resolve-ReviewBridgeProjectRoot $ProjectRoot
if (-not (Test-ReviewBridgePolicyInitialized)) {
    Write-Warning "No application-specific review policy exists. The generic baseline will be used. Run '$script:ReviewerRoot\scripts\Start-PolicySetup.ps1' to create one."
}

function ConvertTo-ChildProcessArgument {
    param([AllowEmptyString()][string]$Value)
    if ($Value -and $Value -notmatch '[\s"]') { return $Value }
    return '"' + $Value.Replace('"', '\"') + '"'
}

$coder = Join-Path $PSScriptRoot 'Start-Coder.ps1'
$reviewer = Join-Path $PSScriptRoot 'Start-Reviewer.ps1'
$coderArgs = @('-NoProfile', '-NoExit', '-File', "`"$coder`"", '-Feature', "`"$Feature`"", '-ProjectRoot', "`"$resolvedProject`"")
$reviewerArgs = @('-NoProfile', '-NoExit', '-File', "`"$reviewer`"", '-Feature', "`"$Feature`"", '-ProjectRoot', "`"$resolvedProject`"")
if ($ClaudeArguments) { $coderArgs += @($ClaudeArguments | ForEach-Object { ConvertTo-ChildProcessArgument $_ }) }
if ($PSBoundParameters.ContainsKey('Profile')) { $reviewerArgs += @('-Profile', $Profile) }

Start-Process -FilePath 'powershell.exe' -ArgumentList $coderArgs -WorkingDirectory $resolvedProject
Start-Process -FilePath 'powershell.exe' -ArgumentList $reviewerArgs -WorkingDirectory $resolvedProject
Write-Host "Opened paired Claude and Codex terminals for '$Feature'."
