# Runner placement: the trial run of workflowd on a GitHub runner

This procedure prepares one trial run. In the trial run, workflowd runs one Claude run of the
`workflowd` repository in a GitHub Actions job. The job sends the sealed result to the
capability gateway. The daemon checks the result and pushes `agent-run/<id>`.

The text uses placeholders in angle brackets, for example `<service-name>`. Do not write a real
value, a real host name or a secret in this file, in a commit or in an issue.

The procedure has three parts:

1. The owner's steps. The owner does them in the tailnet admin console, in the GitHub settings
   and on the host.
2. The operator's steps. An operator agent does them on the host. Do them after the owner's
   steps 1 to 6: they use the commit, the workflow SHA and the image digests of owner step 6.
3. The start of the trial run.

## Names that the procedure uses

| Name | Where it is set | Form of the value | Who reads it |
| --- | --- | --- | --- |
| `tag:agent-runner` | Tailnet policy file | Tag; the runner job asks for it (`deploy/sandbox/tailscale.sh`) | Tailscale |
| `svc:<service-name>` | Tailnet admin console, Services | Service name | Tailscale Serve, the runner |
| `tag:workflowd-gateway` | Tailnet policy file | Tag; the front node advertises it | Tailscale |
| `workflowd-gateway-front` | Host, as root (owner step 7) | System user with a fixed uid `<front-uid>` and gid `<front-gid>`; host name of the front node | `workflowd-gateway-front.service`, the gateway |
| `TS_AGENT_CLIENT_ID` | GitHub repository variable | Client ID of the trust credential, 1 to 128 ASCII identifier characters | `agent-sandbox-caller.yml` |
| `TS_AGENT_AUDIENCE` | GitHub repository variable | Audience of the trust credential, 1 to 256 URI characters, no query, no user part | `agent-sandbox-caller.yml` |
| `SANDBOX_AGENT_IMAGE` | GitHub repository variable | `ghcr.io/bnasraoui/workflowd-agent-base@sha256:<64 hex>` | `agent-sandbox-caller.yml`, `bootstrap.mjs`, the run client |
| `SANDBOX_GATEWAY_URL` | GitHub repository variable | `https://<service-name>.<tailnet-name>.ts.net`, no path, no port when Serve serves port 443 | `agent-sandbox-caller.yml`, `bootstrap.mjs`, `trial-probe.mjs` |
| `SANDBOX_BOOTSTRAP_MODE` | GitHub repository variable | `private` for the trial; when absent, `legacy-artifact` | `agent-sandbox-caller.yml` |
| `WORKFLOWD_AGENT_RUN_SANDBOX_REPOSITORIES` | Daemon environment file on the host | JSON array of sandbox policies (`src/sandbox/config.ts`, `SandboxPolicy`) | workflowd |
| `WORKFLOWD_AGENT_RUN_PLACEMENTS` | Daemon environment file on the host | JSON object, `{"<alias>": "runner"}` | workflowd |
| `WORKFLOWD_CAPABILITY_CONTROL` | Daemon environment file on the host | JSON object, `{"socket": "<control-socket-path>"}` | workflowd |
| `WORKFLOWD_RUNNER_MAX_RUNS` | Daemon environment file on the host | Positive integer; 4 when absent | workflowd |
| `WORKFLOWD_CAPABILITY_GATEWAY` | Gateway environment file on the host, `/etc/workflowd-gateway/gateway.env` | JSON object (`src/sandbox/config.ts`, `CapabilityGatewayConfig`) | the gateway process only |

The daemon refuses `WORKFLOWD_CAPABILITY_GATEWAY` in its own environment. The gateway reads it.

