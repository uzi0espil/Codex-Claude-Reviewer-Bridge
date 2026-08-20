Set-StrictMode -Version Latest

$script:ReviewerRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:BridgeEndpointPath = Join-Path $script:ReviewerRoot 'runtime\endpoint.json'
$script:BridgeLocalConfigPath = Join-Path $script:ReviewerRoot 'bridge.local.json'

function Get-ReviewBridgeLocalConfig {
    if (-not (Test-Path -LiteralPath $script:BridgeLocalConfigPath)) {
        throw "Bridge configuration is missing. Run $script:ReviewerRoot\scripts\Setup-ReviewBridge.ps1 first."
    }
    Get-Content -Raw -LiteralPath $script:BridgeLocalConfigPath | ConvertFrom-Json
}

function Resolve-ReviewBridgeProjectRoot {
    param([string]$ProjectRoot)
    $candidate = if ($ProjectRoot) { $ProjectRoot } else { (Get-ReviewBridgeLocalConfig).projectRoot }
    (Resolve-Path -LiteralPath $candidate).Path
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
