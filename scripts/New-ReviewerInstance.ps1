[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$Destination,
    [string]$ProjectName,
    [switch]$SkipPlaywright,
    [switch]$DeviceAuth,
    [string]$TemplateRepository
)

Set-StrictMode -Version Latest
$factoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Get-CanonicalPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    [System.IO.Path]::GetFullPath($Path).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
}

function Test-IsSameOrDescendant {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Parent
    )
    $candidatePath = Get-CanonicalPath $Candidate
    $parentPath = Get-CanonicalPath $Parent
    if ([string]::Equals($candidatePath, $parentPath, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    $prefix = $parentPath + [System.IO.Path]::DirectorySeparatorChar
    return $candidatePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Required command 'git' was not found on PATH."
}

$resolvedProject = (Resolve-Path -LiteralPath $ProjectRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $resolvedProject '.git'))) {
    throw "ProjectRoot is not a Git repository: $resolvedProject"
}
if (-not $ProjectName) { $ProjectName = Split-Path -Leaf $resolvedProject }

if (-not $Destination) {
    $projectParent = Split-Path -Parent $resolvedProject
    $Destination = Join-Path $projectParent "$(Split-Path -Leaf $resolvedProject)-reviewer"
}
$resolvedDestination = Get-CanonicalPath $Destination
if (Test-IsSameOrDescendant $resolvedDestination $resolvedProject) {
    throw "The reviewer instance must live outside the target repository. Choose a sibling destination instead of '$resolvedDestination'."
}
if (Test-Path -LiteralPath $resolvedDestination) {
    $existingItem = Get-Item -LiteralPath $resolvedDestination
    if (-not $existingItem.PSIsContainer) { throw "Destination is not a directory: $resolvedDestination" }
    if (Get-ChildItem -LiteralPath $resolvedDestination -Force | Select-Object -First 1) {
        throw "Destination must be absent or empty: $resolvedDestination"
    }
}

if (-not $PSBoundParameters.ContainsKey('TemplateRepository')) {
    $factoryChanges = @(& git -C $factoryRoot status --porcelain)
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the factory checkout.' }
    if ($factoryChanges.Count -gt 0) {
        throw 'The factory checkout has uncommitted or untracked changes. Commit and push the template before generating an instance, so the clone cannot silently receive an older workflow.'
    }

    $TemplateRepository = (& git -C $factoryRoot remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $TemplateRepository) {
        $TemplateRepository = 'https://github.com/uzi0espil/Codex-Claude-Reviewer-Bridge.git'
    } else {
        & git -C $factoryRoot fetch --prune origin
        if ($LASTEXITCODE -ne 0) { throw 'Could not refresh the factory origin before creating an instance.' }
        $factoryUpstream = (& git -C $factoryRoot rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>$null).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $factoryUpstream) {
            throw 'The factory branch has no upstream. Push it or pass -TemplateRepository explicitly.'
        }
        $factoryHead = (& git -C $factoryRoot rev-parse HEAD).Trim()
        $publishedHead = (& git -C $factoryRoot rev-parse $factoryUpstream).Trim()
        if ($factoryHead -ne $publishedHead) {
            throw "The factory checkout is not synchronized with '$factoryUpstream'. Push local commits or update the checkout before generating an instance."
        }
    }
}

Write-Host "Creating isolated reviewer instance at $resolvedDestination"
& git clone -- $TemplateRepository $resolvedDestination
if ($LASTEXITCODE -ne 0) { throw 'Could not clone the reviewer template.' }

$requiredTemplateFiles = @(
    'scripts\Start-PolicySetup.ps1',
    'scripts\Update-ReviewerInstance.ps1',
    'skills\bridge-init-policy\SKILL.md'
)
$missingTemplateFiles = @($requiredTemplateFiles | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $resolvedDestination $_) -PathType Leaf)
})
if ($missingTemplateFiles.Count -gt 0) {
    throw "The cloned template is incompatible with the isolated-instance workflow and is missing: $($missingTemplateFiles -join ', '). Update or publish the template, then create a new destination. Setup and login were not started."
}

$setup = Join-Path $resolvedDestination 'scripts\Setup-ReviewBridge.ps1'
$setupArguments = @{
    ProjectRoot = $resolvedProject
    ProjectName = $ProjectName
}
if ($SkipPlaywright) { $setupArguments['SkipPlaywright'] = $true }
& $setup @setupArguments
if ($LASTEXITCODE -ne 0) { throw "Instance creation stopped during setup. Resume from $resolvedDestination after resolving the reported error." }

$initialize = Join-Path $resolvedDestination 'scripts\Initialize-Reviewer.ps1'
$initializeArguments = @('-NoProfile', '-File', $initialize)
if ($DeviceAuth) { $initializeArguments += '-DeviceAuth' }
& powershell.exe @initializeArguments
if ($LASTEXITCODE -ne 0) { throw "Instance creation stopped during Codex authentication. Re-run $initialize after resolving the reported error." }

Write-Host 'Starting the Codex-guided review policy workflow.'
$policySetup = Join-Path $resolvedDestination 'scripts\Start-PolicySetup.ps1'
& powershell.exe -NoProfile -File $policySetup
exit $LASTEXITCODE
