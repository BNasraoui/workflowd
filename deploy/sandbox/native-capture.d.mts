export function captureNativeResult(options: {
  root: string
  directory: string
  tooling: string
  invocation: { nonce: string; session: string; state: string; outcome: string; container?: string }
  request: { nonce: string; session: string; completion: { branch: string; title: string; body: string; commitMessage: string } }
  backend: { exportWorkspace(): Promise<void> }
  command(args: string[], input?: string): Promise<string>
}): Promise<string>
