import { Effect } from "effect"
import { runWorkspaceCommand } from "./command"
import { WorkspaceError } from "./errors"

/** Refuse links before checkout or context access, including reused review trees. */
export const requireSymlinkFreeReviewTree = (directory: string, ref = "HEAD") =>
  runWorkspaceCommand("inspect review tree", [
    "git",
    "-C",
    directory,
    "ls-tree",
    "-r",
    "-z",
    ref,
  ]).pipe(
    Effect.flatMap((tree) =>
      tree.split("\0").some((entry) => entry.startsWith("120000 "))
        ? Effect.fail(
            new WorkspaceError({
              operation: "validate review symlinks",
              cause: new Error("Review trees containing symlinks are not supported"),
            }),
          )
        : Effect.void,
    ),
  )
