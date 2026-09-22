param([Parameter(Mandatory=$true)][string]$NodePath,[string]$TaskName='Roggy Personal Monitor')
$ErrorActionPreference='Stop'
$node=(Resolve-Path -LiteralPath $NodePath).Path
$runner=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'run.ps1')).Path
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if (!(Test-Path -LiteralPath (Join-Path $repo '.env'))) { throw 'Complete .env and OAuth setup before installing.' }
# Password logon permits network and DPAPI access before interactive sign-in.
# Credentials are handed directly to Windows Task Scheduler, never written to files.
$credential=Get-Credential -UserName ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -Message 'Use the SAME Windows account that authorized Google. Windows stores this task credential securely.'
if (!$credential) { throw 'Task credential entry cancelled.' }
$arguments='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$runner+'" -NodePath "'+$node+'"'
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $repo
$startup=New-ScheduledTaskTrigger -AtStartup
$watchdog=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$password=$credential.GetNetworkCredential().Password
try {
 Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($startup,$watchdog) -Settings $settings -User $credential.UserName -Password $password -Description 'Read-only personal monitoring worker; Supabase stores durable jobs.' -Force | Out-Null
} finally { $password=$null;$credential=$null }
Start-ScheduledTask -TaskName $TaskName
Write-Output 'Installed and started. Inspect logs/ and Task Scheduler Last Run Result.'