The front is the process that runs Tailscale Serve for the Service and reaches the gateway's Unix
socket. A Service host must be a tagged node. The host's own tailscaled is the node of a user,
and it stays so: on it, `tailscale serve --service` refuses with `service hosts must be tagged
nodes`. So the front is a second Tailscale node on the host: a second tailscaled, with userspace
networking, that runs as the system user `workflowd-gateway-front`
(`deploy/systemd/workflowd-gateway-front.service`). It has its own state directory,
`/var/lib/workflowd-gateway-front`, and its own socket,
`/run/workflowd-gateway-front/tailscaled.sock`. It does not use the state, the socket, the port
or the interface of the host's own tailscaled. It joins the tailnet with the tag
`tag:workflowd-gateway`.

## Part 1: the owner's steps

Do the steps in this order.

### Step 1. Make the gateway Service (tailnet admin console)

1. Open the tailnet admin console. Go to **Services**.
2. Make a Service with the name `svc:<service-name>`. Set the port to `tcp:443`.
3. Write down the MagicDNS name of the Service: `<service-name>.<tailnet-name>.ts.net`.

Check: the Service `svc:<service-name>` shows in the list of Services, with port `tcp:443`.

### Step 2. Give the runner tag access to the Service only (tailnet policy file)

1. Open the tailnet admin console. Go to **Access controls**.
2. Make sure that `tagOwners` has `tag:agent-runner`. The legacy sandbox runs already use this
   tag.
3. Add one grant: the source is `tag:agent-runner`, the destination is `svc:<service-name>`, the
   port is `tcp:443`.
4. Do not add a grant from `tag:agent-runner` to the host, to a user device or to another tag.
5. Add the front's tag to `tagOwners`, with the owner as its owner, for example
   `"tag:workflowd-gateway": ["autogroup:admin"]`. The owner then can give the tag to the front
   node in owner step 7.
6. Let the front node advertise the Service. Add `tag:workflowd-gateway` to
   `autoApprovers.services` for `svc:<service-name>`, or approve the front node in the Service
   page after owner step 7.
7. Do not add a grant to `tag:workflowd-gateway`. The front node serves the Service only.

Check: the policy file saves with no error. `tagOwners` has `tag:workflowd-gateway`. The **Preview rules** page for `tag:agent-runner`
shows `svc:<service-name>` on `tcp:443` and no other destination.

### Step 3. Make the trust credential for the runner job (tailnet admin console)

The legacy sandbox runs of `workflowd` already use one credential. Use it, or make a new one:

1. Go to **Settings**, then **Trust credentials**, then **OpenID Connect**.
2. Set the issuer to `https://token.actions.githubusercontent.com`.
3. Set the scope to **Auth Keys: write** only. Set the tag to `tag:agent-runner`.
4. Set the subject to the lease refs of the repository:
   `repo:<owner>@<owner-id>/workflowd@<repository-id>:ref:refs/heads/workflowd/leases/*`.
5. Write down the client ID and the audience.

Check: the credential shows the issuer, the tag `tag:agent-runner` and the subject of step 4.

### Step 4. Set the repository variables (GitHub repository settings)

1. Open the `workflowd` repository on GitHub. Go to **Settings**, then **Secrets and variables**,
   then **Actions**, then **Variables**.
2. Set these repository variables. Do not set them as secrets: the CI policy
   (`src/sandbox/ci-policy.ts`) lets the runner job read variables only.

| Variable | Value |
| --- | --- |
| `TS_AGENT_CLIENT_ID` | the client ID of step 3 |
| `TS_AGENT_AUDIENCE` | the audience of step 3 |
| `SANDBOX_GATEWAY_URL` | `https://<service-name>.<tailnet-name>.ts.net` |
| `SANDBOX_AGENT_IMAGE` | do not set it yet; set it in step 6, with the digest of the image of the commit of step 6 |
| `SANDBOX_BOOTSTRAP_MODE` | do not set it yet; set it in step 9 |

Check: the **Variables** tab shows the three variables `TS_AGENT_CLIENT_ID`,
`TS_AGENT_AUDIENCE` and `SANDBOX_GATEWAY_URL`. The step header of a job shows each value that a
step gets in its environment. The gateway's MagicDNS name is then visible in the public log of
each private-mode run.

