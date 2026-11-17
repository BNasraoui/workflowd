import { expect, test } from "bun:test"
import {
  blockedDestinations,
  networkLine,
  probeBox,
  probeLine,
  probeServiceBody,
  resultBound,
} from "../../deploy/sandbox/trial-probe.mjs"

const gateway = "https://gateway.example.invalid"

/** A Service that reads `take` bytes of each body, then answers `status`. */
const service =
  (status: number, take = Number.POSITIVE_INFINITY) =>
  async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe(`${gateway}/capabilities/v1/run/result`)
    expect(new Headers(init?.headers).get("authorization")).toBeNull()
    const body = init?.body
    if (!(body instanceof ReadableStream)) throw new Error("the probe's body is no stream")
    const reader = body.getReader()
    let read = 0
    while (read < take) {
      const chunk = await reader.read()
      if (chunk.done) break
      read += chunk.value.length
    }
    return new Response(null, { status })
  }

test("the Service probe passes only when the gateway's 403 comes after the whole 16 MiB body left the runner", async () => {
  expect(resultBound).toBe(16 * 1048576)
  expect(await probeServiceBody({ gateway, send: service(403) })).toBe(
    `workflowd.probe service-body-16mib: passed status=403 sent=${resultBound}`,
  )
  expect(await probeServiceBody({ gateway, send: service(403, 65536) })).toMatch(
    /^workflowd\.probe service-body-16mib: headers-only status=403 sent=\d+$/,
  )
  expect(await probeServiceBody({ gateway, send: service(413, 0) })).toMatch(
    /^workflowd\.probe service-body-16mib: refused status=413 sent=\d+$/,
  )
  expect(await probeServiceBody({ gateway, send: service(502) })).toBe(
    `workflowd.probe service-body-16mib: inconclusive status=502 sent=${resultBound}`,
  )
})

test("a Service probe that cannot reach the gateway, or has no gateway URL, fails with an error code and no address", async () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED 100.64.0.1:443"), {
    cause: { code: "ECONNREFUSED" },
  })
  expect(
    await probeServiceBody({
      gateway,
      send: () => Promise.reject(refused),
    }),
  ).toMatch(/^workflowd\.probe service-body-16mib: failed error=ECONNREFUSED sent=\d+$/)
  expect(await probeServiceBody({ gateway: "" })).toBe(
    "workflowd.probe service-body-16mib: failed error=ERR_INVALID_URL sent=0",
  )
})

test("the network line names each blocked destination that the box reached", () => {
  expect(networkLine([])).toBe(
    `workflowd.probe box-network: passed dropped=${blockedDestinations.length}`,
  )
  expect(networkLine(["metadata", "tailnet"])).toBe(
    "workflowd.probe box-network: failed reached=metadata,tailnet",
  )
  expect(probeLine("box-flags", "passed")).toBe("workflowd.probe box-flags: passed")
})

/**
 * A box module of the probe in place of native-docker.mjs: each docker call and box action is
 * recorded; `fail` names a docker step that fails, `reach` the hosts that a connection reaches.
 */
const scriptedBox = (options: { fail?: string; reach?: ReadonlyArray<string>; bind?: boolean }) => {
  const calls: Array<string> = []
  const box = {
    boxNetwork: { name: "workflowd-sandbox", subnet: "172.30.0.0/24" },
    docker: (step: string, args: ReadonlyArray<string>) => {
      calls.push(args.join(" "))
      return step === options.fail
        ? Promise.reject(new Error(`${step}: exit 1`))
        : Promise.resolve("")
    },
    makeBox: (binding: {
      readonly directory: string
      readonly image: string
      readonly name: string
    }) => {
      if (options.bind === false) throw new Error("box binding refused")
      calls.push(`make ${binding.name}`)
      return {
        start: () => {
          calls.push("start")
          return options.fail === "box" ? Promise.reject(new Error("box")) : Promise.resolve()
        },
        exec: (_: string, args: ReadonlyArray<string>) =>
          options.reach?.includes(args.at(-2) ?? "")
            ? Promise.reject(new Error("connect: exit 10"))
            : Promise.resolve(""),
        remove: () => {
          calls.push("remove")
          return Promise.resolve()
        },
      }
    },
  }
  return { box, calls }
}
const image = `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"c".repeat(64)}`

test("a box probe on a runner where the box starts reports its flags passed and each blocked destination dropped, then removes the box and the network", async () => {
  const { box, calls } = scriptedBox({})
  expect(await probeBox({ image, sudo: "/bin/true", box })).toEqual([
    "workflowd.probe box-flags: passed",
    `workflowd.probe box-network: passed dropped=${blockedDestinations.length}`,
  ])
  expect(calls).toEqual([
    `make workflowd-native-${"0".repeat(32)}`,
    // The pull, the long step, comes first: a time limit there leaves nothing of the probe.
    `image pull --quiet ${image}`,
    "network create --subnet 172.30.0.0/24 -o com.docker.network.bridge.name=wfd-sandbox0 workflowd-sandbox",
    "start",
    "remove",
    "network rm workflowd-sandbox",
  ])
})

test("a box probe names each blocked destination that the box reached", async () => {
  const { box } = scriptedBox({ reach: ["169.254.169.254", "100.100.100.100"] })
  expect(await probeBox({ image, sudo: "/bin/true", box })).toEqual([
    "workflowd.probe box-flags: passed",
    "workflowd.probe box-network: failed reached=metadata,tailnet",
  ])
})

test("a box probe names the step that failed and removes what it made", async () => {
  for (const [options, step, removed] of [
    [{ fail: "network" }, "network", []],
    [{ fail: "image" }, "image", []],
    [{ fail: "box" }, "box", ["remove", "network rm workflowd-sandbox"]],
    [{ bind: false }, "binding", []],
  ] as const) {
    const { box, calls } = scriptedBox(options)
    expect(await probeBox({ image, sudo: "/bin/true", box })).toEqual([
      `workflowd.probe box-flags: failed step=${step}`,
    ])
    expect(calls.filter((call) => call === "remove" || call.startsWith("network rm"))).toEqual([
      ...removed,
    ])
  }
  const { box } = scriptedBox({})
  expect(await probeBox({ image, sudo: "/bin/false", box })).toEqual([
    "workflowd.probe box-flags: failed step=network-rules",
  ])
})
