import { spawn, execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readlink, writeFile, rm } from "node:fs/promises"
import { once } from "node:events"
import { resolve } from "node:path"
import { fixtureExecutable } from "../../helpers/fixture-executable.mjs"

/** Fails rather than opening any fixture listener in the host network namespace. */
export async function disposableSsh(
  command,
  address = "127.0.0.1",
  port = 22222,
  diagnosticFile,
  login,
) {
  const host = process.env.WORKFLOWD_FIXTURE_HOST_NETNS
  if (!host || !/^net:\[[0-9]+\]$/.test(host) || (await readlink("/proc/self/ns/net")) === host)
    throw new Error("SSH fixture requires isolated netns")
  await mkdir(".scratch", { recursive: true, mode: 0o700 })
  const root = await mkdtemp(resolve(".scratch/wfd-ssh-"))
  const env = { PATH: "/usr/bin:/bin", HOME: root, LANG: "C" }
  // Bun's userInfo falls back to USER in a clean environment. Node uses getpwuid.
  const user =
    login ??
    execFileSync(
      fixtureExecutable("node"),
      ["-e", "process.stdout.write(require('node:os').userInfo().username)"],
      { env, encoding: "utf8" },
    )
  if (!/^[a-z_][a-z0-9_-]*$/.test(user)) throw new Error("fixture user unavailable")
  let sshd
  let diagnostic = ""
  const close = async () => {
    if (sshd && sshd.exitCode === null && sshd.signalCode === null) {
      sshd.kill("SIGKILL")
      await once(sshd, "exit")
    }
    if (diagnosticFile) await writeFile(diagnosticFile, diagnostic, { mode: 0o600 })
    await rm(root, { recursive: true, force: true })
  }
  try {
    for (const name of ["host", "client"])
      execFileSync(
        "/usr/bin/ssh-keygen",
        ["-q", "-t", "ed25519", "-N", "", "-f", `${root}/${name}`],
        { env, stdio: "ignore" },
      )
    await writeFile(`${root}/authorized_keys`, await readFile(`${root}/client.pub`), {
      mode: 0o600,
    })
    const key = (await readFile(`${root}/host.pub`, "utf8")).trim().split(" ").slice(0, 2).join(" ")
    await writeFile(
      `${root}/known_hosts`,
      `${port === 22 ? address : `[${address}]:${port}`} ${key}\n`,
      { mode: 0o600 },
    )
    await writeFile(
      `${root}/sshd_config`,
      [
        `ListenAddress ${address}`,
        `Port ${port}`,
        `HostKey ${root}/host`,
        `PidFile ${root}/sshd.pid`,
        `AuthorizedKeysFile ${root}/authorized_keys`,
        "StrictModes yes",
        "UsePAM no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "AuthenticationMethods publickey",
        "DisableForwarding yes",
        "PermitTTY no",
        "PermitUserRC no",
        "PermitUserEnvironment no",
        `AllowUsers ${user}`,
        `ForceCommand ${command(root)}`,
        "LogLevel VERBOSE",
        "",
      ].join("\n"),
      { mode: 0o600 },
    )
    sshd = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", `${root}/sshd_config`], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    })
    let size = 0
    await new Promise((resolve, reject) => {
      sshd.once("error", reject)
      sshd.once("exit", () => reject(new Error("fixture sshd unavailable: " + diagnostic)))
      sshd.stderr.on("data", (bytes) => {
        size += bytes.length
        if (size <= 65536) diagnostic += bytes.toString()
        if (size > 65536) {
          sshd.kill("SIGKILL")
          reject(new Error("fixture sshd diagnostic bound"))
        }
        if (bytes.toString().includes("Server listening")) resolve()
      })
    })
    const args = [
      "/usr/bin/ssh",
      "-F",
      "/dev/null",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      `UserKnownHostsFile=${root}/known_hosts`,
      "-i",
      `${root}/client`,
      "-p",
      String(port),
      `${user}@${address}`,
    ]
    return { root, key, args, close }
  } catch (error) {
    await close()
    throw error
  }
}
