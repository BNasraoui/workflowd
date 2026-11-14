export function disposableSsh(
  command: (root: string) => string,
  address?: string,
  port?: number,
  diagnosticFile?: string,
  login?: string,
): Promise<{ root: string; key: string; args: string[]; close: () => Promise<void> }>
