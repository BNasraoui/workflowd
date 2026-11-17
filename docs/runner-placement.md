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
   steps 1 to 5.
3. The start of the trial run.

## Names that the procedure uses

| Name | Where it is set | Form of the value | Who reads it |
| --- | --- | --- | --- |
| `tag:agent-runner` | Tailnet policy file | Tag; the runner job asks for it (`deploy/sandbox/tailscale.sh`) | Tailscale |
| `svc:<service-name>` | Tailnet admin console, Services | Service name | Tailscale Serve, the runner |
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
5. Let the host that serves the Service advertise it. Add the host's tag to
   `autoApprovers.services` for `svc:<service-name>`, or approve the host in the Service page
   after operator step 4.

Check: the policy file saves with no error. The **Preview rules** page for `tag:agent-runner`
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
| `SANDBOX_AGENT_IMAGE` | `ghcr.io/bnasraoui/workflowd-agent-base@sha256:<digest>`, the published image of the commit of step 6 |
| `SANDBOX_GATEWAY_URL` | `https://<service-name>.<tailnet-name>.ts.net` |
| `SANDBOX_BOOTSTRAP_MODE` | do not set it yet; set it in step 9 |

Check: the **Variables** tab shows the four variables. The step header of a job shows each value
that a step gets in its environment. The gateway's MagicDNS name is then visible in the public
log of each private-mode run.

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
3. Wait for the image job of `main` to publish the agent image of that commit. Put its digest in
   `SANDBOX_AGENT_IMAGE` (step 4).

Check: `.github/workflows/agent-sandbox-caller.yml` at `<workflow-sha>` gives `bootstrap-mode`,
`gateway-url` and `agent-image` to `agent-sandbox.yml`.

### Step 7. Install and start the gateway (host, as root)

Do this step after operator step 2. Each command of this step needs root. Do it one time. Do not
give root to the operator agent for it.

The gateway runs as the system unit `workflowd-gateway.service`
(`deploy/systemd/workflowd-gateway.service`). The unit starts a container of the published
gateway image. The container runs as the image's own uid and gid, 10001, never as root and never
as the daemon's user. So the daemon cannot read the gateway's login, its store or its noscope
configuration. Root runs only the Docker client of the unit. The container writes only
`/var/lib/workflowd-gateway` and a private `/tmp`.

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
2. Make the gateway's state directory and its noscope configuration directory, owned by uid
   10001:

   ```sh
   sudo install -d -o 10001 -g 10001 -m 0711 /var/lib/workflowd-gateway
   sudo install -d -o 10001 -g 10001 -m 0700 /var/lib/workflowd-gateway/config \
     /var/lib/workflowd-gateway/config/noscope /var/lib/workflowd-gateway/config/noscope/providers
   ```

   Mode 0711 lets the daemon and tailscaled go through the directory to their sockets. They
   cannot list it.
3. Install the provider-access template of operator step 1:

   ```sh
   sudo install -o 10001 -g 10001 -m 0600 <staging-directory>/provider-access.toml \
     /var/lib/workflowd-gateway/config/noscope/providers/provider-access.toml
   ```

4. Install the environment file of operator step 2:

   ```sh
   sudo install -d -o root -g root -m 0755 /etc/workflowd-gateway
   sudo install -o root -g root -m 0600 <staging-directory>/gateway.env /etc/workflowd-gateway/gateway.env
   ```

5. Pull the gateway image by its digest, the value of `WORKFLOWD_GATEWAY_IMAGE` in the
   environment file. The unit does not pull it.

   ```sh
   sudo docker pull ghcr.io/bnasraoui/workflowd-gateway@sha256:<gateway-digest>
   ```

6. Install, enable and start the unit, from the checkout of the commit of step 6:

   ```sh
   sudo install -o root -g root -m 0644 <checkout>/deploy/systemd/workflowd-gateway.service \
     /etc/systemd/system/workflowd-gateway.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now workflowd-gateway.service
   ```

7. Tell the operator that the gateway started.

A later restart of the unit also needs root: `sudo systemctl restart workflowd-gateway.service`.

Check:

- `sudo -u <daemon-user> id -nG` does not show `docker`. `grep '^Groups:'
  /proc/<daemon-pid>/status` does not show the gid of `docker` (`getent group docker`).
  `<daemon-pid>` is the value that `systemctl --user show -p MainPID workflowd.service` writes
  as the daemon's user.
