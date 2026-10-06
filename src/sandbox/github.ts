import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { Effect, Schema } from "effect"
import type { SandboxPolicy } from "./config"
import { SandboxError } from "./store"

const Repository = Schema.Struct({ id: Schema.Int, fork: Schema.Boolean })
const Run = Schema.Struct({
  id: Schema.Int,
  run_attempt: Schema.Int,
  event: Schema.String,
  head_sha: Schema.String,
  head_branch: Schema.String,
  path: Schema.String,
  repository: Repository,
  head_repository: Repository,
  actor: Schema.Struct({ id: Schema.Int }),
  triggering_actor: Schema.Struct({ id: Schema.Int }),
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
})
const Ref = Schema.Struct({ ref: Schema.String, object: Schema.Struct({ sha: Schema.String }) })
export type OwnedLeaseRun = { readonly leaseId: string; readonly run: typeof Run.Type }
const leaseBranch = (leaseId: string) => `workflowd/leases/${leaseId}`
const githubFailure = () => new SandboxError({ message: "Sandbox GitHub request failed" })

const Ready = Schema.Struct({
  leaseId: Schema.String,
  repository: Schema.String,
  repositoryId: Schema.Int,
  workflowSha: Schema.String,
  appActorId: Schema.Int,
  runId: Schema.Int,
  attempt: Schema.Int,
  peerId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,100}$/)),
  address: Schema.String.check(Schema.isPattern(/^100\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}$/)),
  claims: Schema.Record(Schema.String, Schema.String),
})

