# DEFORM batch queue on d1-server (and "SimClient.EXE wasn't found" on a remote PC)

What this covers: how DEFORM 14.1 runs jobs "Batch (D1-Server)" from a PC over Tailscale, what lives where, and the error
`CHECK_BQ_SERVER_ACTIVE: SimClient.EXE wasn't found in the Configuration folder`. Written 2026-10-21 from the server's own
files and processes; **what is confirmed and what is a hypothesis is marked**. Nothing here was changed on the server.

## The pieces (confirmed on d1-server)

| Piece | Where / port | Notes |
|---|---|---|
| License server (`DeformLicenseServer`, `LicenseServer.EXE`) | `C:\Program Files\SFTC\License Manager`, port **34445** | FlexNet log: `License Manager\log\Flexlog0.log` |
| Batch queue (`DeformBatchQueue`, `BatchQueue.EXE`) | same folder, port **34446** | job lists in `BQData\Active` and `BQData\History` |
| Service control (`DeformServiceControl`, `DEF_SC.EXE`) | `C:\Program Files\SFTC\DEFORM\Configuration`, ports 8000 and 34448 | started automatically |
| Simulation server (`SimServer.EXE`) | `DEFORM\Configuration`, port **34447**, 32 processors, **1 job at a time**, version 14.1 | runs the queued jobs |
| Simulation client (`SimClient.EXE`) | `DEFORM\Configuration\SimClient.EXE` (1.93 MB) and `License Manager\modules\windows\SimClient.EXE` (same size); Linux builds under `modules\centos*`, `rhel8`, `suse` | the program that talks to the queue and the simulation server |
| The one configuration file | `License Manager\DEFORM_NLM_CONF_LMSERVER` (address of the license server, the batch queue and the simulation server) | dated backups sit next to it (`.bak-YYYYMMDD-...`) |
| Setup | `License Manager\DEFORMSetup.EXE` | installs/updates the client side of a PC |

The server's Tailscale name and address: `d1-server` / `100.78.168.15` (tags `server`, `license-client`, `rdp`). A PC's firewall
rules for DEFORM are per program (`Allow, any port`), not per port.

## The error

`Run Options` → Batch (D1-Server) → **Submit to Queue** on a remote PC shows:

> CHECK_BQ_SERVER_ACTIVE: SimClient.EXE wasn't found in the Configuration folder. Open DEFORM Setup to download and run the Simulation Client.

**Meaning (from the message itself):** before submitting, DEFORM asks the Simulation Client on **that PC** whether the batch-queue
server is active. The file `SimClient.EXE` is missing from **that PC's** DEFORM `Configuration` folder, so the check cannot run.
It is not a network error: the same PC can check the licence and sync with the server, which need only the licence/queue ports.

**Most likely cause (hypothesis, consistent with everything above):** the PC was set up as a licence client only; the Simulation
Client was never downloaded there.

**Fix, on the remote PC:** run **DEFORM Setup** (from the PC's DEFORM install, or the copy in the server's `License Manager`
folder) and use its Simulation Client download/run step as the dialog says; then confirm
`<DEFORM install>\Configuration\SimClient.EXE` exists and retry **Submit to Queue**. The file on the server is the reference
(1,934,136 bytes, 10 Jun 2025 build in `modules\windows`).

If it still fails after the file is there, check in this order: (1) the PC's DEFORM configuration names the server as
`d1-server` / `100.78.168.15`, not another address; (2) `tailscale ping d1-server` from the PC; (3) the server's
`DeformBatchQueue` service is running (`Get-Service Deform*`); (4) `BQData\Active` on the server shows the job.

## Warning: the server's own configuration file points at an address that is not on the tailnet

On 2026-10-21 `DEFORM_NLM_CONF_LMSERVER` (changed 2026-10-19 15:36) says

```
ServerAddress=100.75.167.127
BatchQueueAddress0=100.75.167.127
```

while the 2026-10-16 backup said `100.78.168.15`, **which is d1-server's current Tailscale address**; `tailscale whois
100.75.167.127` answers "peer not found" (no such device on the tailnet). The running `SimServer` and `DEF_SC` were started on
2026-10-16 14:47, before the change, so they still run on what they read then (inference: they read the file at start).
**Risk:** the next restart of the DEFORM services, or a PC that copies this file, would look for a server that does not exist.
Not changed here; whoever edited it on 19 Oct should confirm the address. If it was meant to be the server's old address, put
`100.78.168.15` back (keep a dated `.bak` as before) and restart the three Deform services.

## Not checked

The remote PC itself (nothing was run there), DEFORM's own documentation (the vendor's manual is not in the repository and a web
search found nothing for `SimClient.EXE`), and whether the PC's DEFORM Setup can reach the `License Manager` folder it downloads from.
