param([Parameter(Mandatory=$true)][string]$NodePath,[string]$TaskName='Roggy Local AI')
$ErrorActionPreference='Stop'
$node=(Resolve-Path -LiteralPath $NodePath).Path
$runner=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'run.ps1')).Path
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if (!(Test-Path -LiteralPath (Join-Path $repo '.env'))) { throw 'Configure .env and test the bridge before installing.' }
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'Task already exists. Update it explicitly in Task Scheduler; this installer does not overwrite tasks.' }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$credential=Get-Credential -UserName $identity -Message 'Windows stores this account credential for startup. Nothing is saved in the repository.'
if (!$credential) { throw 'Cancelled.' }
$arguments='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$runner+'" -NodePath "'+$node+'"'
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $repo
$startup=New-ScheduledTaskTrigger -AtStartup
$watchdog=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$password=$credential.GetNetworkCredential().Password
try { Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($startup,$watchdog) -Settings $settings -User $credential.UserName -Password $password -Description 'Private Roggy AI bridge. Tailscale Serve and owner Supabase authentication required.' | Out-Null }
finally { $password=$null; $credential=$null }
Start-ScheduledTask -TaskName $TaskName
Write-Output 'Installed Roggy Local AI. Check logs/ and Task Scheduler. Ollama and Tailscale must also be running.'
