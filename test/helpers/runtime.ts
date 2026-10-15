import { Effect, Layer } from "effect"
import { AgentHarness } from "../../src/agent-harness"
import { GitHub } from "../../src/github"
import { InstallationGuard } from "../../src/installation-guard"
import { KernelSessionStoreLive } from "../../src/kernel/session-store"
import { Automation } from "../../src/opencode"
import { WorkSignalLive } from "../../src/work-signal"
import { Workspace } from "../../src/workspace"
import { kernelLayer as jobKernelLayer } from "../kernel/job-store-harness"

export const kernelLayer = (filename: string) =>
  KernelSessionStoreLive.pipe(Layer.provideMerge(jobKernelLayer(filename)))

export const qrspiDefinition = {
  contractVersion: 1,
  definitionVersion: 1,
  stages: [
    {
      key: "questions",
      kind: "document",
      contract: { name: "qrspi.questions", contractVersion: 1 },
      activation: { mode: "enabled" },
      definitionVersion: 1,
      maxEncodedInputBytes: 16_384,
      producer: {
        harness: { name: "opencode", version: 1 },
        agent: "qrspi-questions",
        model: "openai/gpt-5.6-sol",
        timeoutMs: 60_000,
        retry: { maxAttempts: 3, backoffMs: 1_000 },
      },
      outputPolicy: {
        _tag: "Artifact",
        pathTemplate: "docs/qrspi/{ticketId}/01-questions.md",
        mediaType: "text/markdown",
      },
      reviewPolicy: { mode: "none" },
      humanGatePolicy: { mode: "none" },
    },
  ],
}

/**
 * Every runtime adapter stubbed to die on use. Wiring tests merge extra
 * layers (logger, coordinator, stores) on top; pass an Automation stub to
 * observe availability validation instead of ignoring it.
 */
export const automationStub = (
  validateAvailability: () => Effect.Effect<void> = () => Effect.void,
) => ({
  validateAvailability,
  prepareReview: () => Effect.die("unexpected review"),
  prepareFix: () => Effect.die("unexpected fix"),
})

export const stubAdapters = (automation = automationStub()) =>
  Layer.mergeAll(
    WorkSignalLive,
    Layer.succeed(InstallationGuard, {
      handle: () => Effect.succeed(undefined),
      reconcile: () => Effect.succeed(true),
      runWebhooks: Effect.never,
      health: () =>
        Effect.succeed({
          lastSuccessfulReconciliationAt: null,
          undecodableInstallations: 0,
          status: "degraded",
        }),
    }),
    Layer.succeed(GitHub, {
      fetchPullRequestSnapshot: () => Effect.die("unexpected fetch"),
      publishReview: () => Effect.die("unexpected publish"),
      collectHeadEvidence: () => Effect.die("unexpected evidence collection"),
    }),
    Layer.succeed(Automation, automation),
    Layer.succeed(AgentHarness, {
      describe: () => Effect.die("unexpected harness description"),
      validateAvailability: () => Effect.die("unexpected harness validation"),
      prepare: () => Effect.die("unexpected harness preparation"),
      createSession: () => Effect.die("unexpected session creation"),
      resumeSession: () => Effect.die("unexpected session resume"),
      abortSession: () => Effect.die("unexpected session abort"),
    }),
    Layer.succeed(Workspace, {
      prepareReview: () => Effect.die("unexpected review workspace"),
      prepareFix: () => Effect.die("unexpected fix workspace"),
      publishFix: () => Effect.die("unexpected fix publication"),
    }),
  )
