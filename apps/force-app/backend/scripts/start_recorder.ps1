# Idempotently starts the force-app recording backend (uvicorn, port 8200) if it isn't already
# listening. Safe to run repeatedly - a no-op if the backend is already up. This is what the
# "ForceAppRecorderBackend" scheduled task (install_autostart.ps1) calls at logon and every few
# minutes afterward, so a crashed backend gets relaunched without anyone noticing.
#
# Run manually any time you just want to start it right now:
#   powershell -ExecutionPolicy Bypass -File .\start_recorder.ps1

$Port = 8200
$BackendDir = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $BackendDir "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$OutLog = Join-Path $LogDir "recorder-backend.out.log"
$ErrLog = Join-Path $LogDir "recorder-backend.err.log"

function Test-PortOpen([int]$port) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect("127.0.0.1", $port)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

if (Test-PortOpen $Port) {
    Write-Host "Recorder backend already running on port $Port - nothing to do."
    exit 0
}

Write-Host "Starting recorder backend on port $Port (logs: $LogDir)..."
$procArgs = @{
    FilePath               = "python"
    ArgumentList           = @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "$Port")
    WorkingDirectory       = $BackendDir
    WindowStyle            = "Hidden"
    RedirectStandardOutput = $OutLog
    RedirectStandardError  = $ErrLog
}
Start-Process @procArgs
