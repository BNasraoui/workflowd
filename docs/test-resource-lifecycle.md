# Test resource ownership

`bun test` loads `test/resources/preload.ts`. The launcher starts Bun with guarded
Docker and systemd executables already in PATH (Bun caches executable lookup).
Keep this preload when generating a temporary Bun configuration. Standalone shell
tests use `bun test/resources/run.ts COMMAND`; evidence probes import the preload.
The agent-image shell test enters the guard automatically.

Host containers, networks and volumes carry `io.workflowd.test-run`. User and
system service units carry `WORKFLOWD_TEST_RESOURCE_RUN` in their Environment
property. Ownership includes the machine, UID, boot, PID namespace, PID and Linux
process start ticks. PID reuse is therefore not sufficient authority to reap a
resource. Unlabelled, malformed, foreign-host and uncertain owners are preserved.
Docker launches require the local default engine; remote engines cannot be
safely swept using this host's process table.

The sandbox fixture additionally labels its whole resource group, including
image-declared volumes, and releases that group at close. Cleanup attempts each
resource independently, stopping units and containers before networks and
volumes. BuildKit's integrated default builder avoids legacy intermediate host
containers. Image-declared and anonymous CLI volumes become explicitly created,
labelled volumes before container creation.

The launcher verifies teardown after the test process exits. Cleanup failures
make the suite fail even if Bun reported passing tests. A detached guardian
handles process death; the next suite also sweeps dead labelled owners if the
whole process group was killed. In-flight commands are fenced when teardown
starts. A live or uninspectable owner is never swept by another suite.

The offline migration and administrative credential fixtures run as PID 1 in a
private PID namespace. They use resource-denying Docker/systemd executables
instead of a guardian, preserving process-count checks and orphan reaping. Their
simulated managers do not create host resources.

The disposable two-UID CI fixture labels its installed host service and native
transient units using a fixture-only drop-in. This path remains gated by
`WORKFLOWD_AGENT_DEPLOYED_TEST=1`; it is not a host deployment change.

Regression tests cover normal exit, SIGTERM, SIGKILL, loss of the guardian,
fixture isolation, PID reuse, failed removal, and a failing suite exit status.
Run them in a capped unit, preserving PATH for executable fixture shebangs:

```sh
systemd-run --user --wait --pipe --collect \
  -p MemoryMax=4G -p MemorySwapMax=0 \
  --working-directory="$PWD" --setenv="PATH=$PATH" \
  bun test test/resources
```

Never prune by a resource-name prefix. Old unlabelled resources require an
operator decision; the test guard deliberately leaves them alone.