### Step 5. Give the lease App the right to cancel runs (GitHub App settings)

The daemon uses the App whose installation is `installationId` of the sandbox policy, and whose
bot actor id is `appActorId`. That App makes the lease ref, cancels the Actions run of a run
that ends, and pushes `agent-run/<id>` (`src/sandbox/github.ts`).

1. Go to **Settings**, then **Developer settings**, then **GitHub Apps**, then the lease App,
   then **Permissions & events**.
2. Make sure that the repository permissions are **Contents: Read and write** and **Actions:
   Read and write**. Keep **Metadata: Read-only**. Do not add **Workflows**.
3. Save. Accept the new permissions in **Settings**, then **Applications**, then **Installed
   GitHub Apps**, then the lease App, then **Configure**.

Check: the installation page of the App shows **Actions: Read and write** and **Contents: Read
and write** for `workflowd`.

### Step 6. Merge and pin the workflow commit (GitHub)

1. Merge the pull request that holds this file into `main`.
2. Write down the full 40-hex SHA of the merge commit on `main`. This is `<workflow-sha>`.
   GitHub runs the caller workflow of the lease ref at this commit. The lease App has no
   **Workflows** permission, so the commit must be the tip of a branch when the daemon makes the
   lease ref, or a commit in the history of `main`.
3. Wait for the image jobs of `main` to publish the images of that commit:
   - the agent image: the job **Publish agent image to GHCR** of the workflow **Publish agent
     base image** pushes the tag `<workflow-sha>`. Its step **Publish the tested image** writes
     the digest in the line `<workflow-sha>: digest: sha256:<64 hex> size: <bytes>`;
   - the gateway image: the job **Publish gateway image to GHCR by digest** of the workflow
     **CI** writes the line `Published: ghcr.io/bnasraoui/workflowd-gateway@sha256:<64 hex>`.

   Give both digests and `<workflow-sha>` to the operator.
4. Set the repository variable `SANDBOX_AGENT_IMAGE` (step 4) to
   `ghcr.io/bnasraoui/workflowd-agent-base@sha256:<agent-digest>`, with the agent image's digest.

Check: `.github/workflows/agent-sandbox-caller.yml` at `<workflow-sha>` gives `bootstrap-mode`,
`gateway-url` and `agent-image` to `agent-sandbox.yml`. The **Variables** tab now shows the four
variables of step 4 that are set: `TS_AGENT_CLIENT_ID`, `TS_AGENT_AUDIENCE`,
`SANDBOX_GATEWAY_URL` and `SANDBOX_AGENT_IMAGE`.

### Step 7. Install and start the gateway (host, as root)

Do this step after operator step 2. Each command of this step needs root. Do it one time. Do not
give root to the operator agent for it.

The gateway runs as the system unit `workflowd-gateway.service`
(`deploy/systemd/workflowd-gateway.service`). The unit starts a container of the published
gateway image. The container runs as the image's own uid and gid, 10001, never as root and never
as the daemon's user. So the daemon cannot read the gateway's login, its store or its noscope
configuration. Root runs only the Docker client of the unit. The container writes only
`/var/lib/workflowd-gateway` and a private `/tmp`.

The front runs as the system unit `workflowd-gateway-front.service`, as its own system user
`workflowd-gateway-front`, never as root, the daemon's user or uid 10001. The gateway serves the
uid of this user only (`listen.front.uid`). The user reaches the gateway's socket through its
group only (`listen.front.gid`): the gateway gives the socket's directory, `front`, this group
and mode 0710, and the socket this group and mode 0660. The gateway's container also has this
group, so the front's state and socket are in directories of mode 0700, which only the front's
user and root reach. Each `tailscale --socket=...` command of the front needs root.

