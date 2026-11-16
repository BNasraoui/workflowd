import { readArchive } from "../../deploy/sandbox/command.mjs"

/**
 * One read of the directory `path` as a tar archive, by the read that a harness makes of its box's
 * stopped workspace: `stream`, and `done`, which fails when tar fails or its read is stopped.
 */
export const directoryArchive = (path) =>
  readArchive("workspace", "/usr/bin/tar", ["-cf", "-", "-C", path, "."])
