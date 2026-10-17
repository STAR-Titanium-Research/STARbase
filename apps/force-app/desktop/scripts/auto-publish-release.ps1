# Polls GitHub for the latest published force-app-v* release and publishes it to the
# Caddy-served update feed the moment a new one appears -- automates what publish-release.ps1
# used to require a human to run by hand after every CI build. Same pull-based trust model as
# that script (this machine has outbound internet and its own `gh auth login`; no
# tailnet-reaching credential is added to GitHub Actions -- see publish-release.ps1's header).
#
# Meant to run every few minutes via a Windows Scheduled Task -- see
# install-auto-publish-task.ps1, which registers exactly that. Safe to run concurrently or
# on a tight schedule: it only acts when the latest release's tag differs from the one
# recorded in the marker file, and publish-release.ps1's own `gh release download --clobber`
# is idempotent for a re-publish of the same tag.
#
# Requires: `gh auth login` has been run once on this machine (same precondition as
# publish-release.ps1, which this script calls).
#
# Manual run (normally invoked by the scheduled task, not by hand):
#   powershell -ExecutionPolicy Bypass -File .\auto-publish-release.ps1

param(
    [string]$Repo = 'STAR-Titanium-Research/STARbase',
    [string]$Prefix = 'force-app-v'
)
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$RepoRoot = (Get-Item $ScriptDir).Parent.Parent.Parent.Parent.FullName
$FeedDir = Join-Path $RepoRoot 'infra\force-app-updates'
$MarkerPath = Join-Path $FeedDir '.published-tag'
$LogPath = Join-Path $FeedDir 'auto-publish.log'

New-Item -ItemType Directory -Force -Path $FeedDir | Out-Null

function Write-Log([string]$Message) {
    $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $Message
    Add-Content -Path $LogPath -Value $line
    # Also to the Scheduled Task's own captured output, for `Get-ScheduledTaskInfo`/Task
    # Scheduler's History tab without needing to open the log file.
    Write-Host $line
}

try {
    # gh release list already excludes drafts by default; isPrerelease is filtered explicitly
    # since a prerelease tag is not something field rigs should silently auto-update onto.
    $releases = gh release list --repo $Repo --limit 30 --json tagName,isDraft,isPrerelease,publishedAt |
        ConvertFrom-Json
    $candidate = $releases |
        Where-Object { -not $_.isDraft -and -not $_.isPrerelease -and $_.tagName -like "$Prefix*" } |
        Sort-Object -Property publishedAt -Descending |
        Select-Object -First 1

    if (-not $candidate) {
        Write-Log "no published $Prefix* release found on $Repo -- nothing to do"
        exit 0
    }
    $tag = $candidate.tagName

    $published = if (Test-Path $MarkerPath) { (Get-Content $MarkerPath -Raw).Trim() } else { $null }
    if ($tag -eq $published) {
        exit 0   # already current -- the steady-state case on every poll; no log spam
    }

    $prevLabel = if ($published) { $published } else { '<none>' }
    Write-Log "new release detected: $tag (feed currently has: $prevLabel) -- publishing"
    & (Join-Path $ScriptDir 'publish-release.ps1') -Tag $tag -Repo $Repo

    Set-Content -Path $MarkerPath -Value $tag
    Write-Log "published $tag to $FeedDir"
} catch {
    Write-Log "ERROR: $_"
    throw
}
