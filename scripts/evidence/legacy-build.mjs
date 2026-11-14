/* global Bun */
const script =
  process.env.WORKFLOWD_FIXTURE_LEGACY_CONTROLLER_STAGE === "1"
    ? "scripts/evidence/legacy-controller-build.py"
    : "scripts/evidence/legacy-build.py"
const child = Bun.spawn(["python3", script], {
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(await child.exited)
