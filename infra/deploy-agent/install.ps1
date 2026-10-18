<#
.SYNOPSIS
  Registers the "D1 Deploy Agent" Scheduled Task on d1-server (the host-side half of the Data Studio Deploy button).

.DESCRIPTION
  The task runs `infra/deploy-agent/run-agent.ps1` (which loops `node agent.mjs` with a backoff) as the CURRENT user,
  at startup and at logon, so it also comes up after an unattended reboot with nobody logged on. It restarts on failure
  every minute and has no time limit. The agent listens on 127.0.0.1:8212 only and refuses to start without DEPLOY_AGENT_TOKEN.

  Logon type: by default S4U ("run whether the user is logged on or not", no password stored). An S4U task cannot read
  that user's saved credentials (Windows Credential Manager, DPAPI), so a `git fetch` over HTTPS that relies on the
  credential manager may fail when nobody is logged on. If the first unattended run cannot fetch, reinstall with
  -StorePassword: Task Scheduler then keeps the Windows password and the task runs with the full profile.

  Run it from an ordinary PowerShell on d1-server. Registering a task with a startup trigger may need an elevated
  PowerShell; if it says access is denied, reopen PowerShell as Administrator (the task still runs as you).

  Usage:
    powershell -ExecutionPolicy Bypass -File infra\deploy-agent\install.ps1                  # register (and start)
    powershell -ExecutionPolicy Bypass -File infra\deploy-agent\install.ps1 -StorePassword   # run with the stored Windows password
    powershell -ExecutionPolicy Bypass -File infra\deploy-agent\install.ps1 -Uninstall       # remove the task
#>
[CmdletBinding()]
param(
  [string]$RepoDir,
  [string]$NodePath,
  [switch]$NoStart,
  [switch]$StorePassword,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot is empty in a param() default under some hosts, so resolve the default here.
if (-not $RepoDir) {
  $here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
  $RepoDir = (Resolve-Path (Join-Path $here '....')).Path
}
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

# The task runs run-agent.ps1, which starts node and starts it again at once when the agent exits 75 (it replaced its own file).
# The paths contain spaces: each is one quoted argument.
$runner = Join-Path $RepoDir 'infra\deploy-agent\run-agent.ps1'
$psArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -RepoDir "{1}" -NodePath "{2}"' -f $runner, $RepoDir, $NodePath
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs -WorkingDirectory $RepoDir
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $user),
  (New-ScheduledTaskTrigger -AtStartup)
)
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew
$description = 'Runs scripts/deploy/deploy.mjs for the Data Studio Deploy page. Listens on 127.0.0.1:8212.'

if ($StorePassword) {
  # Full profile (credential manager works), runs whether or not anyone is logged on; Task Scheduler keeps the password.
  $cred = Get-Credential -UserName $user -Message 'Windows password for the D1 Deploy Agent task (kept by Task Scheduler)'
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
    -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Description $description -Force | Out-Null
  Write-Host "Registered the scheduled task '$TaskName' for $user (stored password, runs whether or not logged on)."
} else {
  # S4U: runs whether or not logged on, no password stored; no access to the user's saved network credentials.
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings `
    -Description $description -Force | Out-Null
  Write-Host "Registered the scheduled task '$TaskName' for $user (S4U, runs whether or not logged on)."
}
Write-Host ''
Write-Host 'After the FIRST unattended reboot (nobody logs on), verify:'
Write-Host '  - curl http://127.0.0.1:8212/health answers (the agent came up by itself);'
Write-Host '  - Docker Desktop is running (the deploy needs `docker compose`; set Docker Desktop to start at sign-in/boot);'
Write-Host '  - the Deploy page can run Check (git fetch works with nobody logged on). If it cannot fetch, reinstall with -StorePassword.'

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
