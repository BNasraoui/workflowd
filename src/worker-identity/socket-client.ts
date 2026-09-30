import { createConnection } from "node:net"
import { Schema } from "effect"

/** One bounded request per connection; no credentials in paths or arguments. */
export function requestRunSocket(
  socketPath: string,
  path: string,
  body?: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.setTimeout(15000, () => socket.destroy(new Error("Run socket timed out")))
    socket.on("connect", () => socket.write(JSON.stringify({ path, body }) + "\n"))
    let data = ""
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8")
      if (data.length > 65536) socket.destroy(new Error("Run socket response too large"))
    })
    socket.on("error", reject)
    socket.on("end", () => {
      try {
        const result = Schema.decodeUnknownSync(
          Schema.Struct({
            status: Schema.Int,
            body: Schema.String,
          }),
        )(JSON.parse(data))
        resolve(new Response(result.body, { status: result.status }))
      } catch (error) {
        reject(new Error("Invalid run socket response", { cause: error }))
      }
    })
  })
}
