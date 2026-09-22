param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference='Stop'
$repoPath=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $repoPath
if (!(Test-Path -LiteralPath '.env')) { throw 'Create the worker .env file first.' }
& $NodePath --env-file=.env monitor/worker.mjs
exit $LASTEXITCODE
