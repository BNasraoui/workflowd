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
| `WORKFLOWD_CAPABILITY_GATEWAY` | Gateway environment on the host | JSON object (`src/sandbox/config.ts`, `CapabilityGatewayConfig`) | the gateway process only |

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
| `SANDBOX_BOOTSTRAP_MODE` | do not set it yet; set it in step 7 |

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

### Step 7. Import the gateway's provider login (host)

Do this step after operator step 3. The gateway keeps its own login. Only the owner gives it.

1. On the host, run the gateway's command `import-login <provider>` as the gateway's user, never
   as root. Give the login on standard input only.
2. Do not put the login in an argument, in an environment variable or in a file that another
   user can read.

Check: the command writes `imported the <provider> login, owned by uid <gateway-uid>` or
`replaced the <provider> login, owned by uid <gateway-uid>`. It writes no value of the login.

### Step 8. Select private mode (GitHub repository settings)

Do this step after operator step 6.

1. Set the repository variable `SANDBOX_BOOTSTRAP_MODE` to `private`.

Check: the **Variables** tab shows `SANDBOX_BOOTSTRAP_MODE` = `private`. From now on, each lease
push of `workflowd` runs in private mode: no artifact, and no `agent-publish` job.

### Step 9. Give the go-ahead

1. Tell the operator that the trial run can start.

## Part 2: the operator's steps on the host

An operator agent does these steps. Do them in this order. Do the check after each step. If a
check fails, stop and tell the owner. Do not change the tailnet or the GitHub settings.

### Operator step 1. Install the gateway's provider-access template

1. Copy `deploy/noscope/provider-access.toml` to the noscope configuration directory of the
   gateway (`noscope.configHome`).
2. Replace `LOGIN_DIRECTORY` with the value of `login.directory`.
3. Set the owner to the gateway's uid and the mode to 0600.

Check: `stat` shows the gateway's uid and mode 0600. The file holds no secret.

### Operator step 2. Write the gateway configuration

Write `WORKFLOWD_CAPABILITY_GATEWAY` into the environment of the gateway process. Use the keys
of `docs/capability-gateway.md`:

- `noscope.binary`, `noscope.configHome`: the paths of the gateway image.
- `storePath`, `controlSocket`: absolute paths of the gateway's store and control socket.
- `daemon.uid`, `daemon.gid`: the uid and gid of the workflowd daemon.
- `login.directory`: an absolute path that the gateway's uid owns, mode 0700.
- `providerId`, `credentialRole`: the provider id of the model route and the noscope role.
- `maxStreams`, `maxStreamsPerRun`: for example 64 and 4.
- `gitRead`: `true`. The runner reads the source through the gateway's Git route.
- `listen.socket`: the path of the gateway's Unix socket.
- `listen.front.uid`, `listen.front.gid`: the uid and gid of the process that runs Tailscale
  Serve.
- `listen.service`: `<service-name>.<tailnet-name>.ts.net`, in lower case.

Check: the gateway process starts and writes `listening <listen.socket>`. It writes no other
error.

### Operator step 3. Start the gateway

1. Start the gateway as its own uid, as a unit or a container of the gateway image. Set the stop
   timeout to at least 15 seconds (`TimeoutStopSec=15`, or `docker stop --time 15`).
2. Tell the owner to do owner step 7.

Check: the control socket exists with the daemon's group. After owner step 7, a restart of the
gateway writes no login error.

### Operator step 4. Serve the Service

1. Point the Service at the gateway's socket:
   `tailscale serve --service=svc:<service-name> --https=443 unix:<listen.socket>`.

Check: `tailscale serve status` shows `svc:<service-name>` on port 443 with the target
`unix:<listen.socket>`. From the host, a request to
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
3. Set `WORKFLOWD_CAPABILITY_CONTROL` to `{"socket": "<controlSocket>"}`.
4. Do not set `WORKFLOWD_RUNNER_MAX_RUNS` for the trial. The default is 4.

Check: the daemon loads the configuration at its next start with no error. A `runner`
placement with no `actions-native` policy, or with no `WORKFLOWD_CAPABILITY_CONTROL`, stops the
start with an error that names it.

### Operator step 6. Restart the daemon

1. Restart the workflowd unit only after the owner gives the go-ahead for this step. No run of
   the host must be live.
2. Tell the owner to do owner step 8.

Check: the unit is active. Its journal has no `Sandbox reconciliation failed` line.

## Part 3: the start of the trial run

After owner step 9, send one dispatch to the daemon:

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
