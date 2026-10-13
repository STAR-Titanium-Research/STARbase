<#
.SYNOPSIS
    Nightly backup of the D1 production Postgres database on d1-server.

.DESCRIPTION
    Runs pg_dump inside the running Postgres container, copies the archive out
    to a host folder, verifies the copy byte-for-byte by size, and prunes
    archives older than the retention window.

    Two artifacts are produced per run:

      d1_database-<stamp>.dump  custom-format archive of the database itself,
                                restorable with pg_restore (supports selective
                                and parallel restore).
      globals-<stamp>.sql       roles and other cluster-level objects, which a
                                per-database dump does NOT contain. Without
                                this a restore onto a fresh cluster fails on
                                missing role grants.

    The dump is written to the container's /tmp first and copied out with
    `docker cp` rather than streamed to stdout: PowerShell applies text
    encoding to redirected output, which silently corrupts binary streams.

    Credentials are never passed on the command line or logged — the script
    reads POSTGRES_USER / POSTGRES_DB from the container's own environment.

    After the local backup succeeds, both artifacts are copied off-host to the
    university filestore. The local copy protects against a bad migration or a
    corrupted volume; only the off-host copy survives losing the machine.

.PARAMETER DestinationRoot
    Folder to write archives to. Defaults to D:\D1-Backups\postgres.

.PARAMETER RetentionDays
    Archives older than this are deleted after a successful run. Defaults to 14.
    Pruning is skipped entirely if the run fails, so a broken backup job never
    eats the last good archives.

.PARAMETER Container
    Name of the Postgres container. Defaults to d1-database-postgres-1.

.PARAMETER OffsiteRoot
    UNC path on the university filestore to copy each new pair of artifacts to.
    A UNC path rather than the Z: mapping on purpose: drive letters belong to a
    logon session and a scheduled task cannot be relied on to see them. Set to
    an empty string to skip the off-host step.

.PARAMETER OffsiteRetentionDays
    Off-host archives older than this are deleted after a verified copy.
    Defaults to 5 — shorter than the local window because the share is a quota'd
    group area also holding ~26 GB of Directus uploads.

.EXAMPLE
    pwsh -File scripts\backup-postgres.ps1

.EXAMPLE
    # Local only, e.g. when off the university network
    pwsh -File scripts\backup-postgres.ps1 -OffsiteRoot ''

.NOTES
    Exit codes: 0 success; 1 the local backup failed (nothing new was written);
    2 the local backup succeeded but the off-host copy did not — the share was
    unreachable, out of quota, or the copy did not verify. Code 2 means you still
    have a good local backup but no off-host one, so it needs attention rather
    than alarm.

    Verify restorability periodically — a dump that has never been restored is
    not a backup. See docs/adr/0010 step 0. To test:

      docker exec <container> sh -c 'psql -U "$POSTGRES_USER" -d postgres \
        -c "CREATE DATABASE restore_test"'
      docker cp <archive> <container>:/tmp/t.dump
      docker exec <container> sh -c 'pg_restore -U "$POSTGRES_USER" \
        -d restore_test -j 2 /tmp/t.dump'

    then compare row counts against production and drop restore_test.
#>
[CmdletBinding()]
param(
    [string]$DestinationRoot = 'D:\D1-Backups\postgres',
    [int]$RetentionDays = 14,
    [string]$Container = 'd1-database-postgres-1',

    # Off-host copy on the university filestore. A UNC path deliberately, NOT the Z: mapping:
    # drive letters are per-logon-session and a scheduled task cannot be relied on to see them,
    # whereas the UNC resolves as long as the session has credentials for the share.
    # Set to '' to skip the off-host step entirely.
    [string]$OffsiteRoot = '\\uosfstore.shef.ac.uk\shared\star_group1\Shared\D1-Server-Backup\postgres',

    # Kept shorter than the local window: the share is a quota'd group area holding ~26 GB of
    # Directus uploads alongside these dumps, and each dump is ~1.3 GB.
    [int]$OffsiteRetentionDays = 5
)

$ErrorActionPreference = 'Stop'

$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $DestinationRoot 'backup.log'

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Output $line
    if (Test-Path $DestinationRoot) { Add-Content -Path $logFile -Value $line }
}

# Docker Desktop does not put docker.exe on the PATH of non-interactive
# scheduled tasks, so resolve it explicitly before falling back to the PATH.
function Resolve-Docker {
    $candidate = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
    if (Test-Path $candidate) { return $candidate }
    $onPath = (Get-Command docker -ErrorAction SilentlyContinue).Source
    if ($onPath) { return $onPath }
    throw 'docker.exe not found (checked Docker Desktop install path and PATH).'
}

