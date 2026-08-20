[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
if (-not (Test-ReviewBridge)) {
    Write-Host 'The review bridge is not running.'
    return
}

$endpoint = Get-ReviewBridgeEndpoint
$process = Get-Process -Id ([int]$endpoint.pid) -ErrorAction SilentlyContinue
if ($process -and $process.ProcessName -eq 'node') {
    Stop-Process -Id $process.Id
    $null = $process.WaitForExit(5000)
    if (Test-Path -LiteralPath $script:BridgeEndpointPath) {
        Remove-Item -LiteralPath $script:BridgeEndpointPath -Force
    }
    Write-Host "Stopped review bridge process $($process.Id)."
} else {
    throw 'The recorded bridge PID is not a running Node process; refusing to stop it.'
}
