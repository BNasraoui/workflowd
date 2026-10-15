import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Config } from "./backend"
import { finish } from "./guard"
import { owner } from "./owner"

test("finish fences late commands and keeps its recovery record until pending commands end", () => {
  const directory = mkdtempSync(join(tmpdir(), "workflowd-guard-test-"))
  const config: Config = {
    directory,
    owner: owner(),
    launcher: owner(),
    docker: null,
    systemctl: null,
    systemdRun: null,
    env: {},
  }
  try {
    writeFileSync(join(directory, "pending-test"), owner())
    expect(() => finish(config)).toThrow("commands still running")
    expect(existsSync(join(directory, "closing"))).toBe(true)
    rmSync(join(directory, "pending-test"))
    finish(config)
    expect(existsSync(directory)).toBe(false)
    finish(config)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("failed backend inventory still attempts every backend and retains recovery state", () => {
  const directory = mkdtempSync(join(tmpdir(), "workflowd-guard-test-"))
  const binary = join(directory, "fail")
  writeFileSync(binary, '#!/bin/sh\necho "$1" >> "$LOG"\nexit 1\n', { mode: 0o755 })
  const log = join(directory, "calls")
  const config: Config = {
    directory,
    owner: owner(),
    launcher: owner(),
    docker: binary,
    systemctl: binary,
    systemdRun: null,
    env: { LOG: log },
  }
  try {
    writeFileSync(join(directory, "used-docker"), "")
    writeFileSync(join(directory, "used-user"), "")
    expect(() => finish(config)).toThrow()
    expect(existsSync(directory)).toBe(true)
    expect(Bun.file(log).size).toBeGreaterThan(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a guardian preserves recovery state when owner liveness is unknown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workflowd-guard-test-"))
  const fields = owner().split(".")
  fields[1] = "0".repeat(32)
  const config: Config = {
    directory,
    owner: fields.join("."),
    launcher: fields.join("."),
    docker: null,
    systemctl: null,
    systemdRun: null,
    env: {},
  }
  const path = join(directory, "config.json")
  writeFileSync(path, JSON.stringify(config))
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "guardian.ts"), path], {
      stdout: "ignore",
      stderr: "pipe",
    })
    const output = await new Response(child.stderr).text()
    expect(await child.exited, output).toBe(1)
    expect(existsSync(path)).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
