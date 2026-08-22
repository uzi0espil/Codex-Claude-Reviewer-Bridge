[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$EncodedArguments)

Set-StrictMode -Version Latest
$json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedArguments))
$terminalArguments = @($json | ConvertFrom-Json)
$terminal = Get-Command wt.exe -CommandType Application -ErrorAction SilentlyContinue

if ($null -ne $terminal) {
    & $terminal.Source @terminalArguments
    if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        throw "Windows Terminal exited with code $LASTEXITCODE."
    }
    exit 0
}

# Windows Terminal is optional on older Windows installations. Reuse the
# PowerShell command embedded in the terminal arguments and let conhost open it.
$directoryIndex = [Array]::IndexOf($terminalArguments, '--startingDirectory')
if ($directoryIndex -lt 0 -or $directoryIndex + 2 -ge $terminalArguments.Count) {
    throw 'The Windows terminal launch arguments are malformed.'
}
$workingDirectory = [string]$terminalArguments[$directoryIndex + 1]
$commandIndex = $directoryIndex + 2
$command = [string]$terminalArguments[$commandIndex]
$commandArguments = @($terminalArguments[($commandIndex + 1)..($terminalArguments.Count - 1)])
$argumentLine = ($commandArguments | ForEach-Object {
    $value = [string]$_
    if ($value -match '[\s"]') { '"' + $value.Replace('"', '\"') + '"' } else { $value }
}) -join ' '

Start-Process -FilePath $command -ArgumentList $argumentLine -WorkingDirectory $workingDirectory
