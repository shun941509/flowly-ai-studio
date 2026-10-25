"""Offline subprocess fixture for worker lifetime tests; never exported to users."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

HELPER_SOURCE = '''import json, os, subprocess, sys, time
from pathlib import Path
root = Path(__file__).resolve().parent
request = json.load(sys.stdin)
child = subprocess.Popen([sys.executable, "-I", "-S", "-c", "import time; time.sleep(60)"])
(root / "pids.tmp").write_text(json.dumps([os.getpid(), child.pid]), encoding="utf8")
(root / "pids.tmp").replace(root / "pids.json")
if request.get("mode") == "exit":
    print(json.dumps({"ok": True, "result": {"finished": True}}), flush=True)
else:
    time.sleep(60)
'''


def running(pid: int) -> bool:
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            code = wintypes.DWORD()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        stat = Path(f"/proc/{pid}/stat")
        return not stat.exists() or stat.read_text().split(") ", 1)[1][0] != "Z"
    except ProcessLookupError:
        return False


def wait_stopped(pids: list[int], seconds: float = 2) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not any(running(pid) for pid in pids):
            return True
        time.sleep(0.025)
    return not any(running(pid) for pid in pids)


def cleanup(pids: list[int]) -> None:
    # Every PID originates from this test's private fixture folder.
    for pid in pids:
        if not running(pid):
            continue
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=5,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


if __name__ == "__main__":
    action = sys.argv[1]
    pids = [int(value) for value in sys.argv[2:]]
    if action == "cleanup":
        cleanup(pids)
    elif action == "wait":
        sys.exit(0 if wait_stopped(pids) else 1)
    else:
        raise ValueError("unknown fixture command")
