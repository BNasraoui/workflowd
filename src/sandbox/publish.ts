import type { AgentRunRecord } from "../kernel/agent-run-store"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { saveSandboxFile } from "./binding"
import type { makeSandboxLeaseService } from "./lease"
import { Effect, Schema } from "effect"
import type { makeSandboxGithub } from "./github"
import type { SandboxPolicy } from "./config"
import { makeSandboxStore, SandboxError } from "./store"
import { makePublishStore, PublicationReceipt, type PublishIntent } from "./publish-store"
import { readSandboxSubmission } from "./submission"

export const SandboxTerminal = Schema.Struct({
  state: Schema.Literals(["completed", "cancelled", "failed", "operator_required"]),
  sessionId: Schema.NullOr(Schema.String),
  finalMessage: Schema.NullOr(Schema.String),
  diagnostic: Schema.String,
})

const Environment = Schema.Struct({ id: Schema.Int, name: Schema.String })
const Reviews = Schema.Array(
  Schema.Struct({
    state: Schema.String,
    comment: Schema.String,
    user: Schema.Struct({ id: Schema.Int, type: Schema.Literal("Bot") }),
    environments: Schema.Array(Environment),
  }),
)
const Jobs = Schema.Struct({
  total_count: Schema.Int,
  jobs: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      name: Schema.String,
      run_id: Schema.Int,
      run_attempt: Schema.Int,
      head_sha: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
    }),
  ),
})
const Artifacts = Schema.Struct({
  total_count: Schema.Int,
  artifacts: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      name: Schema.String,
      digest: Schema.String,
      size_in_bytes: Schema.Int,
      expired: Schema.Boolean,
      workflow_run: Schema.Struct({
        id: Schema.Int,
        repository_id: Schema.Int,
        head_repository_id: Schema.Int,
        head_sha: Schema.String,
        head_branch: Schema.String,
      }),
    }),
  ),
})
const fail = () => new SandboxError({ message: "Publication identity or protection mismatch" })

export function approvalComment(intent: PublishIntent): string {
  return JSON.stringify({
    v: intent.base_ref === null ? 1 : 2,
    run: intent.actions_run_id,
    attempt: intent.attempt,
    artifact: intent.artifact_id,
    digest: intent.artifact_digest,
    source: intent.metadata.sourceSha,
    result: intent.metadata.resultSha,
    manifest: intent.metadata.manifestSha256,
    ...(intent.base_ref === null ? {} : { base: intent.base_ref }),
  })
}

