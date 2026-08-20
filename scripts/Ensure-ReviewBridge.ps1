[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')

$sha = [System.Security.Cryptography.SHA256]::Create()
try {
    $rootBytes = [System.Text.Encoding]::UTF8.GetBytes($script:ReviewerRoot.ToLowerInvariant())
    $hash = ([System.BitConverter]::ToString($sha.ComputeHash($rootBytes))).Replace('-', '').Substring(0, 16)
} finally {
    $sha.Dispose()
}

$mutex = [System.Threading.Mutex]::new($false, "Local\ClaudeCodexReviewBridge.$hash")
$lockTaken = $false
try {
    try {
        $lockTaken = $mutex.WaitOne([TimeSpan]::FromSeconds(30))
    } catch [System.Threading.AbandonedMutexException] {
        $lockTaken = $true
    }
    if (-not $lockTaken) { throw 'Timed out waiting for another bridge startup to finish.' }

    if (Test-ReviewBridge) {
        Get-ReviewBridgeEndpoint
        return
    }

    $broker = Join-Path $script:ReviewerRoot 'dist\broker.js'
    if (-not (Test-Path -LiteralPath $broker)) {
        throw "Bridge has not been built. Run $script:ReviewerRoot\scripts\Setup-ReviewBridge.ps1 first."
    }

    $runtime = Join-Path $script:ReviewerRoot 'runtime'
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null
    if (Test-Path -LiteralPath $script:BridgeEndpointPath) {
        Remove-Item -LiteralPath $script:BridgeEndpointPath -Force
    }

    $node = (Get-Command node.exe -ErrorAction Stop).Source
    Start-Process -FilePath $node -ArgumentList @($broker) -WorkingDirectory $script:ReviewerRoot -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
        if (Test-ReviewBridge) {
            Get-ReviewBridgeEndpoint
            return
        }
    }

    $log = Join-Path $runtime 'bridge.log'
    $detail = if (Test-Path -LiteralPath $log) { Get-Content -Tail 20 -LiteralPath $log | Out-String } else { 'No bridge log was produced.' }
    throw "The review bridge did not start.`n$detail"
} finally {
    if ($lockTaken) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