// Read one bounded JSON member; archive paths are never extracted or executed.
async function readyArchive(value: unknown, signal: AbortSignal): Promise<unknown> {
  if (!(value instanceof ArrayBuffer) || value.byteLength > 65536) throw githubFailure()
  const root = await mkdtemp(join(tmpdir(), "workflowd-readiness-"))
  try {
    const path = join(root, "ready.zip")
    await writeFile(path, new Uint8Array(value), { mode: 0o600 })
    const child = Bun.spawn(["/usr/bin/unzip", "-p", path, "ready.json"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const stop = () => {
      child.kill("SIGKILL")
    }
    signal.addEventListener("abort", stop, { once: true })
    const timer = setTimeout(stop, 10000)
    try {
      const reader = child.stdout.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      while (true) {
        const item = await reader.read()
        if (item.done) break
        length += item.value.length
        if (length > 16384) throw githubFailure()
        chunks.push(item.value)
      }
      if ((await child.exited) !== 0) throw githubFailure()
      return JSON.parse(Buffer.concat(chunks).toString())
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", stop)
      stop()
      await child.exited
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export const makeSandboxGithub = (
  github: { appId: number; privateKeyPath: string },
  OctokitClass: typeof Octokit = Octokit,
) =>
  Effect.gen(function* () {
    const key = yield* Effect.tryPromise({
      try: () => readFile(github.privateKeyPath, "utf8"),
      catch: githubFailure,
    })
    const app = new App({ appId: github.appId, privateKey: key, Octokit: OctokitClass })
    const scoped = Effect.fn("SandboxGithub.scoped")(function* (policy: SandboxPolicy) {
      const response = yield* Effect.tryPromise({
        try: () =>
          app.octokit.request("POST /app/installations/{installation_id}/access_tokens", {
            installation_id: policy.installationId,
            repository_ids: [policy.repositoryId],
            permissions: { contents: "write", actions: "write" },
            request: { timeout: 10000 },
          }),
        catch: githubFailure,
      })
      const client = new OctokitClass({ auth: response.data.token })
      const repository = yield* Effect.tryPromise({
        try: () =>
          client.request(`GET /repos/${policy.repository}`, { request: { timeout: 10000 } }),
        catch: githubFailure,
      })
      const actual = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ ...Repository.fields, full_name: Schema.String, private: Schema.Boolean }),
      )(repository.data)
      if (
        actual.id !== policy.repositoryId ||
        actual.full_name.toLowerCase() !== policy.repository.toLowerCase() ||
        actual.fork ||
        actual.private
      )
        return yield* Effect.fail(
          new SandboxError({ message: "Sandbox repository identity mismatch" }),
        )
      return client
    })
    const request = Effect.fn("SandboxGithub.request")(function* (
      client: Octokit,
      method: string,
      path: string,
      body: Record<string, unknown> = {},
    ) {
      return yield* Effect.tryPromise({
        try: async () => {
          try {
            const result = await client.request(`${method} ${path}`, {
              ...body,
              request: { timeout: 10000 },
            })
            const data: unknown = result.data
            return { status: result.status, data }
          } catch (error) {
            // Retain only the HTTP status; Octokit exceptions can contain credentials.
            if (
              typeof error === "object" &&
              error !== null &&
              "status" in error &&
              typeof error.status === "number"
            )
              return { status: error.status, data: null }
            throw githubFailure()
          }
        },
        catch: githubFailure,
      })
    })
    const ensureRef = Effect.fn("SandboxGithub.ensureRef")(function* (
      policy: SandboxPolicy,
      leaseId: string,
    ) {
      yield* Schema.decodeUnknownEffect(
        Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,80}$/)),
      )(leaseId)
      const client = yield* scoped(policy)
      const path = `/repos/${policy.repository}/git/ref/heads/${leaseBranch(leaseId)}`
      let result = yield* request(client, "GET", path)
      if (result.status === 404) {
        // A lost reply is reconciled by reading the single immutable lease ref.
        yield* request(client, "POST", `/repos/${policy.repository}/git/refs`, {
          ref: `refs/heads/${leaseBranch(leaseId)}`,
          sha: policy.workflowSha,
        })
        result = yield* request(client, "GET", path)
      }
      if (result.status !== 200) return yield* Effect.fail(githubFailure())
      const ref = yield* Schema.decodeUnknownEffect(Ref)(result.data)
      if (ref.ref !== `refs/heads/${leaseBranch(leaseId)}` || ref.object.sha !== policy.workflowSha)
        return yield* Effect.fail(
          new SandboxError({ message: "Sandbox lease ref identity mismatch" }),
        )
    })
    const runs = Effect.fn("SandboxGithub.runs")(function* (
      policy: SandboxPolicy,
      leaseId: string,
    ) {
      const client = yield* scoped(policy)
      const result = yield* request(client, "GET", `/repos/${policy.repository}/actions/runs`, {
        branch: leaseBranch(leaseId),
        head_sha: policy.workflowSha,
        event: "push",
        per_page: 100,
      })
      if (result.status !== 200) return yield* Effect.fail(githubFailure())
      const page = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ total_count: Schema.Int, workflow_runs: Schema.Array(Run) }),
      )(result.data)
      if (page.total_count > 100)
        return yield* Effect.fail(
          new SandboxError({ message: "Sandbox run correlation exceeded its bound" }),
        )
      const owned = page.workflow_runs.filter(
        (run) => run.path === ".github/workflows/agent-sandbox-caller.yml",
      )
      return yield* Effect.forEach(owned, (run) => validateRun(policy, leaseId, run))
    })
    const validateRun = Effect.fn("SandboxGithub.validateRun")(function* (
      policy: SandboxPolicy,
      leaseId: string,
      value: unknown,
    ) {
      const run = yield* Schema.decodeUnknownEffect(Run)(value)
      if (
        run.path !== ".github/workflows/agent-sandbox-caller.yml" ||
        run.repository.id !== policy.repositoryId ||
        run.repository.fork ||
        run.head_repository.id !== policy.repositoryId ||
        run.head_repository.fork ||
        run.head_sha !== policy.workflowSha ||
        run.head_branch !== leaseBranch(leaseId) ||
        run.actor.id !== policy.appActorId ||
        run.triggering_actor.id !== policy.appActorId ||
        run.event !== "push" ||
        run.run_attempt !== 1
      )
        return yield* Effect.fail(
          new SandboxError({ message: "Sandbox Actions run identity mismatch" }),
        )
      return run
    })
    const savedRun = Effect.fn("SandboxGithub.savedRun")(function* (
      policy: SandboxPolicy,
      leaseId: string,
      runId: number,
      attempt: number,
    ) {
      const client = yield* scoped(policy)
      const response = yield* request(
        client,
        "GET",
        `/repos/${policy.repository}/actions/runs/${runId}`,
      )
      if (response.status !== 200) return yield* Effect.fail(githubFailure())
      const run = yield* validateRun(policy, leaseId, response.data)
      if (run.id !== runId || run.run_attempt !== attempt)
        return yield* Effect.fail(
          new SandboxError({ message: "Sandbox saved Actions run identity mismatch" }),
        )
      return run
    })
    const inventory = Effect.fn("SandboxGithub.inventory")(function* (policy: SandboxPolicy) {
      return yield* Effect.gen(function* () {
        const client = yield* scoped(policy)
        const owned: OwnedLeaseRun[] = []
        const seen = new Set<number>()
        let total: number | undefined
        for (let number = 1; number <= 10; number++) {
          const response = yield* request(
            client,
            "GET",
            `/repos/${policy.repository}/actions/runs`,
            {
              head_sha: policy.workflowSha,
              event: "push",
              per_page: 100,
              page: number,
            },
          )
          if (response.status !== 200) return yield* Effect.fail(githubFailure())
          const page = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ total_count: Schema.Int, workflow_runs: Schema.Array(Run) }),
          )(response.data)
          total ??= page.total_count
          if (
            total < 0 ||
            total > 1000 ||
            total !== page.total_count ||
            page.workflow_runs.length !== Math.min(100, total - seen.size)
          )
            return yield* Effect.fail(githubFailure())
          for (const run of page.workflow_runs) {
            if (seen.has(run.id)) return yield* Effect.fail(githubFailure())
            seen.add(run.id)
            const leaseId = /^workflowd\/leases\/([a-zA-Z0-9-]{1,80})$/.exec(run.head_branch)?.[1]
            if (leaseId === undefined) continue
            const validated = yield* Effect.result(validateRun(policy, leaseId, run))
            if (validated._tag === "Success") owned.push({ leaseId, run: validated.success })
          }
          if (seen.size === total) return owned
        }
        return yield* Effect.fail(githubFailure())
      }).pipe(
        Effect.timeout("60 seconds"),
        Effect.mapError(
          () =>
            new SandboxError({
              message: "Sandbox repository inventory incomplete; retry required",
            }),
        ),
      )
    })
    const cancel = Effect.fn("SandboxGithub.cancel")(function* (
      policy: SandboxPolicy,
      runId: number,
    ) {
      const client = yield* scoped(policy)
      const response = yield* request(
        client,
        "POST",
        `/repos/${policy.repository}/actions/runs/${runId}/cancel`,
      )
      if (![202, 409].includes(response.status)) return yield* Effect.fail(githubFailure())
    })
    const deleteRef = Effect.fn("SandboxGithub.deleteRef")(function* (
      policy: SandboxPolicy,
      leaseId: string,
    ) {
      const client = yield* scoped(policy)
      const path = `/repos/${policy.repository}/git/refs/heads/${leaseBranch(leaseId)}`
      const removed = yield* request(client, "DELETE", path)
      if (![204, 404].includes(removed.status)) return yield* Effect.fail(githubFailure())
      const read = yield* request(
        client,
        "GET",
        `/repos/${policy.repository}/git/ref/heads/${leaseBranch(leaseId)}`,
      )
      if (read.status !== 404)
        return yield* Effect.fail(
          new SandboxError({ message: "Sandbox lease ref deletion unconfirmed" }),
        )
    })
    const readiness = Effect.fn("SandboxGithub.readiness")(function* (
      policy: SandboxPolicy,
      leaseId: string,
      runId: number,
      attempt: number,
    ) {
      const client = yield* scoped(policy)
      const response = yield* request(
        client,
        "GET",
        `/repos/${policy.repository}/actions/runs/${runId}/artifacts`,
        { per_page: 100 },
      )
      if (response.status !== 200) return yield* Effect.fail(githubFailure())
      const artifacts = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          total_count: Schema.Int,
          artifacts: Schema.Array(
            Schema.Struct({
              id: Schema.Int,
              name: Schema.String,
              size_in_bytes: Schema.Int,
              expired: Schema.Boolean,
            }),
          ),
        }),
      )(response.data)
      if (artifacts.total_count > 100) return yield* Effect.fail(githubFailure())
      const matches = artifacts.artifacts.filter(
        (artifact) => artifact.name === `sandbox-ready-${runId}-${attempt}`,
      )
      if (matches.length === 0) return null
      const artifact = matches[0]
      if (
        matches.length !== 1 ||
        artifact === undefined ||
        artifact.expired ||
        artifact.size_in_bytes > 65536
      )
        return yield* Effect.fail(githubFailure())
      const download = yield* request(
        client,
        "GET",
        `/repos/${policy.repository}/actions/artifacts/${artifact.id}/zip`,
      )
      if (download.status !== 200) return yield* Effect.fail(githubFailure())
      const data = yield* Effect.tryPromise({
        try: (signal) => readyArchive(download.data, signal),
        catch: githubFailure,
      })
      const ready = yield* Schema.decodeUnknownEffect(Ready)(data)
      const claims = {
        aud: policy.tailscaleAudience,
        repository_id: String(policy.repositoryId),
        actor_id: String(policy.appActorId),
        ref: `refs/heads/${leaseBranch(leaseId)}`,
        sha: policy.workflowSha,
        job_workflow_sha: policy.workflowSha,
        job_workflow_ref: `${policy.repository}/.github/workflows/agent-sandbox.yml@refs/heads/${leaseBranch(leaseId)}`,
        event_name: "push",
        runner_environment: "github-hosted",
        run_id: String(runId),
        run_attempt: String(attempt),
      }
      if (
        ready.leaseId !== leaseId ||
        ready.repository !== policy.repository ||
        ready.repositoryId !== policy.repositoryId ||
        ready.workflowSha !== policy.workflowSha ||
        ready.appActorId !== policy.appActorId ||
        ready.runId !== runId ||
        ready.attempt !== attempt ||
        Object.entries(claims).some(([key, value]) => ready.claims[key] !== value)
      )
        return yield* Effect.fail(
          new SandboxError({ message: "Sandbox readiness identity mismatch" }),
        )
      return ready
    })
    const resolveSource = Effect.fn("SandboxGithub.resolveSource")(function* (
      policy: SandboxPolicy,
      ref: string,
    ) {
      const client = yield* scoped(policy)
      const result = yield* request(
        client,
        "GET",
        `/repos/${policy.repository}/commits/${encodeURIComponent(ref)}`,
      )
      if (result.status !== 200) return yield* Effect.fail(githubFailure())
      const commit = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)) }),
      )(result.data)
      return commit.sha
    })
    const verifyWorkflow = Effect.fn("SandboxGithub.verifyWorkflow")(function* (
      policy: SandboxPolicy,
    ) {
      const client = yield* scoped(policy)
      for (const file of ["agent-sandbox.yml", "agent-sandbox-caller.yml"]) {
        const result = yield* request(
          client,
          "GET",
          `/repos/${policy.repository}/contents/.github/workflows/${file}`,
          { ref: policy.workflowSha },
        )
        if (result.status !== 200)
          return yield* Effect.fail(
            new SandboxError({ message: "Pinned sandbox workflow is not published" }),
          )
      }
    })
    return {
      ensureRef,
      runs,
      savedRun,
      inventory,
      cancel,
      deleteRef,
      readiness,
      resolveSource,
      verifyWorkflow,
    }
  })
