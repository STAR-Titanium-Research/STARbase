# Run on d1-server after a `force-app-v*` tag's CI build finishes. Pulls that release's installer
# + latest.yml from GitHub (d1-server has outbound internet; this avoids putting a
# tailnet-reaching credential in GitHub Actions secrets) and drops them into the Caddy-served
# update feed at infra/force-app-updates/. electron-updater needs BOTH files present — the
# installer without latest.yml is invisible to clients.
#
# Requires: `gh auth login` has been run once on this machine.
#
# Run:
#   powershell -ExecutionPolicy Bypass -File .\publish-release.ps1 -Tag force-app-v0.1.0

param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [string]$Repo = 'STAR-Titanium-Research/STARbase'
)
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$RepoRoot = (Get-Item $ScriptDir).Parent.Parent.Parent.Parent.FullName
$FeedDir = Join-Path $RepoRoot 'infra\force-app-updates'

New-Item -ItemType Directory -Force -Path $FeedDir | Out-Null

Write-Host "Fetching release assets for $Tag from $Repo..."
gh release download $Tag --repo $Repo --dir $FeedDir --clobber
if ($LASTEXITCODE -ne 0) { throw "gh release download failed (exit $LASTEXITCODE)." }

$latestYml = Join-Path $FeedDir 'latest.yml'
if (-not (Test-Path $latestYml)) {
    throw "latest.yml is missing from the downloaded assets - electron-updater will not see this release."
}

Write-Host "Published $Tag to $FeedDir"
Get-ChildItem $FeedDir | Format-Table Name, Length, LastWriteTime
