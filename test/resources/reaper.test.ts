import { expect, test } from "bun:test"
import { reap, type Resource, type Backend } from "./reaper"
import { owner } from "./owner"

function fixture() {
  const stale = owner().split(".")
  stale[6] = "0"
  const resources: Resource[] = [
    { kind: "container", id: "live", owner: owner() },
    { kind: "container", id: "unlabelled" },
    { kind: "container", id: "foreign", owner: "foreign" },
    ...["container", "network", "volume", "unit"].map((kind) => ({
      kind,
      id: kind,
      owner: stale.join("."),
    })),
  ]
  const removed: string[] = []
  const backend: Backend = {
    list: () => [...resources],
    remove: (resource) => {
      removed.push(resource.id)
      resources.splice(resources.indexOf(resource), 1)
    },
  }
  return { resources, removed, backend }
}

test("startup sweep removes only dead labelled owners in dependency order", () => {
  const { backend, removed, resources } = fixture()
  reap(backend)
  expect(removed).toEqual(["unit", "container", "network", "volume"])
  expect(resources.map((r) => r.id)).toEqual(["live", "unlabelled", "foreign"])
})

test("a failed removal does not prevent other cleanup, and survivors fail the suite", () => {
  const { backend, removed } = fixture()
  const remove = backend.remove
  backend.remove = (resource) => {
    if (resource.kind === "container") throw new Error("injected rm failure")
    remove(resource)
  }
  expect(() => reap(backend)).toThrow("container")
  expect(removed).toEqual(["unit", "network", "volume"])
})

test("teardown may clean its own live owner but never another active run", () => {
  const { backend, removed } = fixture()
  reap(backend, owner())
  expect(removed).toContain("live")
})