try {
    New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
    $docker = Resolve-Docker
    Write-Log "Backup starting -> $DestinationRoot"

    # Refuse to dump a container that is not running: `docker exec` against a
    # stopped container fails in ways that are easy to mistake for an empty DB.
    $state = & $docker inspect -f '{{.State.Running}}' $Container 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Container '$Container' not found." }
    if ($state.Trim() -ne 'true') { throw "Container '$Container' is not running (State.Running=$state)." }

    # --- database archive -------------------------------------------------
    # The readers tables of migration 166 are derived data (d1_private.readers_rebuild() recomputes them): their rows are not dumped,
    # and every restore ends with readers_rebuild() and the drift check (docs/runbooks/a1-record-access-cutover.md). d1_private.hidden_records
    # IS dumped (tiny, same snapshot): the Ask-the-database role reads it through row security, so it must not be empty after a hand restore.
    $derived = '--exclude-table-data=public.sample_readers --exclude-table-data=public.operation_readers --exclude-table-data=public.test_readers --exclude-table-data=public.campaign_readers --exclude-table-data=public.project_readers --exclude-table-data=public.campaign_sample_readers --exclude-table-data=public.operation_open_to_all'
    & $docker exec $Container sh -c "pg_dump -U `"`$POSTGRES_USER`" -d `"`$POSTGRES_DB`" -Fc $derived -f /tmp/backup.dump"
    if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit $LASTEXITCODE)." }

    $srcSize = [int64](& $docker exec $Container sh -c 'stat -c %s /tmp/backup.dump').Trim()
    $dumpDest = Join-Path $DestinationRoot "d1_database-$stamp.dump"
    & $docker cp "${Container}:/tmp/backup.dump" $dumpDest
    if ($LASTEXITCODE -ne 0) { throw "docker cp failed (exit $LASTEXITCODE)." }

    $dstSize = (Get-Item $dumpDest).Length
    if ($dstSize -ne $srcSize) {
        throw "Size mismatch: container $srcSize bytes, host $dstSize bytes. Copy is not trustworthy."
    }
    Write-Log ("Database archive OK: {0} ({1:N0} bytes, {2:N1} MB)" -f (Split-Path $dumpDest -Leaf), $dstSize, ($dstSize / 1MB))

    # --- cluster globals (roles) -----------------------------------------
    $globalsDest = Join-Path $DestinationRoot "globals-$stamp.sql"
    & $docker exec $Container sh -c 'pg_dumpall -U "$POSTGRES_USER" --globals-only -f /tmp/globals.sql'
    if ($LASTEXITCODE -ne 0) { throw "pg_dumpall --globals-only failed (exit $LASTEXITCODE)." }
    & $docker cp "${Container}:/tmp/globals.sql" $globalsDest
    if ($LASTEXITCODE -ne 0) { throw "docker cp of globals failed (exit $LASTEXITCODE)." }
    Write-Log ("Globals OK: {0} ({1:N0} bytes)" -f (Split-Path $globalsDest -Leaf), (Get-Item $globalsDest).Length)

    # --- prune (only after a fully successful run) ------------------------
    $cutoff = (Get-Date).AddDays(-$RetentionDays)
    $stale = Get-ChildItem -Path $DestinationRoot -File |
             Where-Object { $_.Name -match '^(d1_database-|globals-)' -and $_.LastWriteTime -lt $cutoff }
    foreach ($f in $stale) {
        Remove-Item $f.FullName -Force
        Write-Log "Pruned $($f.Name)"
    }

    $kept = @(Get-ChildItem -Path $DestinationRoot -Filter 'd1_database-*.dump' -File)
    $totalGb = ($kept | Measure-Object -Property Length -Sum).Sum / 1GB
    Write-Log ("Local backup complete. {0} archive(s) retained, {1:N1} GB total." -f $kept.Count, $totalGb)

    # --- off-host copy ----------------------------------------------------
    # Runs last and cannot damage the local backup, which is already safely on disk and
    # pruned. A failure here is still reported (exit 2, distinct from a local failure)
    # because a silently-broken off-host copy is the failure mode that only shows up on
    # the day the machine dies.
    if ($OffsiteRoot) {
        try {
            if (-not (Test-Path $OffsiteRoot)) { New-Item -ItemType Directory -Force -Path $OffsiteRoot | Out-Null }

            foreach ($src in @($dumpDest, $globalsDest)) {
                $leaf = Split-Path $src -Leaf
                $dst  = Join-Path $OffsiteRoot $leaf
                Copy-Item -Path $src -Destination $dst -Force
                $srcLen = (Get-Item $src).Length
                $dstLen = (Get-Item $dst).Length
                if ($dstLen -ne $srcLen) {
                    throw "Off-host size mismatch for ${leaf}: local $srcLen bytes, remote $dstLen bytes."
                }
                Write-Log ("Off-host copy OK: {0} ({1:N0} bytes)" -f $leaf, $dstLen)
            }

            # Prune the share only after this run's copy verified, same rule as locally.
            $offCutoff = (Get-Date).AddDays(-$OffsiteRetentionDays)
            $offStale = Get-ChildItem -Path $OffsiteRoot -File |
                        Where-Object { $_.Name -match '^(d1_database-|globals-)' -and $_.LastWriteTime -lt $offCutoff }
            foreach ($f in $offStale) {
                Remove-Item $f.FullName -Force
                Write-Log "Off-host pruned $($f.Name)"
            }

            $offKept = @(Get-ChildItem -Path $OffsiteRoot -Filter 'd1_database-*.dump' -File)
            Write-Log ("Off-host complete. {0} archive(s) retained at {1}" -f $offKept.Count, $OffsiteRoot)
        }
        catch {
            # The share being unreachable (VPN down, credentials expired, quota full) must not
            # be mistaken for the database backup having failed — it succeeded above.
            Write-Log ("Off-host copy FAILED (local backup is intact): " + $_.Exception.Message) 'ERROR'
            exit 2
        }
    }

    exit 0
}
catch {
    Write-Log $_.Exception.Message 'ERROR'
    exit 1
}
finally {
    # Always clear the container's /tmp, including on failure — otherwise a
    # 1.3 GB file is left in the container's writable layer after every error.
    if ($docker) {
        & $docker exec $Container sh -c 'rm -f /tmp/backup.dump /tmp/globals.sql' 2>$null | Out-Null
    }
}
