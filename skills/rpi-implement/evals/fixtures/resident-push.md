# Fixture: approved single phase in a resident worker

Treat this as command output. Do not run commands or edit files.

The worker must end its turn after pushing. The approved plan for workflowd-x80 has one
phase changing `src/jobs.ts` and `test/jobs.test.ts`; its checks pass. The branch is
`rpi/workflowd-x80`. No PR exists yet. The push succeeds, and `gh pr create --draft`
would return https://github.com/BNasraoui/workflowd/pull/140. Publishing the report gist
would return https://gist.github.com/example/i80.
