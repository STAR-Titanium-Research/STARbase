<#
.SYNOPSIS
  What the "D1 Deploy Agent" Scheduled Task runs: node agent.mjs, started again at once when it exits with code 75.

.DESCRIPTION
  The agent exits 75 after a deploy that replaced agent.mjs itself, so the new code gets picked up. The Scheduled Task's
  own restart-on-failure covers every other exit, but it is not relied on for 75: this loop restarts immediately.
  Any other exit code is passed on (a missing token exits 1) so Task Scheduler's restart-every-minute applies to it.
#>
param(
  [string]$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$NodePath = 'node'
)

$agent = Join-Path $RepoDir 'infra\deploy-agent\agent.mjs'
Set-Location -LiteralPath $RepoDir
while ($true) {
  & $NodePath $agent
  $code = $LASTEXITCODE
  if ($code -ne 75) { exit $code }
  Start-Sleep -Seconds 2
}