- `sudo stat -c '%u %g %a %n' /var/lib/workflowd-gateway
  /var/lib/workflowd-gateway/config/noscope/providers/provider-access.toml
  /etc/workflowd-gateway/gateway.env` shows `10001 10001 711`, `10001 10001 600` and `0 0 600`.
- `systemctl is-active workflowd-gateway.service` writes `active`.
- `sudo docker top workflowd-gateway -eo uid,gid,args` shows uid 10001 and gid 10001 on each
  line.

### Step 8. Import the gateway's provider login (host, as root)

Do this step after operator step 3. The gateway keeps its own login. Only the owner gives it.

1. On the host, run the gateway's command `import-login <provider>` in the gateway's container:

   ```sh
   sudo docker exec --interactive workflowd-gateway \
     /bin/bun /app/src/capability-gateway-server.ts import-login <provider>
   ```

   The Docker client needs root. The command runs as the gateway's user, uid 10001, never as
   root. Do not add `--user`. Give the login on standard input only.
2. Do not put the login in an argument, in an environment variable or in a file that another
   user can read.
3. Restart the gateway: `sudo systemctl restart workflowd-gateway.service`.

Check: the command writes `imported the <provider> login, owned by uid 10001` or
`replaced the <provider> login, owned by uid 10001`. It writes no value of the login.

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

### Operator step 1. Write the gateway's provider-access template

1. Make the staging directory and copy the template into it:

   ```sh
   install -d -m 0700 <staging-directory>
   install -m 0600 deploy/noscope/provider-access.toml <staging-directory>/provider-access.toml
   ```

2. Replace `LOGIN_DIRECTORY` with the value of `login.directory`,
   `/var/lib/workflowd-gateway/login`:

   ```sh
   sed -i '/^mint = /s|LOGIN_DIRECTORY|/var/lib/workflowd-gateway/login|' \
     <staging-directory>/provider-access.toml
   ```

Check: `grep -c '^mint = .* access /var/lib/workflowd-gateway/login ' <staging-directory>/provider-access.toml`
writes `1`. The file holds no secret. After owner step 7, the owner's `stat` shows the gateway's
uid 10001 and mode 0600 (owner step 7, check).

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
   - `providerId`, `credentialRole`: the provider id of the model route and the noscope role.
   - `maxStreams`, `maxStreamsPerRun`: for example 64 and 4.
   - `gitRead`: `true`. The runner reads the source through the gateway's Git route.
   - `listen.socket`: keep `/var/lib/workflowd-gateway/front/gateway.sock`, the path of the
     gateway's Unix socket.
   - `listen.front.uid`, `listen.front.gid`: the uid and gid of the process that runs Tailscale
     Serve (`ps -o uid=,gid= -C tailscaled`).
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
After owner step 8, the journal of the restart has no login error.

### Operator step 4. Serve the Service

1. Point the Service at the gateway's socket:
   `tailscale serve --service=svc:<service-name> --https=443 unix:/var/lib/workflowd-gateway/front/gateway.sock`.

Check: `tailscale serve status` shows `svc:<service-name>` on port 443 with the target
`unix:/var/lib/workflowd-gateway/front/gateway.sock`. From the host, a request to
`https://<service-name>.<tailnet-name>.ts.net/` gets an empty 403: the gateway accepts only a
tagged node.

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

Check: the daemon loads the configuration at its next start with no error. A `runner`
placement with no `actions-native` policy, or with no `WORKFLOWD_CAPABILITY_CONTROL`, stops the
start with an error that names it.

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
     in parts.
   - `workflowd.probe box-flags: passed`
   - `workflowd.probe box-network: passed dropped=4`
3. The steps **Prepare private first contact** and **Hold the lease** end with outcome `ok`. No
   artifact is uploaded. The job `agent-publish` is skipped.
4. The caller's mailbox gets one message with `"status": "completed"`, `"end_reason":
   "completed"` and `"placement": "runner"`.
5. The branch `agent-run/<id>` is on GitHub. It has one commit on the source SHA.

If a probe line shows `failed`, keep the Actions run, and tell the owner the line.
