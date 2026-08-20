[CmdletBinding()]
param([string]$Ref)

. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
$config = Get-ReviewBridgeLocalConfig
$resolvedProject = Resolve-ReviewBridgeProjectRoot

$dirtyTracked = @(& git -C $script:ReviewerRoot status --porcelain --untracked-files=no)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the reviewer instance worktree.' }
if ($dirtyTracked.Count -gt 0) {
    throw 'Tracked reviewer files have local changes. Commit or resolve them before updating; the updater will not overwrite them.'
}

$beforeCommit = (& git -C $script:ReviewerRoot rev-parse HEAD).Trim()
$beforePackage = Get-Content -Raw -LiteralPath (Join-Path $script:ReviewerRoot 'package.json') | ConvertFrom-Json

& git -C $script:ReviewerRoot fetch --prune origin
if ($LASTEXITCODE -ne 0) { throw 'Could not fetch bridge updates from origin.' }

$targetRef = $Ref
if (-not $targetRef) {
    $targetRef = (& git -C $script:ReviewerRoot rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>$null).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $targetRef) {
        throw 'The current branch has no upstream. Pass -Ref explicitly.'
    }
}

& git -C $script:ReviewerRoot merge --ff-only $targetRef
if ($LASTEXITCODE -ne 0) {
    throw "The update from '$targetRef' was not a fast-forward. No destructive recovery was attempted."
}

$playwrightEnabled = $true
if ($config.PSObject.Properties.Name -contains 'playwrightEnabled') {
    $playwrightEnabled = [bool]$config.playwrightEnabled
}
$setupArguments = @{
    ProjectRoot = $resolvedProject
    ProjectName = $config.projectName
}
if (-not $playwrightEnabled) { $setupArguments['SkipPlaywright'] = $true }
& (Join-Path $script:ReviewerRoot 'scripts\Setup-ReviewBridge.ps1') @setupArguments
if ($LASTEXITCODE -ne 0) {
    throw 'Bridge files were updated, but setup or validation failed. Fix the reported issue and rerun Setup-ReviewBridge.ps1; no rollback was attempted.'
}

$afterCommit = (& git -C $script:ReviewerRoot rev-parse HEAD).Trim()
$afterPackage = Get-Content -Raw -LiteralPath (Join-Path $script:ReviewerRoot 'package.json') | ConvertFrom-Json
Write-Host "Reviewer instance updated: $beforeCommit -> $afterCommit"
Write-Host "Bridge package version: $($beforePackage.version) -> $($afterPackage.version)"
