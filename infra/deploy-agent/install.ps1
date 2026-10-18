<#
.SYNOPSIS
  Registers the "D1 Deploy Agent" Scheduled Task on d1-server (the host-side half of the Data Studio Deploy button).

.DESCRIPTION
  The task runs `node infra/deploy-agent/agent.mjs` as the CURRENT user (not "whether or not logged on"), at logon and
  at startup, restarts it every minute if it fails (the agent exits 75 after a deploy that replaced its own file),
  and has no time limit. The agent listens on 127.0.0.1:8212 only and refuses to start without DEPLOY_AGENT_TOKEN.

  Run it from an ordinary PowerShell on d1-server. Registering a task with a startup trigger may need an elevated
  PowerShell; if it says access is denied, reopen PowerShell as Administrator (the task still runs as you).

  Usage:
    powershell -ExecutionPolicy Bypass -File infra\deploy-agent\install.ps1            # register (and start)
    powershell -ExecutionPolicy Bypass -File infra\deploy-agent\install.ps1 -Uninstall # remove the task
#>
[CmdletBinding()]
param(
  [string]$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$NodePath,
  [switch]$NoStart,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName = 'D1 Deploy Agent'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed the scheduled task '$TaskName'."
  } else {
    Write-Host "No scheduled task '$TaskName' to remove."
  }
  return
}

$agent = Join-Path $RepoDir 'infra\deploy-agent\agent.mjs'
if (-not (Test-Path -LiteralPath $agent)) { throw "agent.mjs not found at $agent. Pass -RepoDir <the live checkout>." }

if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'node was not found on PATH. Install Node 24 or pass -NodePath <full path to node.exe>.' }
  $NodePath = $cmd.Source
}
$version = & $NodePath --version
if ($version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { Write-Warning "Node $version found; the agent is written for Node 24." }

# The path contains spaces: quote it as a single argument.
$action = New-ScheduledTaskAction -Execute $NodePath -Argument ('"{0}"' -f $agent) -WorkingDirectory $RepoDir
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $user),
  (New-ScheduledTaskTrigger -AtStartup)
)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings `
  -Description 'Runs scripts/deploy/deploy.mjs for the Data Studio Deploy page. Listens on 127.0.0.1:8212.' -Force | Out-Null
Write-Host "Registered the scheduled task '$TaskName' for $user."

# The token step: the agent and the Directus container read the SAME value from .env.
$envFile = Join-Path $RepoDir '.env'
$hasToken = (Test-Path -LiteralPath $envFile) -and (Select-String -LiteralPath $envFile -Pattern '^\s*DEPLOY_AGENT_TOKEN=\S' -Quiet)
if ($hasToken) {
  Write-Host 'DEPLOY_AGENT_TOKEN is already set in .env.'
} else {
  Write-Host ''
  Write-Host 'NEXT: set a token. The agent refuses to start without one.'
  Write-Host "  1. Make one:  node -e `"console.log(require('crypto').randomBytes(32).toString('hex'))`""
  Write-Host "  2. Add this line to $envFile :   DEPLOY_AGENT_TOKEN=<that value>"
  Write-Host '  3. Recreate Directus so it gets the same token:   docker compose up -d --force-recreate directus'
  Write-Host "  4. Start the agent:   Start-ScheduledTask -TaskName '$TaskName'"
}

if (-not $NoStart -and $hasToken) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8212/health' -TimeoutSec 5
    Write-Host "Agent is up: $($r | ConvertTo-Json -Compress)"
  } catch {
    Write-Warning "The agent did not answer on 127.0.0.1:8212 yet. Check: Get-ScheduledTaskInfo -TaskName '$TaskName'"
  }
}
