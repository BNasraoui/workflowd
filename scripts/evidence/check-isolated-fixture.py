#!/usr/bin/python3
"""Host-side custody regression: launch only owned disposable checkout copies."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    os.umask(0o077)
    Path("/tmp/opencode").mkdir(mode=0o700, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="isolated-fixture-check-", dir="/tmp/opencode"))
    source = Path(__file__).with_name("isolated-fixture.py")
    failed = []
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
        result = subprocess.run(
            command, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=220
        )
        passed = result.returncode == 0 if case != "symlink" else result.returncode != 0
        if case == "existing":
            passed &= (mountpoint / "user-file").read_text() == "preserve"
        if case == "symlink":
            passed &= mountpoint.is_symlink() and (target / "user-file").read_text() == "preserve"
        if not passed:
            failed.append(case)
    print(f"isolated fixture checks: 3 cases ran, {len(failed)} failed")
    for case in failed:
        print(f"failed: {case}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
