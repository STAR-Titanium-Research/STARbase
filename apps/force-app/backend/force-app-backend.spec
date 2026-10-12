# PyInstaller spec for the frozen recorder backend. One-folder mode (not --onefile): a one-file
# build re-extracts ~200 MB of scipy/numpy to a temp dir on every launch, which is slow and a
# reliable antivirus trigger — see
# docs/superpowers/specs/2026-08-10-force-app-desktop-packaging-design.md.
#
# Build with: pyinstaller force-app-backend.spec --noconfirm

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
    copy_metadata,
)

# "app" must be an explicit hidden import: run_frozen.py hands uvicorn the string "app.main:app"
# rather than importing the module directly, so PyInstaller's static analysis (which only traces
# imports actually executed in run_frozen.py) never discovers the app package on its own and
# leaves it out of the bundle, producing "ModuleNotFoundError: No module named 'app'" at runtime.
hidden_imports = collect_submodules("uvicorn") + collect_submodules("scipy") + collect_submodules("app")
datas = []
binaries = []

# Rig test requests (app/rig_test/catalog.py) resolve backlog item ids against catalog.md, the copy
# of docs/runbooks/physical-test-backlog.md that was current at build time. The copy lands in the
# gitignored build/ folder (nothing extra is committed) and is read from next to catalog.py when
# frozen. SPECPATH is the folder holding this spec. Done here, not in build_frozen.ps1, because
# the release workflow calls pyinstaller on this spec directly.
import os  # noqa: E402
import runpy  # noqa: E402

_sync = runpy.run_path(os.path.join(SPECPATH, "scripts", "sync_rig_catalog.py"))["sync"]
datas += [(str(_sync(os.path.join(SPECPATH, "build", "rig_test"))), "app/rig_test")]

# h5py writes the MATLAB v7.3 .mat for long cuts (app/mat73.py, #194). It is imported lazily,
# inside Mat73Writer.__init__, so a broken h5py/HDF5 install cannot stop the backend starting; the
# static trace may therefore miss it, and its compiled extensions (h5py.defs,
# h5py._conv, ... ) are loaded by name and h5py ships HDF5 itself as a bundled library (hdf5.dll
# and friends on Windows, h5py.libs/ elsewhere): collect both explicitly rather than rely on the
# static trace, because a frozen build that lacks them only loses the .mat of a >1.5 GB cut (finalize
# records why in summary.json's mat_skip_reason) instead of failing at startup.
hidden_imports += collect_submodules("h5py")
binaries += collect_dynamic_libs("h5py")
datas += collect_data_files("h5py")

# nidaqmx is only installed where the acquisition extra is (`pip install -e ".[nidaq]"`); don't
# force it as a hidden import on a build machine that doesn't have it.
#
# Collect the whole package, not just the top-level module: app/sources/nidaq.py's
# _import_nidaqmx() imports nidaqmx.constants and nidaqmx.stream_readers lazily inside a function,
# which PyInstaller's static analysis cannot trace, and nidaqmx ships data files of its own. A
# bare hidden import of "nidaqmx" froze an exe whose nidaq_available() returned False while the
# same venv's unfrozen backend returned True.
#
# Note collect_data_files/copy_metadata return (src, dest) tuples: those belong in
# Analysis(datas=...), not in hiddenimports, which takes module-name strings only.
#
# copy_metadata(..., recursive=True) is load-bearing, not belt-and-braces. nidaqmx pulls in
# nitypes, which calls importlib.metadata.version("nitypes") at import time; PyInstaller does not
# bundle .dist-info by default, so without this the frozen exe fails with
# "NI-DAQmx not available: No package metadata was found for nitypes" and nidaq_available() is
# False even though the same venv's unfrozen backend returns True. Recursive picks up nidaqmx's
# whole dependency chain (nitypes, hightime, ...) rather than guessing at names.
try:
    import nidaqmx  # noqa: F401

    hidden_imports += collect_submodules("nidaqmx")
    hidden_imports += collect_submodules("nitypes")
    datas += collect_data_files("nidaqmx")
    datas += copy_metadata("nidaqmx", recursive=True)
except ImportError:
    pass

a = Analysis(
    ["run_frozen.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="force-app-backend",
    console=True,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="force-app-backend",
)
