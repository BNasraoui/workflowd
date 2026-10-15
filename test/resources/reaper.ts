import { ownerState } from "./owner"

export type Resource = { kind: string; id: string; owner?: string }
export type Backend = { list: () => Resource[]; remove: (resource: Resource) => void }

export function reap(backend: Backend, own?: string): void {
  const eligible = (resource: Resource) =>
    resource.owner !== undefined &&
    ((own !== undefined && resource.owner === own) || ownerState(resource.owner) === "dead")
  const order = ["unit", "container", "network", "volume"]
  const errors: unknown[] = []
  for (const resource of backend
    .list()
    .filter(eligible)
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))) {
    try {
      backend.remove(resource)
    } catch (error) {
      errors.push(error)
    }
  }
  const remaining = backend.list().filter(eligible)
  if (remaining.length)
    throw new AggregateError(
      errors,
      `Test resources survived cleanup: ${remaining.map((r) => `${r.kind}:${r.id}`).join(", ")}`,
    )
}
