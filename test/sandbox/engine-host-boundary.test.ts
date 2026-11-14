import { expect, test } from "bun:test"
import { command, runnerFixture } from "./harness"

test("synthetic host bridge keeps its MAC while a temporary probe port is attached", async () => {
  const runner = await runnerFixture()
  try {
    const addresses = await command([
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "--privileged",
      "--user",
      "root",
      "--entrypoint",
      "sh",
      "-v",
      `${process.cwd()}/test/sandbox/fixtures/engine-host-boundary.sh:/setup.sh:ro`,
      "workflowd-sandbox-runner:fixture",
      "-c",
      `set -eu
sh /setup.sh
ip netns exec host cat /sys/class/net/wfd-sandbox0/address
ip -n host link add temporary address 00:00:00:00:00:01 type veth peer name temporary-peer
ip -n host link set temporary master wfd-sandbox0
ip netns exec host cat /sys/class/net/wfd-sandbox0/address
ip -n host link del temporary
ip netns exec host cat /sys/class/net/wfd-sandbox0/address`,
    ])
    const [before, during, after] = addresses.split("\n")
    expect(during).toBe(before)
    expect(after).toBe(before)
  } finally {
    await runner.close()
  }
}, 120000)
