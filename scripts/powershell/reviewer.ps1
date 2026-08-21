Set-StrictMode -Version Latest

$reviewerCli = Join-Path $PSScriptRoot '..\reviewer.mjs'
$forwarded = @($args | ForEach-Object {
    if ($_ -eq '--passthrough') { '--' } else { $_ }
})
& node $reviewerCli @forwarded
exit $LASTEXITCODE