1. Make sure that the daemon's user cannot use Docker. A user who can use the Docker socket can
   run a command in the gateway's container and read the login. Run `id -nG <daemon-user>`. If
   the output shows `docker`, remove the user from the group:

   ```sh
   sudo gpasswd --delete <daemon-user> docker
   ```

   The processes of the daemon's user that started before this command keep the group. They
   lose it only when the systemd instance of the user (`user@<daemon-uid>.service`) starts
   again, for example at the next start of the host. Do not give the go-ahead (step 10) before
   the check of this item passes.
2. Make the front's system user, with the uid `<front-uid>` and the gid `<front-gid>` of
   `listen.front.uid` and `listen.front.gid` in the environment file of operator step 2. The
   user has no home and no login shell:

   ```sh
   sudo groupadd --system --gid <front-gid> workflowd-gateway-front
   sudo useradd --system --uid <front-uid> --gid <front-gid> --no-create-home \
     --home-dir /nonexistent --shell /usr/sbin/nologin workflowd-gateway-front
   ```

3. Make the gateway's state directory and its noscope configuration directory, owned by uid
   10001:

   ```sh
   sudo install -d -o 10001 -g 10001 -m 0711 /var/lib/workflowd-gateway
   sudo install -d -o 10001 -g 10001 -m 0700 /var/lib/workflowd-gateway/config \
     /var/lib/workflowd-gateway/config/noscope /var/lib/workflowd-gateway/config/noscope/providers
   ```

   Mode 0711 lets the daemon and the front go through the directory to their sockets. They
   cannot list it.
4. Install the two noscope providers of operator step 1. The gateway mints each run's token
   through `run-capability`, and takes its provider login through `provider-access`:

   ```sh
   for name in run-capability provider-access; do
     sudo install -o 10001 -g 10001 -m 0600 <staging-directory>/$name.toml \
       /var/lib/workflowd-gateway/config/noscope/providers/$name.toml
   done
   ```

5. Install the environment file of operator step 2:

   ```sh
   sudo install -d -o root -g root -m 0755 /etc/workflowd-gateway
   sudo install -o root -g root -m 0600 <staging-directory>/gateway.env /etc/workflowd-gateway/gateway.env
   ```

6. Pull the gateway image by its digest, the value of `WORKFLOWD_GATEWAY_IMAGE` in the
   environment file. The unit does not pull it.

   ```sh
   sudo docker pull ghcr.io/bnasraoui/workflowd-gateway@sha256:<gateway-digest>
   ```

7. Install, enable and start the gateway's unit, from the checkout of the commit of step 6:

   ```sh
   sudo install -o root -g root -m 0644 <checkout>/deploy/systemd/workflowd-gateway.service \
     /etc/systemd/system/workflowd-gateway.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now workflowd-gateway.service
   ```

8. Install, enable and start the front's unit, from the same checkout:

   ```sh
   sudo install -o root -g root -m 0644 <checkout>/deploy/systemd/workflowd-gateway-front.service \
     /etc/systemd/system/workflowd-gateway-front.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now workflowd-gateway-front.service
   ```

9. Join the front node to the tailnet with the tag of owner step 2. Use no auth key: the command
   writes a login URL. Open the URL and approve the login as the owner:

   ```sh
   sudo tailscale --socket=/run/workflowd-gateway-front/tailscaled.sock up \
     --advertise-tags=tag:workflowd-gateway --hostname=workflowd-gateway-front
   ```

10. Point the Service at the gateway's socket, through the front node:

    ```sh
    sudo tailscale --socket=/run/workflowd-gateway-front/tailscaled.sock serve \
      --service=svc:<service-name> --https=443 unix:/var/lib/workflowd-gateway/front/gateway.sock
    ```

    If the Service page shows the front node as a host that waits for approval, approve it.
11. Tell the operator that the gateway and the front started.

A later restart of a unit also needs root: `sudo systemctl restart workflowd-gateway.service`.
The front node keeps its login and its Serve configuration in its state directory over a restart.

