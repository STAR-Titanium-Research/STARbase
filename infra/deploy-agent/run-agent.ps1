<#
.SYNOPSIS
  What the "D1 Deploy Agent" Scheduled Task runs: node agent.mjs, started again whenever it exits.

.DESCRIPTION
  Loops on EVERY exit code, so the agent comes back even if Task Scheduler's own restart-on-failure does not fire for a
  process that launched and then died.
    - exit code 75 (the agent replaced its own file after a deploy): restart at once;
    - any other exit (a crash; a missing token exits 1): wait, then restart, the wait doubling from 2 s up to 60 s;
      the wait goes back to 2 s once an instance has stayed up for 5 minutes.
  Stop the task to stop the loop (Stop-ScheduledTask ends this script and its children).
  The parameters below exist so the loop can be tested quickly; the defaults are the real ones.
#>
param(
  [string]$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$NodePath = 'node',
  [double]$InitialDelaySeconds = 2,
  [double]$MaxDelaySeconds = 60,
  [double]$ResetAfterSeconds = 300,
  [int]$MaxRestarts = 0   # 0 = forever
)

$agent = Join-Path $RepoDir 'infra\deploy-agent\agent.mjs'
Set-Location -LiteralPath $RepoDir
$delay = $InitialDelaySeconds
$restarts = 0
while ($true) {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  & $NodePath $agent
  $code = $LASTEXITCODE
  $restarts++
  if ($MaxRestarts -gt 0 -and $restarts -ge $MaxRestarts) { exit $code }
  if ($code -eq 75) {
    Write-Host 'agent exited 75 (it replaced itself): restarting now'
    $delay = $InitialDelaySeconds
    continue
  }
  if ($clock.Elapsed.TotalSeconds -ge $ResetAfterSeconds) { $delay = $InitialDelaySeconds }
  Write-Host "agent exited $code after $([int]$clock.Elapsed.TotalSeconds) s: restarting in $delay s"
  Start-Sleep -Milliseconds ([int]($delay * 1000))
  $delay = [Math]::Min($delay * 2, $MaxDelaySeconds)
}
