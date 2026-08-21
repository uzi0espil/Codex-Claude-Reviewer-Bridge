Set-StrictMode -Version Latest
# Safely invokes Windows .cmd/.bat tools without flattening their arguments.
# Internal adapter; use reviewer.ps1 for public commands.

$arguments = @()
if ($env:REVIEWER_EXTERNAL_ARGUMENTS) {
    $parsed = $env:REVIEWER_EXTERNAL_ARGUMENTS | ConvertFrom-Json
    if ($null -ne $parsed) { $arguments = @($parsed) }
}
& $env:REVIEWER_EXTERNAL_COMMAND @arguments
exit $LASTEXITCODE
