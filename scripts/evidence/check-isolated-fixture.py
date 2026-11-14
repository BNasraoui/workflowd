#!/usr/bin/python3
"""Host-side custody regression: launch only owned disposable checkout copies."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    os.umask(0o077)
    Path("/tmp/opencode").mkdir(mode=0o700, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="p4-launcher-check-", dir="/tmp/opencode"))
    source = Path(__file__).with_name("isolated-fixture.py")
    results = []
    for case in ["absent", "existing", "symlink"]:
        checkout = evidence / case
        scripts = checkout / "scripts/evidence"
        scripts.mkdir(parents=True)
        shutil.copyfile(source, scripts / source.name)
        mountpoint = checkout / ".scratch"
        if case == "existing":
            mountpoint.mkdir()
            (mountpoint / "user-file").write_text("preserve")
        if case == "symlink":
            target = evidence / "user-directory"
            target.mkdir()
            (target / "user-file").write_text("preserve")
            mountpoint.symlink_to(target)
        command = [
            "python3", str(scripts / source.name), "python3", "-c",
            "from pathlib import Path; p=Path('.scratch/probe'); "
            "assert not Path('.scratch/user-file').exists(); "
            "p.write_text('owned'); assert p.read_text() == 'owned'; p.unlink()",
        ]
        environment = {**os.environ, "WORKFLOWD_FIXTURE_EVIDENCE": str(evidence / "invocations")}
        # Minimal copies deliberately contain neither Git history nor native fixtures.
        for key in ["WORKFLOWD_FIXTURE_PINNED_PUBLISHER", "WORKFLOWD_FIXTURE_NATIVE_CAPTURE"]:
            environment.pop(key, None)
        with (evidence / (case + ".log")).open("w") as log:
            result = subprocess.run(command, env=environment, stdout=log, stderr=log, timeout=220)
        passed = result.returncode == 0 if case != "symlink" else result.returncode != 0
        if case == "existing":
            passed &= (mountpoint / "user-file").read_text() == "preserve"
        if case == "symlink":
            passed &= mountpoint.is_symlink() and (target / "user-file").read_text() == "preserve"
        results.append({"case": case, "exit": result.returncode, "passed": passed})
    (evidence / "results.json").write_text(json.dumps(results, indent=2))
    print(json.dumps({"evidence": str(evidence), "passed": all(row["passed"] for row in results)}))
    return 0 if all(row["passed"] for row in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
