/**
 * The rules of a runner run's result: the bounds that the seal (result.py RESULT_BOUNDS) and the
 * daemon's check (src/kernel/sealed-result.ts) hold, and the same rules in plain words for the
 * agent, which the harness gives Claude Code. A test compares these bounds with the seal's, and
 * the shared table of cases (test/kernel/sealed-text-cases.ts) runs each rule on both sides.
 */

const MiB = 1024 * 1024

/** The bounds of one result's change. */
export const resultBounds = {
  /** The bytes of one added or changed file. */
  blobBytes: MiB,
  /** The bytes of all added or changed files together. */
  changedBytes: 8 * MiB,
  /** The paths that the change adds, changes or removes. */
  changedPaths: 100,
  commits: 100,
  objects: 10_000,
  objectBytes: 64 * MiB,
}

const mib = (bytes) => `${bytes / MiB} MiB`

/** What a result may hold, in plain words: the text that the harness adds to the agent's prompt. */
export const resultRules = `How the result of this run is taken:
- When you end, the work tree of /workdir is sealed as the run's result: each tracked file and each new file that Git does not ignore, judged against the commit that you started on. Commits that you make, branches and the .git directory are not read; leave the change in the work tree.
- Ignored files (dependencies, build output, caches) are left out, whatever their size or number.
- The result is refused, and the work of the run is lost, when the change does any of these:
  - adds or changes a symbolic link, a hard link or a special file;
  - adds an executable file, or changes the mode of a tracked file;
  - adds, changes or removes a path with a component that starts with ".git" (such as .gitignore, .gitattributes, .gitmodules or .github) or a path below deploy/sandbox;
  - names a path with a control character, a backslash, an invisible or format character, a line or paragraph separator, a name that is not in Unicode NFC form, or a name that differs from another path of the tree only by case or normal form;
  - holds a file over ${mib(resultBounds.blobBytes)}, more than ${mib(resultBounds.changedBytes)} of added or changed files, or more than ${resultBounds.changedPaths} changed paths;
  - holds text in the shape of a credential (a GitHub token, an Anthropic key or a private key).
- Before your last answer, remove from the work tree what the result must not hold.`
