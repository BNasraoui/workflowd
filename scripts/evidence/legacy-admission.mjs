/* global Bun */
const child = Bun.spawn(["python3", "scripts/evidence/legacy-admission-controls.py"], {
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(await child.exited)
