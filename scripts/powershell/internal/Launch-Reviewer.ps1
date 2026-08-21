[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$EncodedArguments)

Set-StrictMode -Version Latest
$reviewerCli = Join-Path $PSScriptRoot '..\..\reviewer.mjs'
$json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedArguments))
$arguments = @($json | ConvertFrom-Json)
& node $reviewerCli @arguments
