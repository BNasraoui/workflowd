import { access } from "node:fs/promises"
import { Effect, Schema } from "effect"
import type { SessionReference } from "./agent-harness"
import type { OpenCodeAdapter } from "./opencode/adapter"

const SessionReferenceId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))

export const SessionAccess = Schema.Union(
  Schema.TaggedStruct("Available", {
    sessionReferenceId: SessionReferenceId,
    command: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(8192)),
  }),
  Schema.TaggedStruct("Unavailable", {
    sessionReferenceId: SessionReferenceId,
    reason: Schema.Literal(
      "missing",
      "expired",
      "aborted",
      "failed",
      "superseded",
      "endpoint_mismatch",
      "directory_missing",
      "unreachable",
    ),
  }),
)
export type SessionAccess = typeof SessionAccess.Type

export type SessionEndpoint = {
  readonly serverId: string
  readonly endpointAlias: string
  readonly attachUrl: string
}

export class SessionAccessResolver {
  constructor(
    private readonly openCode: OpenCodeAdapter,
    private readonly endpoint: SessionEndpoint,
    private readonly directoryExists: (directory: string) => Promise<boolean> = async (directory) =>
      access(directory).then(
        () => true,
        () => false,
      ),
  ) {}

  resolve(reference: SessionReference): Effect.Effect<SessionAccess> {
    if (
      reference.serverId !== this.endpoint.serverId ||
      reference.endpointAlias !== this.endpoint.endpointAlias
    ) {
      return Effect.succeed(this.unavailable(reference, "endpoint_mismatch"))
    }
    if (
      reference.state === "failed" ||
      reference.state === "superseded" ||
      reference.state === "aborted" ||
      reference.state === "expired"
    ) {
      return Effect.succeed(this.unavailable(reference, reference.state))
    }

    return Effect.tryPromise(() => this.directoryExists(reference.directory)).pipe(
      Effect.catchAll(() => Effect.succeed(false)),
      Effect.flatMap((exists) =>
        exists
          ? Effect.tryPromise((signal) =>
              this.openCode.sessionExists(
                { sessionID: reference.nativeSessionId, directory: reference.directory },
                signal,
              ),
            ).pipe(
              Effect.map((sessionExists) =>
                sessionExists
                  ? {
                      _tag: "Available" as const,
                      sessionReferenceId: reference.sessionReferenceId,
                      command: renderAttachCommand(this.endpoint.attachUrl, reference),
                    }
                  : this.unavailable(reference, "missing"),
              ),
              Effect.catchAll(() => Effect.succeed(this.unavailable(reference, "unreachable"))),
            )
          : Effect.succeed(this.unavailable(reference, "directory_missing")),
      ),
    )
  }

  private unavailable(
    reference: SessionReference,
    reason: Extract<SessionAccess, { readonly _tag: "Unavailable" }>["reason"],
  ): SessionAccess {
    return { _tag: "Unavailable", sessionReferenceId: reference.sessionReferenceId, reason }
  }
}

export function renderAttachCommand(attachUrl: string, reference: SessionReference): string {
  return [
    "opencode attach",
    shellQuote(attachUrl),
    "--dir",
    shellQuote(reference.directory),
    "--session",
    shellQuote(reference.nativeSessionId),
  ].join(" ")
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
