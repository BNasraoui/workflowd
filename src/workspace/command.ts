import { Effect } from "effect"
import { normalizeError } from "../errors"
import { WorkspaceError } from "./errors"

type WorkspaceCommandOptions = {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
}

type BoundedWorkspaceCommandOptions = WorkspaceCommandOptions & {
  readonly maxStdoutBytes: number
}

type WorkspaceCommandBytes = {
  readonly stdout: Uint8Array
  readonly truncated: boolean
}

function executeWorkspaceCommand<A>(
  operation: string,
  command: ReadonlyArray<string>,
  options: WorkspaceCommandOptions,
  readStdout: (stdout: ReadableStream<Uint8Array>) => Promise<A>,
): Effect.Effect<A, WorkspaceError> {
  return Effect.async<A, WorkspaceError>((resume, signal) => {
    let child: Bun.ReadableSubprocess
    try {
      child = Bun.spawn([...command], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        detached: true,
        env: options.env ?? process.env,
        signal,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
    } catch (cause) {
      resume(Effect.fail(new WorkspaceError({ operation, cause: normalizeError(cause) })))
      return
    }

    const completion = Promise.all([
      child.exited,
      readStdout(child.stdout),
      new Response(child.stderr).text(),
    ]).then(([status, stdout, stderr]) => {
      if (status !== 0) {
        throw new Error(`${command[0]} exited ${status}: ${stderr.trim()}`)
      }
      return stdout
    })
    void completion.then(
      (output) => resume(Effect.succeed(output)),
      (cause) =>
        resume(Effect.fail(new WorkspaceError({ operation, cause: normalizeError(cause) }))),
    )

    const terminateGroup = (signalName: "SIGTERM" | "SIGKILL") => {
      try {
        process.kill(-child.pid, signalName)
      } catch {
        try {
          child.kill(signalName)
        } catch {
          // The process has already exited.
        }
      }
    }
    const groupIsAlive = () => {
      try {
        process.kill(-child.pid, 0)
        return true
      } catch {
        return false
      }
    }
    signal.addEventListener("abort", () => terminateGroup("SIGTERM"), {
      once: true,
    })

    return Effect.tryPromise({
      try: async () => {
        terminateGroup("SIGTERM")
        const completionSettled = completion.then(
          () => true,
          () => true,
        )
        const completed = await Promise.race([completionSettled, Bun.sleep(500).then(() => false)])
        if (!completed || groupIsAlive()) terminateGroup("SIGKILL")
        await completionSettled
        for (let attempt = 0; attempt < 50 && groupIsAlive(); attempt += 1) {
          await Bun.sleep(10)
        }
        if (groupIsAlive()) {
          throw new Error(`Process group ${child.pid} remained alive after cleanup`)
        }
      },
      catch: normalizeError,
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Workspace command cleanup failed", { operation, cause }),
      ),
      Effect.orDie,
    )
  })
}

export function runWorkspaceCommand(
  operation: string,
  command: ReadonlyArray<string>,
  options: WorkspaceCommandOptions = {},
): Effect.Effect<string, WorkspaceError> {
  return executeWorkspaceCommand(operation, command, options, (stdout) =>
    new Response(stdout).text(),
  ).pipe(Effect.map((stdout) => stdout.trimEnd()))
}

export function runWorkspaceCommandBytes(
  operation: string,
  command: ReadonlyArray<string>,
  options: BoundedWorkspaceCommandOptions,
): Effect.Effect<WorkspaceCommandBytes, WorkspaceError> {
  return executeWorkspaceCommand(operation, command, options, async (stdout) => {
    const retained = new Uint8Array(options.maxStdoutBytes)
    const reader = stdout.getReader()
    let retainedBytes = 0
    let truncated = false

    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const available = retained.byteLength - retainedBytes
      const copied = Math.min(available, next.value.byteLength)
      if (copied > 0) {
        retained.set(next.value.subarray(0, copied), retainedBytes)
        retainedBytes += copied
      }
      if (copied < next.value.byteLength) truncated = true
    }

    return {
      stdout:
        retainedBytes === retained.byteLength ? retained : retained.subarray(0, retainedBytes),
      truncated,
    }
  })
}
