import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// This fixture uses only synthetic files and transient units; no installed unit is changed.
test.skipIf(Bun.which("systemd-run") === null || !process.env.XDG_RUNTIME_DIR)(
  "the user manager enforces the reviewer unit's inaccessible and read-only paths",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "review-systemd-"))
    const runtime = process.env.XDG_RUNTIME_DIR!
    const runtimeCredentials = join(runtime, "credentials", `review-fixture-${process.pid}`)
    try {
      const unit = await Bun.file("deploy/systemd/opencode2-reviewer.service").text()
      const properties = unit
        .split("\n")
        .filter((line) =>
          /^(PrivateUsers|NoNewPrivileges|InaccessiblePaths|ReadOnlyPaths|TemporaryFileSystem|MemoryMax|MemorySwapMax)=/.test(
            line,
          ),
        )
        .map((line) =>
          line
            .replaceAll("%h", home)
            .replaceAll("%t", Bun.env.XDG_RUNTIME_DIR ?? "/run/user/fixture"),
        )
      const protectedRoots = [
        ".config/workflowd",
        ".config/noscope",
        ".config/nats",
        ".local/share/nats",
        ".local/share/opencode",
        ".local/share/opencode2",
      ]
      const secrets = [
        "mcp-token",
        "mcp-dispatch-token",
        "custom-dispatch-token",
        "agent-run-token",
        "agent-wait-token",
        "ci-token",
        "github-app.pem",
        "github-webhook-secret",
        "opencode-server-password",
        "reviewer-password",
        "reviewer.env",
        "coordinator.creds",
      ]
      const files = protectedRoots.flatMap((root) => secrets.map((name) => join(home, root, name)))
      for (const root of protectedRoots) await mkdir(join(home, root), { recursive: true })
      for (const file of files) await writeFile(file, "synthetic fixture")
      const config = join(home, ".config/workflowd-reviewer")
      await mkdir(config, { recursive: true })
      await writeFile(join(config, "opencode2.json"), "{}")
      await mkdir(runtimeCredentials, { recursive: true })
      for (const name of secrets)
        await writeFile(join(runtimeCredentials, name), "synthetic runtime credential")
      expect(await Bun.file(join(runtimeCredentials, "mcp-token")).exists()).toBe(true)
      const probe = join(home, "probe.sh")
      await writeFile(
        probe,
        `set -eu\nruntime="$1"; shift\nif test -e "$runtime/credentials"; then exit 14; fi\nif test -S "$runtime/bus" || test -S "$runtime/systemd/private"; then exit 15; fi\nif systemctl --user show-environment >/dev/null 2>&1; then exit 16; fi\nconfig="$1"; shift\nfor file do\n  if cat "$file" >/dev/null 2>&1; then exit 11; fi\ndone\ncat "$config/opencode2.json" >/dev/null\nif touch "$config/new-file" 2>/dev/null; then exit 12; fi\nif printf changed >"$config/opencode2.json" 2>/dev/null; then exit 13; fi\n`,
      )
      const child = Bun.spawn(
        [
          "systemd-run",
          "--user",
          "--wait",
          "--pipe",
          "--collect",
          `--setenv=XDG_RUNTIME_DIR=${runtime}`,
          ...properties.flatMap((property) => ["-p", property]),
          "/bin/sh",
          probe,
          runtime,
          config,
          ...files,
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" })
    } finally {
      await rm(runtimeCredentials, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  },
  15000,
)
