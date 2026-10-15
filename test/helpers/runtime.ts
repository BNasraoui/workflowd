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

const unexpectedAdapterCall = () => Effect.die("unexpected runtime adapter call")

/**
 * Every runtime adapter stubbed to die on use. Wiring tests merge extra
 * layers (logger, coordinator, stores) on top; pass an Automation stub to
 * observe availability validation instead of ignoring it.
 */
export const automationStub = (
  validateAvailability: () => Effect.Effect<void> = () => Effect.void,
) => ({
  validateAvailability,
  prepareReview: unexpectedAdapterCall,
  prepareFix: unexpectedAdapterCall,
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
      fetchPullRequestSnapshot: unexpectedAdapterCall,
      publishReview: unexpectedAdapterCall,
      collectHeadEvidence: unexpectedAdapterCall,
    }),
    Layer.succeed(Automation, automation),
    Layer.succeed(AgentHarness, {
      describe: unexpectedAdapterCall,
      validateAvailability: unexpectedAdapterCall,
      prepare: unexpectedAdapterCall,
      createSession: unexpectedAdapterCall,
      resumeSession: unexpectedAdapterCall,
      abortSession: unexpectedAdapterCall,
    }),
    Layer.succeed(Workspace, {
      prepareReview: unexpectedAdapterCall,
      prepareFix: unexpectedAdapterCall,
      publishFix: unexpectedAdapterCall,
    }),
  )
