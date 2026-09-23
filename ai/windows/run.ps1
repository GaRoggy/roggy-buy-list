param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $repo
$logDirectory=Join-Path $repo 'logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
# Logs contain only request IDs, timings and allowlisted error codes.
& $NodePath '--env-file=.env' 'ai/bridge/server.mjs' *> (Join-Path $logDirectory ('ai-'+(Get-Date -Format 'yyyy-MM-dd-HHmmss')+'.log'))
exit $LASTEXITCODE
