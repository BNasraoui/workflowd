import { dlopen, FFIType, ptr, read } from "bun:ffi"

const errnoNames: Readonly<Record<number, string>> = {
  2: "ENOENT",
  13: "EACCES",
  104: "ECONNRESET",
  111: "ECONNREFUSED",
}

/**
 * Sends `request` on the Unix socket `path` with libc's calls through Bun's FFI, and reads until
 * the server ends the connection: the status line of the answer, `ended` when the connection
 * ends with no byte of an answer, or `error` and the errno of the connect. Bun's own client
 * reports a connection that the server ends at accept as a refused connect; the kernel's calls
 * tell the two apart. It blocks this thread until the end, so the server must be another process.
 */
export function unixCall(path: string, request: string) {
  const libc = dlopen("libc.so.6", {
    socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    connect: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    send: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
    recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  })
  try {
    // AF_UNIX and SOCK_STREAM are 1; a sockaddr_un is the family, then the path and its NUL.
    const fd = libc.symbols.socket(1, 1, 0)
    if (fd < 0) throw new Error("no socket")
    try {
      const address = Buffer.alloc(110)
      address.writeUInt16LE(1, 0)
      address.write(path, 2)
      if (libc.symbols.connect(fd, ptr(address), 2 + Buffer.byteLength(path) + 1) !== 0) {
        const where = libc.symbols.__errno_location()
        const code = where === null ? -1 : read.i32(where, 0)
        return `error ${errnoNames[code] ?? String(code)}`
      }
      const bytes = Buffer.from(request)
      // MSG_NOSIGNAL: on a connection that the server ended, send gives EPIPE, not SIGPIPE.
      libc.symbols.send(fd, ptr(bytes), bytes.length, 0x4000)
      const chunk = Buffer.alloc(65536)
      const parts: Buffer[] = []
      for (;;) {
        const size = Number(libc.symbols.recv(fd, ptr(chunk), chunk.length, 0))
        if (size <= 0) break
        parts.push(Buffer.from(chunk.subarray(0, size)))
      }
      const answer = Buffer.concat(parts)
      return answer.length === 0 ? "ended" : (answer.toString("latin1").split("\r\n")[0] ?? "")
    } finally {
      libc.symbols.close(fd)
    }
  } finally {
    libc.close()
  }
}