The gateway makes a missing `front` directory with the group `listen.front.gid`. It does not
change the group of a `front` directory that exists: it refuses to start. If the gateway ran
before with another `listen.front.gid`, give the directory the new group before the restart:
`sudo chown 10001:<front-gid> /var/lib/workflowd-gateway/front`.

Check:

- `sudo -u <daemon-user> id -nG` does not show `docker`. `grep '^Groups:'
  /proc/<daemon-pid>/status` does not show the gid of `docker` (`getent group docker`).
  `<daemon-pid>` is the value that `systemctl --user show -p MainPID workflowd.service` writes
  as the daemon's user.
- `sudo stat -c '%u %g %a %n' /var/lib/workflowd-gateway
  /var/lib/workflowd-gateway/config/noscope/providers/run-capability.toml
  /var/lib/workflowd-gateway/config/noscope/providers/provider-access.toml
  /etc/workflowd-gateway/gateway.env` shows `10001 10001 711`, `10001 10001 600`,
  `10001 10001 600` and `0 0 600`.
- `systemctl is-active workflowd-gateway.service` writes `active`.
- `sudo docker top workflowd-gateway -eo pid,uid,gid,args` shows uid 10001 and gid 10001 on
  each line. Docker needs the `pid` column.
- `getent passwd workflowd-gateway-front` shows `<front-uid>:<front-gid>`.
  `systemctl is-active workflowd-gateway-front.service` writes `active`.
  `ps -o uid=,gid=,args= -C tailscaled` shows the front's line with `<front-uid> <front-gid>`,
  and the line of the host's own tailscaled as before.
- `sudo tailscale --socket=/run/workflowd-gateway-front/tailscaled.sock status --peers=false`
  shows the node `workflowd-gateway-front` as `tagged-devices`. `tailscale status
  --peers=false`, on the host's own tailscaled, shows the host's node of the user as before.
- `sudo tailscale --socket=/run/workflowd-gateway-front/tailscaled.sock serve status` shows
  `svc:<service-name>` on port 443 with the target
  `unix:/var/lib/workflowd-gateway/front/gateway.sock`. The Service page of the admin console
  shows the front node as a host of the Service.

### Step 8. Import the gateway's provider login (host, as root)

Do this step after operator step 3. The gateway keeps its own login. Only the owner gives it.

1. On the host, run the gateway's command `import-login claude` in the gateway's container.
   `claude` is the one provider of custody's table (`src/capability-gateway/custody.ts`) and
   the value of `credentialRole`; the command refuses any other name:

   ```sh
   sudo docker exec --interactive workflowd-gateway \
     /bin/bun /app/src/capability-gateway-server.ts import-login claude
   ```

   The command reads `WORKFLOWD_CAPABILITY_GATEWAY` from its environment and writes the login
   in its `login.directory`. `docker exec` gives it the environment of the gateway's
   container: the unit's `--env WORKFLOWD_CAPABILITY_GATEWAY` and the image's `PATH` and
   `HOME`. Run outside the container, with no such variable, it refuses. The Docker client
   needs root. The command runs as the image's user, uid 10001, never as root. Do not add
   `--user` or `--env`. Give the login on standard input only: the JSON of a Claude login, with
   `claudeAiOauth` and the scope `user:inference`.
2. Do not put the login in an argument, in an environment variable or in a file that another
   user can read.
3. Restart the gateway: `sudo systemctl restart workflowd-gateway.service`.

Check: the command writes `imported the claude login, owned by uid 10001` or
`replaced the claude login, owned by uid 10001`. It writes no value of the login.

### Step 9. Select private mode (GitHub repository settings)

Do this step after operator step 6.

1. Set the repository variable `SANDBOX_BOOTSTRAP_MODE` to `private`.

Check: the **Variables** tab shows `SANDBOX_BOOTSTRAP_MODE` = `private`. From now on, each lease
push of `workflowd` runs in private mode: no artifact, and no `agent-publish` job.

### Step 10. Give the go-ahead

