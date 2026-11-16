import { dlopen, FFIType } from "bun:ffi"

/**
 * Whether this process is attached to its parent: the parent is not init, the kernel sends this
 * process `deathSignal` when the parent ends (PR_SET_PDEATHSIG), and the parent had not ended
 * before that was set. Noscope starts its provider commands in a process group of their own, so a
 * signal of the gateway's group does not reach them; the parent-death signal does.
 */
export function attachedToParent(deathSignal: number) {
  const parent = process.ppid
  const libc = dlopen("libc.so.6", {
    prctl: {
      args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
  })
  try {
    return (
      parent > 1 && libc.symbols.prctl(1, deathSignal, 0, 0, 0) === 0 && process.ppid === parent
    )
  } finally {
    libc.close()
  }
}