export const makeSandboxPublisher = (
  github: Effect.Success<ReturnType<typeof makeSandboxGithub>>,
  remote: Effect.Success<ReturnType<typeof makeSandboxLeaseService>>,
) =>
  Effect.gen(function* () {
    const store = yield* makePublishStore
    const leases = yield* makeSandboxStore
    const environment = Effect.fn("SandboxPublisher.environment")(function* (
      policy: SandboxPolicy,
    ) {
      const env = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          ...Environment.fields,
          can_admins_bypass: Schema.Literal(false),
          deployment_branch_policy: Schema.Struct({
            protected_branches: Schema.Literal(false),
            custom_branch_policies: Schema.Literal(true),
          }),
          protection_rules: Schema.Array(Schema.Struct({ type: Schema.String })),
        }),
      )(yield* github.publishRequest(policy, "GET", "environments/agent-publish"))
      const rules = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          total_count: Schema.Literal(1),
          custom_deployment_protection_rules: Schema.Array(
            Schema.Struct({
              enabled: Schema.Literal(true),
              app: Schema.Struct({ id: Schema.Int, slug: Schema.String }),
            }),
          ),
        }),
      )(
        yield* github.publishRequest(
          policy,
          "GET",
          "environments/agent-publish/deployment_protection_rules",
        ),
      )
      const branches = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          total_count: Schema.Literal(1),
          branch_policies: Schema.Array(
            Schema.Struct({ name: Schema.String, type: Schema.String }),
          ),
        }),
      )(
        yield* github.publishRequest(
          policy,
          "GET",
          "environments/agent-publish/deployment-branch-policies",
        ),
      )
      if (
        env.id !== policy.publish?.environmentId ||
        env.name !== "agent-publish" ||
        env.protection_rules.some((rule) =>
          ["required_reviewers", "wait_timer"].includes(rule.type),
        ) ||
        rules.custom_deployment_protection_rules.length !== 1 ||
        rules.custom_deployment_protection_rules[0]?.app.id !== github.gateAppId ||
        branches.branch_policies.length !== 1 ||
        branches.branch_policies[0]?.name !== "workflowd/leases/*" ||
        branches.branch_policies[0]?.type !== "branch"
      )
        return yield* Effect.fail(fail())
    })
    const artifactFor = Effect.fn("SandboxPublisher.artifactFor")(function* (
      policy: SandboxPolicy,
      leaseId: string,
      intent: PublishIntent,
    ) {
      const artifacts = yield* Schema.decodeUnknownEffect(Artifacts)(
        yield* github.publishRequest(
          policy,
          "GET",
          `actions/runs/${intent.actions_run_id}/artifacts?per_page=100`,
        ),
      )
      const candidates = artifacts.artifacts.filter(
        (artifact) => artifact.name === `sandbox-result-${intent.actions_run_id}-${intent.attempt}`,
      )
      if (
        artifacts.total_count !== artifacts.artifacts.length ||
        artifacts.total_count > 100 ||
        candidates.length !== 1
      )
        return yield* Effect.fail(fail())
      const artifact = candidates[0]!
      if (
        artifact.expired ||
        artifact.size_in_bytes <= 0 ||
        artifact.size_in_bytes > 16 * 1048576 ||
        !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
        artifact.workflow_run.id !== intent.actions_run_id ||
        artifact.workflow_run.repository_id !== policy.repositoryId ||
        artifact.workflow_run.head_repository_id !== policy.repositoryId ||
        artifact.workflow_run.head_sha !== policy.workflowSha ||
        artifact.workflow_run.head_branch !== `workflowd/leases/${leaseId}` ||
        (intent.artifact_id !== null &&
          (intent.artifact_id !== artifact.id || intent.artifact_digest !== artifact.digest))
      )
        return yield* Effect.fail(fail())
      return artifact
    })
    const jobsFor = Effect.fn("SandboxPublisher.jobsFor")(function* (
      policy: SandboxPolicy,
      intent: PublishIntent,
    ) {
      const jobs = yield* Schema.decodeUnknownEffect(Jobs)(
        yield* github.publishRequest(
          policy,
          "GET",
          `actions/runs/${intent.actions_run_id}/attempts/${intent.attempt}/jobs?per_page=100`,
        ),
      )
      if (
        jobs.total_count !== jobs.jobs.length ||
        jobs.total_count > 100 ||
        jobs.jobs.some(
          (job) =>
            job.run_id !== intent.actions_run_id ||
            job.run_attempt !== intent.attempt ||
            job.head_sha !== policy.workflowSha,
        )
      )
        return yield* Effect.fail(fail())
      const runners = jobs.jobs.filter((job) => job.name === "sandbox / runner")
      const publishers = jobs.jobs.filter((job) => job.name === "agent-publish")
      if (runners.length !== 1 || publishers.length !== 1) return yield* Effect.fail(fail())
      return { runners, publishers }
    })
    const reconcile = Effect.fn("SandboxPublisher.reconcile")(function* (
      policy: SandboxPolicy,
      intent: PublishIntent,
      jobId: number,
    ) {
      const marker = `<!-- workflowd-publication:${Buffer.from(approvalComment(intent)).toString("base64")} -->`
      const branch = intent.metadata.branch
      let receipt = intent.receipt
      if (receipt === null) {
        const logs = yield* Schema.decodeUnknownEffect(
          Schema.String.check(Schema.isMaxLength(1048576)),
        )(yield* github.publishRequest(policy, "GET", `actions/jobs/${jobId}/logs`))
        const records = logs.split("\n").flatMap((line) => {
          const match =
            /^\d{4}-\d{2}-\d{2}T\S+Z workflowd\.publish\.receipt ([A-Za-z0-9+/=]+)\r?$/.exec(line)
          return match === null ? [] : [match[1]!]
        })
        if (records.length === 0 || records.length > 8) return yield* Effect.fail(fail())
        const raw = yield* Effect.try((): unknown =>
          JSON.parse(Buffer.from(records.at(-1)!, "base64").toString()),
        )
        const proof = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            ...PublicationReceipt.fields,
            binding: Schema.Json,
            repository: Schema.String,
            branch: Schema.String,
            marker: Schema.String,
          }),
        )(raw)
        if (
          JSON.stringify(proof.binding) !== approvalComment(intent) ||
          proof.repository !== policy.repository ||
          proof.branch !== intent.metadata.branch ||
          proof.marker !== marker
        )
          return yield* Effect.fail(fail())
        receipt = { stage: proof.stage, pr: proof.pr, revoked: proof.revoked }
        yield* store.saveReceipt(intent.run_id, receipt)
      }
      if (!receipt.revoked || !["creating_pr", "published"].includes(receipt.stage))
        return "operator_required" as const
      const ref = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ ref: Schema.String, object: Schema.Struct({ sha: Schema.String }) }),
      )(yield* github.publicationRead(policy, `git/ref/heads/${encodeURIComponent(branch)}`))
      if (ref.ref !== `refs/heads/${branch}` || ref.object.sha !== intent.metadata.resultSha)
        return yield* Effect.fail(fail())
      const repo = Schema.Struct({ id: Schema.Int, full_name: Schema.String })
      const pullSchema = Schema.Struct({
        number: Schema.Int,
        html_url: Schema.String,
        state: Schema.Literal("open"),
        draft: Schema.Literal(true),
        maintainer_can_modify: Schema.Literal(false),
        body: Schema.String,
        user: Schema.Struct({
          id: Schema.Int,
          login: Schema.Literal("ghettimonster[bot]"),
          type: Schema.Literal("Bot"),
        }),
        head: Schema.Struct({ ref: Schema.String, sha: Schema.String, repo }),
        base: Schema.Struct({ ref: Schema.String, repo }),
      })
      const found = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ number: Schema.Int.check(Schema.isGreaterThan(0)) })),
      )(
        yield* github.publicationRead(
          policy,
          "pulls?" +
            new URLSearchParams({
              state: "all",
              head: policy.repository.split("/")[0] + ":" + branch,
              base: intent.base_ref!,
              per_page: "100",
            }).toString(),
        ),
      )
      if (found.length !== 1) return yield* Effect.fail(fail())
      const pull = yield* Schema.decodeUnknownEffect(pullSchema)(
        yield* github.publicationRead(policy, `pulls/${found[0]!.number}`),
      )
      if (
        pull.number <= 0 ||
        pull.number !== found[0]!.number ||
        (receipt.pr !== null && receipt.pr !== pull.number) ||
        pull.html_url !== `https://github.com/${policy.repository}/pull/${pull.number}` ||
        pull.user.id !== policy.publish!.publisherActorId ||
        pull.head.ref !== branch ||
        pull.head.sha !== intent.metadata.resultSha ||
        pull.base.ref !== intent.base_ref ||
        pull.body !== marker ||
        [pull.head.repo, pull.base.repo].some(
          (repo) => repo.id !== policy.repositoryId || repo.full_name !== policy.repository,
        )
      )
        return yield* Effect.fail(fail())
      yield* store.saveReceipt(intent.run_id, {
        stage: "published",
        pr: pull.number,
        revoked: true,
      })
      return "published" as const
    })
    const poll = Effect.fn("SandboxPublisher.poll")(function* (runId: string) {
      const saved = yield* store.read(runId)
      const lease = yield* leases.read(runId)
      if (
        saved === null ||
        lease === null ||
        lease.policy.publish === undefined ||
        saved.actions_run_id !== lease.actions_run_id ||
        saved.attempt !== lease.actions_attempt ||
        saved.metadata.sourceSha !== lease.source_sha ||
        (saved.base_ref !== null && saved.base_ref !== lease.policy.publish.baseRef) ||
        lease.policy.publish.publisherAppId !== 5232172 ||
        lease.policy.publish.publisherActorId !== 339414993
      )
        return yield* Effect.fail(fail())
      let intent = saved
      if (["probed", "published", "operator_required", "cancelled"].includes(intent.phase))
        return intent.phase
      if (
        intent.base_ref === null ||
        (intent.deadline <= Date.now() && intent.phase === "sealed")
      ) {
        yield* store.advance(runId, intent.phase, "operator_required")
        return "operator_required"
      }
      const policy = lease.policy
      yield* github.savedRun(policy, lease.lease_id, intent.actions_run_id, intent.attempt)
      const prefix = `actions/runs/${intent.actions_run_id}`
      const { runners, publishers } = yield* jobsFor(policy, intent)
      const runner = runners[0]!
      if (intent.deadline <= Date.now() && publishers[0]?.status !== "completed") {
        yield* github.cancel(policy, intent.actions_run_id)
        return intent.phase
      }
      if (runner.status !== "completed") return intent.phase
      if (runner.conclusion !== "success") {
        yield* store.advance(runId, intent.phase, "operator_required")
        return "operator_required"
      }
      const artifact = yield* artifactFor(policy, lease.lease_id, intent)
      yield* environment(policy)
      if (intent.phase === "sealed") {
        const pending = yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              environment: Environment,
              wait_timer: Schema.Literal(0),
              reviewers: Schema.Array(Schema.Json),
            }),
          ),
        )(yield* github.publishRequest(policy, "GET", `${prefix}/pending_deployments`))
        if (
          pending.length !== 1 ||
          pending[0]?.environment.id !== policy.publish!.environmentId ||
          pending[0]?.environment.name !== "agent-publish" ||
          pending[0]?.reviewers.length !== 0
        )
          return yield* Effect.fail(fail())
        if (!(yield* store.claimApproval(runId, artifact.id, artifact.digest))) return "approving"
        intent = (yield* store.read(runId))!
        // Persist uncertainty BEFORE the side effect. A lost response is never blindly retried.
        yield* github.publishRequest(policy, "POST", `${prefix}/deployment_protection_rule`, {
          environment_name: "agent-publish",
          state: "approved",
          comment: approvalComment(intent),
        })
      }
      const reviews = yield* Schema.decodeUnknownEffect(Reviews)(
        yield* github.publishRequest(policy, "GET", `${prefix}/approvals`),
      )
      const matches = reviews.filter(
        (review) =>
          review.state === "approved" &&
          review.user.id === policy.appActorId &&
          review.user.type === "Bot" &&
          review.environments.some(
            (env) => env.id === policy.publish!.environmentId && env.name === "agent-publish",
          ) &&
          review.comment === approvalComment(intent),
      )
      if (matches.length !== 1) return yield* Effect.fail(fail())
      yield* store.advance(runId, "approving", "approved")
      if (publishers[0]?.status === "completed") {
        const phase = yield* reconcile(policy, intent, publishers[0].id).pipe(
          Effect.catch(() => Effect.succeed("operator_required" as const)),
        )
        yield* store.advance(runId, "approved", phase)
        return phase
      }
      if (intent.deadline <= Date.now()) {
        yield* store.advance(runId, "approved", "operator_required")
        return "operator_required"
      }
      return "approved"
    })
    const capture = Effect.fn("SandboxPublisher.capture")(function* (
      run: AgentRunRecord,
      completion: string,
    ) {
      const runId = run.runId
      const lease = yield* leases.read(runId)
      if (
        lease?.policy.publish === undefined ||
        lease.actions_run_id === null ||
        lease.actions_attempt === null
      )
        return yield* Effect.fail(fail())
      const submission = yield* Effect.tryPromise(() =>
        readSandboxSubmission(run.directory, runId, lease.lease_id, lease.session_id),
      )
      const metadata = yield* remote.finishResult(
        runId,
        submission === null ? completion : JSON.stringify(submission),
      )
      if (!("empty" in metadata))
        yield* store.seal({
          runId,
          actionsRunId: lease.actions_run_id,
          attempt: lease.actions_attempt,
          metadata,
          baseRef: lease.policy.publish.baseRef,
          deadline: Math.min(lease.deadline, Date.now() + 15 * 60000),
        })
    })
    const saveTerminal = Effect.fn("SandboxPublisher.saveTerminal")(function* (
      run: AgentRunRecord,
      terminal: typeof SandboxTerminal.Type,
    ) {
      const lease = yield* leases.read(run.runId)
      const pending = yield* Effect.tryPromise(() =>
        Bun.file(join(run.directory, "terminal.json")).exists(),
      )
      if (!pending) {
        yield* Effect.tryPromise(() => mkdir(run.directory, { recursive: true, mode: 0o700 }))
        let result = terminal
        if (
          terminal.state === "operator_required" &&
          lease?.state === "released" &&
          lease.actions_run_id === null
        )
          result = { ...terminal, state: "failed", diagnostic: "Sandbox ref creation rejected" }
        if (lease?.transport != null && lease.state !== "released") {
          const audited = yield* Effect.result(remote.audit(run.runId, run.directory))
          if (audited._tag === "Failure")
            result = {
              ...result,
              state: "operator_required",
              diagnostic: audited.failure.message,
            }
        }
        if (result.state === "completed" && lease?.policy.publish !== undefined) {
          const sealed = yield* capture(run, result.finalMessage ?? "").pipe(Effect.result)
          if (sealed._tag === "Failure")
            result = {
              ...result,
              state: "operator_required",
              diagnostic: `Sandbox result unavailable: ${String(sealed.failure)}`,
            }
        }
        const message =
          result.finalMessage === null
            ? null
            : Buffer.from(result.finalMessage).subarray(0, 1048573).toString("utf8")
        yield* Effect.tryPromise(() => saveSandboxFile(run.directory, "final.txt", message ?? ""))
        yield* Effect.tryPromise(() =>
          saveSandboxFile(
            run.directory,
            "terminal.json",
            JSON.stringify({ ...result, finalMessage: message }),
            true,
          ),
        )
      }
    })
    const continuePublication = Effect.fn("SandboxPublisher.continuePublication")(function* (
      run: AgentRunRecord,
      cancel = false,
    ) {
      const lease = yield* leases.read(run.runId)
      if (lease?.policy.publish === undefined) return false
      const intent = yield* store.read(run.runId)
      if (intent === null) return false
      // The intent is saved after quiescence/audit, before the terminal file. Recover
      // that crash window using metadata only; never re-run or re-seal agent work.
      if (
        !(yield* Effect.tryPromise(() => Bun.file(join(run.directory, "terminal.json")).exists()))
      ) {
        const finalMessage = JSON.stringify({ branch: intent.metadata.branch })
        yield* Effect.tryPromise(async () => {
          await saveSandboxFile(run.directory, "final.txt", finalMessage)
          await saveSandboxFile(
            run.directory,
            "terminal.json",
            JSON.stringify({
              state: "completed",
              sessionId: run.nativeSessionId,
              finalMessage,
              diagnostic: "Publication result recovered",
            }),
            true,
          )
        })
      }
      if (cancel && intent.phase === "sealed") {
        yield* store.advance(run.runId, intent.phase, "cancelled")
        yield* Effect.tryPromise(() =>
          saveSandboxFile(
            run.directory,
            "terminal.json",
            JSON.stringify({
              state: "cancelled",
              sessionId: run.nativeSessionId,
              finalMessage: null,
              diagnostic: "Publication cancelled before approval",
            }),
          ),
        )
      } else {
        if (cancel && ["approving", "approved"].includes(intent.phase))
          yield* github.cancel(lease.policy, intent.actions_run_id)
        if (intent.phase === "sealed") yield* remote.finish(run.runId).pipe(Effect.ignore)
        yield* poll(run.runId)
      }
      const settled = (yield* store.read(run.runId))!
      const phase = settled.phase
      if (!["probed", "published", "operator_required", "cancelled"].includes(phase)) return true
      if (phase === "published") {
        const finalMessage = JSON.stringify({
          repository: lease.policy.repository,
          branch: settled.metadata.branch,
          resultSha: settled.metadata.resultSha,
          base: settled.base_ref,
          pullRequest: `https://github.com/${lease.policy.repository}/pull/${settled.receipt!.pr}`,
        })
        yield* Effect.tryPromise(() =>
          saveSandboxFile(
            run.directory,
            "terminal.json",
            JSON.stringify({
              state: "completed",
              sessionId: run.nativeSessionId,
              finalMessage,
              diagnostic: "Draft PR publication confirmed",
            }),
          ),
        )
        yield* Effect.tryPromise(() => saveSandboxFile(run.directory, "final.txt", finalMessage))
      }
      if (phase === "operator_required")
        yield* Effect.tryPromise(() =>
          saveSandboxFile(
            run.directory,
            "terminal.json",
            JSON.stringify({
              state: "operator_required",
              sessionId: run.nativeSessionId,
              finalMessage: null,
              diagnostic: "Protected publication requires operator reconciliation",
            }),
          ),
        )
      return false
    })
    return { poll, saveTerminal, continuePublication }
  })