1. Tell the operator that the trial run can start.

## Part 2: the operator's steps on the host

An operator agent does these steps. Do them in this order. Do the check after each step. If a
check fails, stop and tell the owner. Do not change the tailnet or the GitHub settings. The
operator does not use root: the owner does each step that needs root (owner steps 7 and 8).

The operator writes two files in a staging directory of its own, `<staging-directory>`, and the
owner installs them in owner step 7. Run the commands from the checkout of the commit of owner
step 6.

### Operator step 1. Write the gateway's two noscope providers

The gateway runs two noscope providers. `run-capability` mints each run's token, and
`provider-access` gives the gateway its provider login. Both templates of `deploy/noscope/`
name the paths of the gateway image: its Bun at `/bin/bun` and its source at `/app`.

1. Make the staging directory and copy both templates into it:

   ```sh
   install -d -m 0700 <staging-directory>
   install -m 0600 deploy/noscope/run-capability.toml <staging-directory>/run-capability.toml
   install -m 0600 deploy/noscope/provider-access.toml <staging-directory>/provider-access.toml
   ```

2. In `provider-access.toml`, replace `LOGIN_DIRECTORY` with the value of `login.directory`,
   `/var/lib/workflowd-gateway/login`. `run-capability.toml` has no placeholder.

   ```sh
   sed -i '/^mint = /s|LOGIN_DIRECTORY|/var/lib/workflowd-gateway/login|' \
     <staging-directory>/provider-access.toml
   ```

Check: these two commands each write `1`:

```sh
grep -c '^mint = "/bin/bun /app/src/capability-gateway/noscope-provider.ts run {ttl}"$' \
  <staging-directory>/run-capability.toml
grep -c '^mint = "/bin/bun /app/src/capability-gateway/custody-process.ts access /var/lib/workflowd-gateway/login {role} {ttl}"$' \
  <staging-directory>/provider-access.toml
```

The files hold no secret. After owner step 7, the owner's `stat` shows the gateway's uid 10001
and mode 0600 for each (owner step 7, check).

### Operator step 2. Write the gateway's environment file

1. Copy the example environment file:

   ```sh
   install -m 0600 deploy/gateway.env.example <staging-directory>/gateway.env
   ```

2. Replace each placeholder in `<staging-directory>/gateway.env`. The file sets
   `WORKFLOWD_CAPABILITY_GATEWAY`, the configuration of the gateway process, with the keys of
   `docs/capability-gateway.md`, and three variables of the unit:
   - `WORKFLOWD_GATEWAY_IMAGE`: `ghcr.io/bnasraoui/workflowd-gateway@sha256:<gateway-digest>`.
     The job **Publish gateway image to GHCR by digest** of the commit of owner step 6 writes
     the digest in its line `Published:`.
   - `WORKFLOWD_GATEWAY_DAEMON_GID`: the same value as `daemon.gid`.
   - `WORKFLOWD_GATEWAY_FRONT_GID`: the same value as `listen.front.gid`.
   - `noscope.binary`, `noscope.configHome`: keep `/bin/noscope`, the path of the gateway image,
     and `/var/lib/workflowd-gateway/config`.
   - `storePath`, `controlSocket`: keep `/var/lib/workflowd-gateway/gateway.db` and
     `/var/lib/workflowd-gateway/control/control.sock`.
   - `daemon.uid`, `daemon.gid`: the uid and gid of the workflowd daemon (`id -u <daemon-user>`,
     `id -g <daemon-user>`).
   - `login.directory`: keep `/var/lib/workflowd-gateway/login`. The gateway's uid owns it, mode
     0700; owner step 8 makes it.
   - `providerId`: keep `anthropic`, the id of the gateway's model route in each runner
     request path (`/capabilities/v1/providers/anthropic/...`). The gateway gives it to the
     runner, so any id of lower-case letters, digits and hyphens works.
   - `credentialRole`: keep `claude`, the one provider of custody's table
     (`src/capability-gateway/custody.ts`). The gateway passes it to `provider-access` as
     `{role}`, and refuses to start with any other value.
   - `maxStreams`, `maxStreamsPerRun`: for example 64 and 4.
   - `gitRead`: `true`. The runner reads the source through the gateway's Git route.
   - `listen.socket`: keep `/var/lib/workflowd-gateway/front/gateway.sock`, the path of the
     gateway's Unix socket.
   - `listen.front.uid`, `listen.front.gid`: the fixed uid and gid of the front's system user
     `workflowd-gateway-front`, which the owner makes in owner step 7. If the user exists, use
     `id -u workflowd-gateway-front` and `id -g workflowd-gateway-front`. If not, select a uid
     and a gid above 10001 and below 60000 that `getent passwd <uid>` and `getent group <gid>`
     do not show, and give them to the owner. Do not use 0, the daemon's ids or 10001.
   - `listen.service`: `<service-name>.<tailnet-name>.ts.net`, in lower case.
