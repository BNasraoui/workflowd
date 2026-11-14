import { expect, spyOn, test } from "bun:test"
import * as filesystem from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { saveSandboxFile } from "../../src/sandbox/binding"

// Run this file in its own isolated test process. Every injected operation is
// limited to this test's directory; handles and all other filesystem effects are real.
for (const fault of ["write", "sync", "close", "rename", "link"] as const) {
  test(`atomic custody removes owned temporaries after repeated ${fault} failures`, async () => {
    const directory = await filesystem.mkdtemp(join(tmpdir(), "binding-write-"))
    const target = join(directory, "snapshot.json")
    await filesystem.writeFile(target, "old snapshot", { mode: 0o600 })
    const originalOpen = filesystem.open
    const originalRename = filesystem.rename
    const originalLink = filesystem.link
    const handles: filesystem.FileHandle[] = []
    const failure = new Error(`fixture ${fault} failure`)
    const opening = spyOn(filesystem, "open").mockImplementation(async (path, flags, mode) => {
      const file = await originalOpen(path, flags, mode)
      if (typeof path === "string" && path.startsWith(target + "-") && flags === "wx") {
        handles.push(file)
        if (fault === "write") {
          const write = file.writeFile.bind(file)
          spyOn(file, "writeFile").mockImplementation(async () => {
            await write("partial private snapshot")
            throw failure
          })
        }
        if (fault === "sync") {
          const sync = file.sync.bind(file)
          spyOn(file, "sync").mockImplementation(async () => {
            await sync()
            throw failure
          })
        }
        if (fault === "close") {
          const close = file.close.bind(file)
          spyOn(file, "close").mockImplementation(async () => {
            await close()
            throw failure
          })
        }
      }
      return file
    })
    const renaming = spyOn(filesystem, "rename").mockImplementation(async (from, to) => {
      if (fault === "rename" && to === target) throw failure
      await originalRename(from, to)
    })
    const linking = spyOn(filesystem, "link").mockImplementation(async (from, to) => {
      if (fault === "link" && to === target) throw failure
      await originalLink(from, to)
    })
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        await expect(
          saveSandboxFile(directory, "snapshot.json", "new snapshot", fault === "link"),
        ).rejects.toBe(failure)
      }
      expect(handles).toHaveLength(4)
      for (const file of handles) expect(file.fd).toBe(-1)
      expect(await filesystem.readFile(target, "utf8")).toBe("old snapshot")
      expect((await filesystem.stat(target)).mode & 0o777).toBe(0o600)
      expect(await filesystem.readdir(directory)).toEqual(["snapshot.json"])
    } finally {
      opening.mockRestore()
      renaming.mockRestore()
      linking.mockRestore()
      await filesystem.rm(directory, { recursive: true, force: true })
    }
  })
}

test("atomic custody replaces and exclusively creates durable private snapshots", async () => {
  const directory = await filesystem.mkdtemp(join(tmpdir(), "binding-success-"))
  const originalOpen = filesystem.open
  const handles: filesystem.FileHandle[] = []
  const synchronized: string[] = []
  const opening = spyOn(filesystem, "open").mockImplementation(async (path, flags, mode) => {
    const file = await originalOpen(path, flags, mode)
    if (typeof path === "string" && (path === directory || path.startsWith(directory + "/"))) {
      handles.push(file)
      const sync = file.sync.bind(file)
      spyOn(file, "sync").mockImplementation(async () => {
        await sync()
        synchronized.push(path === directory ? "directory" : "file")
      })
    }
    return file
  })
  try {
    await filesystem.writeFile(join(directory, "snapshot.json"), "old", { mode: 0o600 })
    expect(await saveSandboxFile(directory, "snapshot.json", "replacement")).toBe(true)
    expect(await saveSandboxFile(directory, "snapshot.json", "collision", true)).toBe(false)
    expect(await saveSandboxFile(directory, "exclusive.json", "created", true)).toBe(true)
    expect(await filesystem.readFile(join(directory, "snapshot.json"), "utf8")).toBe("replacement")
    expect(await filesystem.readFile(join(directory, "exclusive.json"), "utf8")).toBe("created")
    expect((await filesystem.readdir(directory)).sort()).toEqual([
      "exclusive.json",
      "snapshot.json",
    ])
    for (const name of ["exclusive.json", "snapshot.json"])
      expect((await filesystem.stat(join(directory, name))).mode & 0o777).toBe(0o600)
    for (const file of handles) expect(file.fd).toBe(-1)
    expect(synchronized).toEqual(["file", "directory", "file", "directory", "file", "directory"])
  } finally {
    opening.mockRestore()
    await filesystem.rm(directory, { recursive: true, force: true })
  }
})

