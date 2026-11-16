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

test("a box probe names the step that failed and removes what it made", async () => {
  const calls: Array<ReadonlyArray<string>> = []
  const lines = await probeBox({
    image: `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"c".repeat(64)}`,
    run: (step: string, args: ReadonlyArray<string>) => {
      calls.push(args)
      return step === "network" ? Promise.reject(new Error("network: exit 1")) : Promise.resolve("")
    },
    sudo: "/bin/true",
  })
  expect(lines).toEqual(["workflowd.probe box-flags: failed step=network"])
  expect(calls.at(-1)).toEqual(["network", "rm", "workflowd-sandbox"])
  expect(
    await probeBox({ image: "not-an-image", run: () => Promise.resolve(""), sudo: "/bin/true" }),
  ).toEqual(["workflowd.probe box-flags: failed step=binding"])
})