3. Tell the owner to do owner step 7.

Check: `grep -v '^#' <staging-directory>/gateway.env | grep -c '<'` writes `0`. The gateway's
schema accepts the configuration; this command writes `valid`:

```sh
(set -a; . <staging-directory>/gateway.env; bun -e 'import { loadCapabilityGatewayConfig } from "./src/config.ts"; loadCapabilityGatewayConfig(process.env); console.log("valid")')
```

### Operator step 3. Check the gateway

Do this step after owner step 7.

1. Read the state of the unit and of its sockets:

   ```sh
   systemctl is-active workflowd-gateway.service
   stat -c '%u %g %a %n' /var/lib/workflowd-gateway/control \
     /var/lib/workflowd-gateway/control/control.sock /var/lib/workflowd-gateway/front
   journalctl -u workflowd-gateway.service -b --no-pager | tail -n 20
   ```

   `journalctl` of a system unit needs the group `systemd-journal` or `adm`. If the operator's
   user has neither, ask the owner for the lines.
2. Tell the owner to do owner step 8.

Check: the unit is `active`. The control socket exists with the daemon's group: the `stat` lines
show `10001 <daemon-gid> 710` for `control`, `10001 <daemon-gid> 660` for `control.sock`,
and `10001 <front-gid> 710` for `front`. The journal
has the line `listening /var/lib/workflowd-gateway/front/gateway.sock` and no other error. The
stop timeout of the unit is 15 seconds from SIGTERM to SIGKILL (`docker stop --time 15`); `systemctl
show -p TimeoutStopUSec workflowd-gateway.service` writes `TimeoutStopUSec=30s`, which covers it.
The gateway ends a SIGTERM with exit code 130, which the unit counts as a clean stop
(`SuccessExitStatus=130`): after `systemctl stop`, `systemctl is-failed workflowd-gateway.service`
writes `inactive`.
After owner step 8, the journal of the restart has no login error.

### Operator step 4. Check the front

The owner serves the Service in owner step 7, through the front node. The operator cannot reach
the front's socket.

1. Read the state of the front's unit and process:

   ```sh
   systemctl is-active workflowd-gateway-front.service
   ps -o uid=,gid=,args= -C tailscaled
   ```

Check: the unit is `active`. `ps` shows one `tailscaled` line with `<front-uid> <front-gid>` and
`--socket=/run/workflowd-gateway-front/tailscaled.sock`. These values are `listen.front.uid` and
`listen.front.gid` of the environment file. The owner's checks of owner step 7 show the Serve
configuration and the Service page. Do not check the Service with a request from the host: no
node of the host has the runner's tag, so the answer shows neither the path of a runner nor the
gateway's rule for it. The probe line `service-body-16mib` of the trial run
(Part 3) checks the path from a runner.

### Operator step 5. Configure the daemon

Edit the daemon's environment file. Keep a copy of the old file.

