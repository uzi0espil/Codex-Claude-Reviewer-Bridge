Set-StrictMode -Version Latest

$script:ReviewerRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:BridgeEndpointPath = Join-Path $script:ReviewerRoot 'runtime\endpoint.json'
$script:BridgeLocalConfigPath = Join-Path $script:ReviewerRoot 'bridge.local.json'
$script:ReviewPolicyLocalPath = Join-Path $script:ReviewerRoot 'review-policy.local.md'

function Get-ReviewBridgeLocalConfig {
    if (-not (Test-Path -LiteralPath $script:BridgeLocalConfigPath)) {
        throw "Bridge configuration is missing. Run $script:ReviewerRoot\scripts\Setup-ReviewBridge.ps1 first."
    }
    Get-Content -Raw -LiteralPath $script:BridgeLocalConfigPath | ConvertFrom-Json
}

function Resolve-ReviewBridgeProjectRoot {
    param([string]$ProjectRoot)
    $config = Get-ReviewBridgeLocalConfig
    $boundProject = (Resolve-Path -LiteralPath $config.projectRoot).Path
    if (-not $ProjectRoot) { return $boundProject }

    $requestedProject = (Resolve-Path -LiteralPath $ProjectRoot).Path
    if (-not [string]::Equals($boundProject, $requestedProject, [StringComparison]::OrdinalIgnoreCase)) {
        throw "This reviewer instance is permanently bound to '$boundProject', not '$requestedProject'. Create a separate reviewer instance for the other repository."
    }
    return $boundProject
}

function Test-ReviewBridgePolicyInitialized {
    Test-Path -LiteralPath $script:ReviewPolicyLocalPath -PathType Leaf
}

function Get-ReviewBridgeEndpoint {
    if (-not (Test-Path -LiteralPath $script:BridgeEndpointPath)) {
        throw 'The review bridge is not running.'
    }
    Get-Content -Raw -LiteralPath $script:BridgeEndpointPath | ConvertFrom-Json
}

function Invoke-ReviewBridge {
    param(
        [Parameter(Mandatory = $true)][string]$Route,
        [Parameter(Mandatory = $true)][hashtable]$Body
    )
    $endpoint = Get-ReviewBridgeEndpoint
    $headers = @{ Authorization = "Bearer $($endpoint.token)" }
    Invoke-RestMethod -Method Post -Uri "$($endpoint.url)$Route" -Headers $headers `
        -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 12 -Compress)
}

function Test-ReviewBridge {
    try {
        $endpoint = Get-ReviewBridgeEndpoint
        $result = Invoke-RestMethod -Method Get -Uri "$($endpoint.url)/health" -TimeoutSec 2
        return [bool]$result.ok
    } catch {
        return $false
    }
}
