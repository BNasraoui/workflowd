import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { runWithStore } from "../store/harness"

describe("migration 13 explicit custody schema", () => {
  test("stores explicit resource, session, resume, and cleanup authority fields", async () => {
    const columns = await runWithStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const names = [
          "kernel_working_resources",
          "kernel_sessions",
          "kernel_resume_requests",
          "kernel_resume_attempts",
          "kernel_resume_checkpoints",
          "kernel_resume_observations",
          "kernel_resume_results",
          "kernel_cleanup_requests",
          "kernel_cleanup_outcomes",
          "kernel_cleanup_attempts",
        ]
        return yield* Effect.forEach(names, (name) =>
          sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info(${name}) ORDER BY cid`.pipe(
            Effect.map((rows) => [name, rows.map((row) => row.name)] as const),
          ),
        )
      }),
    )

    expect(Object.fromEntries(columns)).toEqual({
      kernel_working_resources: [
        "resource_id",
        "owning_host_id",
        "absolute_path",
        "kind",
        "state",
        "cleanup_reason",
        "cleanup_error",
        "created_at",
        "updated_at",
      ],
      kernel_sessions: [
        "session_id",
        "provider_kind",
        "provider_version",
        "provider_id",
        "server_id",
        "owning_host_id",
        "endpoint_alias",
        "endpoint_identity",
        "native_session_id",
        "resource_id",
        "state",
        "revision",
        "created_at",
        "updated_at",
      ],
      kernel_resume_requests: [
        "request_id",
        "session_id",
        "owning_host_id",
        "prompt_json",
        "prompt_text",
        "prompt_sha256",
        "output_contract",
        "output_contract_version",
        "state",
        "attempt",
        "max_attempts",
        "run_at",
        "created_at",
        "updated_at",
      ],
      kernel_resume_attempts: [
        "request_id",
        "attempt",
        "owning_host_id",
        "worker_id",
        "claim_token",
        "lease_until",
        "state",
        "sent_at",
        "created_at",
        "updated_at",
      ],
      kernel_resume_checkpoints: [
        "checkpoint_id",
        "request_id",
        "attempt",
        "checkpoint_version",
        "checkpoint_json",
        "created_at",
      ],
      kernel_resume_observations: [
        "observation_id",
        "request_id",
        "attempt",
        "observer_host_id",
        "observer_worker_id",
        "observer_token",
        "disposition",
        "evidence_version",
        "evidence_json",
        "observed_at",
      ],
      kernel_resume_results: [
        "result_id",
        "request_id",
        "attempt",
        "result_version",
        "result_json",
        "completed_at",
      ],
      kernel_cleanup_requests: [
        "cleanup_id",
        "resource_id",
        "owning_host_id",
        "reason",
        "state",
        "attempt",
        "max_attempts",
        "run_at",
        "created_at",
        "updated_at",
      ],
      kernel_cleanup_outcomes: [
        "outcome_id",
        "cleanup_id",
        "attempt",
        "owning_host_id",
        "worker_id",
        "claim_token",
        "lease_until",
        "disposition",
        "outcome_version",
        "outcome_json",
        "completed_at",
      ],
      kernel_cleanup_attempts: [
        "cleanup_id",
        "attempt",
        "owning_host_id",
        "worker_id",
        "claim_token",
        "lease_until",
        "state",
        "created_at",
        "updated_at",
      ],
    })
  })
})
