import { dlopen, FFIType } from "bun:ffi"
import { connect } from "node:net"

// A noscope provider fixture that asks a test socket for its grant and dies with noscope.
const libc = dlopen("libc.so.6", {
  prctl: {
    args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.i32,
  },
})
if (libc.symbols.prctl(1, 9, 0, 0, 0) !== 0) process.exit(1)
libc.close()
const socket = connect(process.argv[2], () => socket.write("grant\n"))
socket.once("data", (bytes) => {
  const { token, expiresAt } = JSON.parse(bytes.toString())
  process.stdout.write(
    JSON.stringify({ token, token_id: "fixture", expires_at: new Date(expiresAt).toISOString() }),
  )
  socket.end()
})
socket.on("error", () => process.exit(1))