test("failed wx acquisition never removes the foreign temporary", async () => {
  const directory = await filesystem.mkdtemp(join(tmpdir(), "binding-collision-"))
  const target = join(directory, "snapshot.json")
  await filesystem.writeFile(target, "old", { mode: 0o600 })
  const originalOpen = filesystem.open
  let foreign = ""
  const opening = spyOn(filesystem, "open").mockImplementation(async (path, flags, mode) => {
    if (typeof path === "string" && path.startsWith(target + "-") && flags === "wx") {
      foreign = path
      const owner = await originalOpen(path, "wx", 0o600)
      try {
        await owner.writeFile("foreign owner")
      } finally {
        await owner.close()
      }
    }
    return originalOpen(path, flags, mode)
  })
  try {
    await expect(saveSandboxFile(directory, "snapshot.json", "new")).rejects.toMatchObject({
      code: "EEXIST",
    })
    expect(await filesystem.readFile(foreign, "utf8")).toBe("foreign owner")
    expect(await filesystem.readFile(target, "utf8")).toBe("old")
    expect((await filesystem.readdir(directory)).length).toBe(2)
  } finally {
    opening.mockRestore()
    await filesystem.rm(directory, { recursive: true, force: true })
  }
})

test("cleanup failure remains a failure and never removes the published target", async () => {
  const directory = await filesystem.mkdtemp(join(tmpdir(), "binding-cleanup-"))
  const target = join(directory, "snapshot.json")
  await filesystem.writeFile(target, "old", { mode: 0o600 })
  const originalOpen = filesystem.open
  const originalRm = filesystem.rm
  const handles: filesystem.FileHandle[] = []
  const failure = new Error("fixture cleanup failure")
  const opening = spyOn(filesystem, "open").mockImplementation(async (path, flags, mode) => {
    const file = await originalOpen(path, flags, mode)
    if (typeof path === "string" && path.startsWith(target + "-") && flags === "wx") {
      handles.push(file)
      spyOn(file, "sync").mockRejectedValue(new Error("fixture sync failure"))
    }
    return file
  })
  const removing = spyOn(filesystem, "rm").mockImplementation(async (path, options) => {
    if (typeof path === "string" && path.startsWith(target + "-")) throw failure
    await originalRm(path, options)
  })
  try {
    await expect(saveSandboxFile(directory, "snapshot.json", "new")).rejects.toBe(failure)
    expect(await filesystem.readFile(target, "utf8")).toBe("old")
    expect((await filesystem.readdir(directory)).length).toBe(2)
    for (const file of handles) expect(file.fd).toBe(-1)
  } finally {
    opening.mockRestore()
    removing.mockRestore()
    await filesystem.rm(directory, { recursive: true, force: true })
  }
})

test("directory fsync failure after rename reports uncertainty without deleting new publication", async () => {
  const directory = await filesystem.mkdtemp(join(tmpdir(), "binding-directory-sync-"))
  const target = join(directory, "snapshot.json")
  await filesystem.writeFile(target, "old", { mode: 0o600 })
  const originalOpen = filesystem.open
  const handles: filesystem.FileHandle[] = []
  const failure = new Error("fixture directory fsync failure")
  const opening = spyOn(filesystem, "open").mockImplementation(async (path, flags, mode) => {
    const file = await originalOpen(path, flags, mode)
    if (typeof path === "string" && (path === directory || path.startsWith(target + "-"))) {
      handles.push(file)
      if (path === directory) spyOn(file, "sync").mockRejectedValue(failure)
    }
    return file
  })
  try {
    await expect(saveSandboxFile(directory, "snapshot.json", "new")).rejects.toBe(failure)
    expect(await filesystem.readFile(target, "utf8")).toBe("new")
    expect((await filesystem.stat(target)).mode & 0o777).toBe(0o600)
    expect(await filesystem.readdir(directory)).toEqual(["snapshot.json"])
    expect(handles).toHaveLength(2)
    for (const file of handles) expect(file.fd).toBe(-1)
  } finally {
    opening.mockRestore()
    await filesystem.rm(directory, { recursive: true, force: true })
  }
})
