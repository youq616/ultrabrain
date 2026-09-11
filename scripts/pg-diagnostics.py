#!/usr/bin/env python3
"""Classify backend crashes without printing SQL, paths, credentials or raw logs."""
import json
import os
import re
from pathlib import Path

def classify(log):
    return {
        "backend_termination_signals": [int(x) for x in re.findall(r"terminated by signal (\d+)", log)],
        "recovery_restarts": log.count("automatic recovery in progress"),
        "out_of_memory_reported": bool(re.search(r"(?:ERROR|FATAL|PANIC):  out of memory", log)),
    }

if __name__ == "__main__":
    home = Path(os.environ.get("ULTRABRAIN_HOME", Path.home() / ".local/share/ultrabrain"))
    path = home / "postgres/server.log"
    # Read only a bounded suffix; no parsed log content is returned verbatim.
    if path.is_file():
        with path.open("rb") as stream:
            stream.seek(max(0, path.stat().st_size - 1048576))
            result = classify(stream.read().decode("utf8", errors="replace"))
    else:
        result = {"log_available": False}
    print(json.dumps(result))
