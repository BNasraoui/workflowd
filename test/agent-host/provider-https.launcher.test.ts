import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

for (const provider of ["Claude", "Codex"] as const)
  test(`R3 ${provider}: source-default kernel family refusal and opt-in verified HTTPS, invalid CA and redirect refusal`, async () => {
    const root = await mkdtemp(join(tmpdir(), "owner-https-"))
    const key = join(root, "key.pem")
    const certificate = join(root, "ca.pem")
    const access =
      provider === "Claude"
        ? "fixture-access"
        : `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`
    const unit = resolve("deploy/systemd/workflowd-agent-host.service")
    const dropin = resolve(
      "deploy/systemd/workflowd-agent-host.service.d/20-provider-access-https.conf.example",
    )
    const filter = resolve("test/agent-host/socket-families.py")
    const command = async (args: string[]) => {
      const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`fixture command failed: ${stderr}`)
      return stdout
    }
    try {
      await command([
        "/usr/bin/openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        certificate,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ])
      expect(await command(["/usr/bin/python3", filter, unit, "-"])).toBe(
        "fixture socket families verified\n",
      )
      let escaped = 0
      let requests = 0
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: { key: await readFile(key), cert: await readFile(certificate) },
        async fetch(request): Promise<Response> {
          if (new URL(request.url).pathname === "/escape") {
            escaped++
            return new Response("unexpected")
          }
          requests++
          expect(request.method).toBe("POST")
          expect(await request.json()).toEqual({
            grant_type: "refresh_token",
            refresh_token: "fixture-refresh",
            client_id: "fixture-client",
          })
          if (requests === 2) return Response.redirect(new URL("escape", request.url).href, 302)
          return Response.json({
            access_token: access,
            refresh_token: "fixture-next",
            expires_in: 3600,
            scope: "user:inference",
          })
        },
      })
      try {
        const script = join(root, "refresh.ts")
        await writeFile(
          script,
          `import { refresh${provider}Access } from ${JSON.stringify(resolve("src/agent-host/provider-access.ts"))};
const previous={accessToken:'old',refreshToken:'fixture-refresh',expiresAt:1,scopes:['user:inference'],accountId:'fixture-account',idToken:'fixture-id'};
const ca=await Bun.file(${JSON.stringify(certificate)}).text();
const request=(trusted)=>refresh${provider}Access('fixture-client',(url,input)=>{
if(url!==${JSON.stringify(provider === "Claude" ? "https://platform.claude.com/v1/oauth/token" : "https://auth.openai.com/oauth/token")}||input.redirect!=='error'||input.tls.rejectUnauthorized!==true) throw Error('fixed transport contract');
return fetch(${JSON.stringify(server.url.toString())},{...input,tls:{...input.tls,...(trusted?{ca}:{})}});
})(previous,new AbortController().signal);
try { await request(false); throw Error('invalid certificate accepted') } catch(error) { if(error.message==='invalid certificate accepted') throw error }
const value=await request(true); if(value?.accessToken!==${JSON.stringify(access)}) throw Error('valid TLS refused');
try { await request(true); throw Error('redirect accepted') } catch(error) { if(error.message==='redirect accepted') throw error }
console.log('fixture HTTPS verified');
`,
          { mode: 0o600 },
        )
        expect(
          await command(["/usr/bin/python3", filter, unit, dropin, process.execPath, script]),
        ).toBe("fixture HTTPS verified\n")
        expect(requests).toBe(2)
        expect(escaped).toBe(0)
      } finally {
        await server.stop(true)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15000)
