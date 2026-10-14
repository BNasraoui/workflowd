import { expect, test } from "bun:test"
import { bridgeClient, command, runnerFixture } from "./harness"

test("container-use works over a private socket while nested engine access is dropped", async () => {
  const addresses = (await command(["ip", "-o", "-4", "addr", "show"]))
    .split("\n")
    .filter((line) => !line.split(/\s+/).includes("lo"))
    .map((line) => line.match(/inet ([0-9.]+)\//)?.[1])
    .filter((address): address is string => address !== undefined)
  const runner = await runnerFixture(addresses)
  const client = bridgeClient(runner.transport)
  try {
    expect(
      await runner.docker(
        "exec",
        `${runner.name}-runner`,
        "sh",
        "-c",
        "test -S /run/workflowd-engine/engine.sock && echo socket",
      ),
    ).toBe("socket")
    const listeners = await runner.docker("exec", `${runner.name}-engine`, "cat", "/proc/net/tcp")
    // Port 1234 must not be listening on any engine interface.
    expect(listeners).not.toMatch(/:04D2\s+[0-9A-F]+:0000\s+0A/)
    await client.initialize()
    await client.request("tools/list")
    const created = JSON.stringify(
      await client.request("tools/call", {
        name: "environment_create",
        arguments: { environment_source: "/workspace/repository", title: "Network boundary" },
      }),
    )
    const id = created.match(/\\"id\\"\s*:\s*\\"([^\\"]+)/)?.[1]
    expect(created).toContain('\\"id\\"')
    expect(id).toBeDefined()
    if (!id) throw new Error("Environment was not created")
    const result = await client.request("tools/call", {
      name: "environment_run_cmd",
      arguments: {
        environment_source: "/workspace/repository",
        environment_id: id,
        command:
          "getent hosts github.com >/dev/null && test ! -e /run/workflowd-engine/engine.sock && timeout 2 bash -c 'echo > /dev/tcp/10.87.0.1/1234'; code=$?; test \"$code\" = 124 && printf boundary-passed",
      },
    })
    expect(JSON.stringify(result)).toContain("boundary-passed")
    await expect(
      runner.docker(
        "exec",
        `${runner.name}-runner`,
        "sh",
        "-c",
        `
      cli=$(find /home/runner/.cache/dagger -type f -name 'dagger-*' | head -1)
      printf '%s' '{container{from(address:"ubuntu:24.04"){withExec(args:["true"],insecureRootCapabilities:true){stdout}}}}' | timeout 60 "$cli" query
    `,
      ),
    ).rejects.toThrow(/security.insecure is not allowed/)
    const rules = await runner.docker(
      "exec",
      `${runner.name}-engine`,
      "iptables",
      "-nvL",
      "WFD-ENGINE",
    )
    expect(rules).toMatch(/[1-9]\d*\s+\d+\s+DROP/)
    await runner.docker(
      "exec",
      `${runner.name}-runner`,
      "container-use",
      "config",
      "base-image",
      "set",
      "python:3.13-alpine",
    )
    expect(
      await command([
        process.execPath,
        "--eval",
        `
      import {probeDagger,connectionScript,assertProbeResults,runnerTargets,executeProbe,dropCounters,assertDropsIncreased} from './scripts/evidence/sandbox-network.mjs'
      import {sandboxSshArguments} from './src/sandbox/transport.ts'
      const targets=runnerTargets({addresses:${JSON.stringify(addresses)},gateway:${JSON.stringify(await runner.docker("network", "inspect", "-f", "{{(index .IPAM.Config 0).Gateway}}", runner.name))}})
      targets.push({host:'10.87.0.1',port:1234})
      const script=connectionScript(targets).replace('print(json.dumps', "print('WORKFLOWD_NETWORK='+json.dumps")
      const counterArgs=['docker','exec',${JSON.stringify(`${runner.name}-engine`)},'iptables-save','-c']
      const before=dropCounters(await executeProbe(counterArgs))
      const results=await probeDagger(sandboxSshArguments(${JSON.stringify(runner.transport)}),script,120000)
      assertProbeResults(targets,results,'timeout')
      assertDropsIncreased(before,dropCounters(await executeProbe(counterArgs)),['WFD-SANDBOX','WFD-ENGINE'])
      console.log('nested-probe-passed')
    `,
      ]),
    ).toBe("nested-probe-passed")
    expect(
      await runner.docker("exec", `${runner.name}-engine`, "iptables", "-S", "CNI-ADMIN"),
    ).toContain("-j WFD-SANDBOX")
  } finally {
    await client.close()
    await runner.close()
  }
}, 180000)

test("host policy drops gateway and protected forwarded traffic without changing public egress", async () => {
  const { resolve } = await import("node:path")
  const { command } = await import("./harness")
  const root = resolve(import.meta.dir, "../..")
  const runner = await runnerFixture()
  try {
    expect(
      await command([
        "docker",
        "run",
        "--rm",
        "--privileged",
        "--network",
        runner.name,
        "--memory=128m",
        "--memory-swap=128m",
        "-v",
        `${root}/deploy/sandbox/network.sh:/network.sh:ro`,
        "-v",
        `${root}/test/sandbox/fixtures/network-boundary.sh:/test.sh:ro`,
        "--user",
        "root",
        "--entrypoint",
        "sh",
        "workflowd-sandbox-runner:fixture",
        "/test.sh",
      ]),
    ).toBe("network-boundary-passed")
  } finally {
    await runner.close()
  }
}, 120000)
