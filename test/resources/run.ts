import "./preload"

const args = process.argv.slice(2)
if (!args.length) throw new Error("Usage: bun test/resources/run.ts COMMAND [ARG...]")
const child = Bun.spawn(args, {
  env: { ...process.env, WORKFLOWD_TEST_RESOURCE_SHELL: "1" },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(await child.exited)