1. In `WORKFLOWD_AGENT_RUN_SANDBOX_REPOSITORIES`, set the policy of the `workflowd` alias:
   - `"privateBootstrap": {"mode": "actions-native", "repositoryOwnerId": <owner-id>}`
   - `"workflowSha": "<workflow-sha>"` (owner step 6); do not set `toolingSha`.
   - `"agentImage"`: the value of `SANDBOX_AGENT_IMAGE`.
   - `"tailscaleClientId"`, `"tailscaleAudience"`: the values of `TS_AGENT_CLIENT_ID` and
     `TS_AGENT_AUDIENCE`.
   - `"repositoryId"`, `"installationId"`, `"appActorId"`: as before.
2. Set `WORKFLOWD_AGENT_RUN_PLACEMENTS` to `{"<alias>": "runner"}`, with the alias of
   `workflowd` in `WORKFLOWD_AGENT_RUN_REPOSITORIES`.
3. Set `WORKFLOWD_CAPABILITY_CONTROL` to
   `{"socket": "/var/lib/workflowd-gateway/control/control.sock"}`, the value of `controlSocket`.
4. Do not set `WORKFLOWD_RUNNER_MAX_RUNS` for the trial. The default is 4.

Check: the daemon's loader accepts the file; this command, from the checkout, writes `valid`:

```sh
(set -a; . <daemon-environment-file>; bun -e 'import { loadConfig } from "./src/config.ts"; await loadConfig(process.env); console.log("valid")')
```

A fault stops the command, and the daemon's next start, with one of these errors:

- a `runner` placement whose alias has no `actions-native` policy: `A runner placement needs an
  actions-native sandbox policy for its alias`;
- an `actions-native` policy with no `WORKFLOWD_CAPABILITY_CONTROL`: `Native Actions requires an
  explicit capability gateway configuration`. The error does not name the variable;
- `WORKFLOWD_CAPABILITY_GATEWAY` in the daemon's file: `WORKFLOWD_CAPABILITY_GATEWAY belongs to
  the gateway process`.

### Operator step 6. Restart the daemon

1. Restart the workflowd unit only after the owner gives the go-ahead for this step. No run of
   the host must be live.
2. Tell the owner to do owner step 9.

Check: the unit is active. Its journal has no `Sandbox reconciliation failed` line.

## Part 3: the start of the trial run

After owner step 10, send one dispatch to the daemon:

- `POST /workflows/agent-runs` on the daemon, with `Authorization: Bearer
  <WORKFLOWD_AGENT_RUN_TOKEN>`, and the body
  `{"route": "claude", "repository": "<alias>", "prompt": "<one small change>"}`.

A good result:

1. The daemon makes the ref `workflowd/leases/<lease-id>`. The Actions run of
   `Agent sandbox lease` starts.
2. The step **Probe the gateway Service and the box** writes three lines:
   - `workflowd.probe service-body-16mib: passed status=403 sent=16777216`, or `headers-only`.
     `headers-only` shows that the Service forwards the request, but not that it takes the whole
     body. `refused status=413` shows that the Service refuses the body: the result must then go
     in parts. `failed error=ENOTFOUND` shows that the runner's own tailscaled gives no address
     for the Service's name: the runner joins with `--accept-dns=false` and asks tailscaled's
     resolver for the name (`deploy/sandbox/gateway-address.mjs`), so check the grant of owner
     step 2 and the Service of owner step 1.
   - `workflowd.probe box-flags: passed`
   - `workflowd.probe box-network: passed dropped=4`
3. The steps **Prepare private first contact** and **Hold the lease** end with outcome `ok`. No
   artifact is uploaded. The job `agent-publish` is skipped.
4. The caller's mailbox gets one message with `"status": "completed"`, `"end_reason":
   "completed"` and `"placement": "runner"`.
5. The branch `agent-run/<id>` is on GitHub. It has one commit on the source SHA.

If a probe line shows `failed`, keep the Actions run, and tell the owner the line.
