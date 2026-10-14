"""Collect names only; unreadable live processes make the evidence incomplete."""
from pathlib import Path


def scan_process_environments(root=Path('/proc')):
    names = set()
    oidc_processes = []
    workers = 0
    hold_count = 0
    hold_oidc = set()
    for process in root.glob('[0-9]*'):
        try:
            current = {entry.split(b'=', 1)[0].decode(errors='replace')
                       for entry in (process / 'environ').read_bytes().split(b'\0') if b'=' in entry}
            names.update(current)
            oidc = sorted(name for name in current if name.startswith('ACTIONS_ID_TOKEN_REQUEST_'))
            # Kernel threads have empty environments and no executable link.
            if oidc:
                executable = (process / 'exe').resolve(strict=True).name
                if executable == 'Runner.Worker':
                    workers += 1
                else:
                    oidc_processes.append({'pid': int(process.name), 'names': oidc})
            if (process / 'cmdline').read_bytes().rstrip(b'\0').endswith(b'\0hold'):
                hold_count += 1
                hold_oidc.update(oidc)
        except (FileNotFoundError, ProcessLookupError):
            if process.exists():
                raise
            # A process that exited during the snapshot no longer holds credentials.
    return {'environmentNames': sorted(names), 'oidcProcesses': oidc_processes,
            'runnerWorkers': workers, 'holdProcesses': hold_count,
            'holdOidcEnvironmentNames': sorted(hold_oidc)}
