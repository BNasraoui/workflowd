import { expect, test } from "bun:test"
import { command } from "./harness"

test("denial inventory includes all listening ports and requires mint, peers and a second runner", async () => {
  const output = await command([
    process.execPath,
    "--eval",
    `
    import assert from 'node:assert/strict'
    import { denialTargets, assertProbeResults } from './scripts/evidence/sandbox-network.mjs'
    const ss='LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\\nLISTEN 0 128 127.0.0.1:8791 0.0.0.0:*\\nLISTEN 0 128 [::]:443 [::]:*\\nLISTEN 0 128 *:4222 *:*'
    const inventory=['mint','peer','second-runner'].map((role,i)=>({role,address:'100.64.0.'+(i+1),listeners:ss}))
    const targets=denialTargets(inventory)
    assert.equal(targets.length,12)
    assert.deepEqual(targets.slice(0,4).map(t=>t.port),[22,443,4222,8791])
    assert.throws(()=>denialTargets(inventory.slice(0,2)))
    assert.throws(()=>denialTargets([...inventory,{role:'peer',address:'invalid',listeners:ss}]))
    assert.throws(()=>denialTargets(inventory.map(x=>({...x,listeners:''}))))
    const results=targets.map(t=>({...t,result:'timeout'}))
    assertProbeResults(targets,results,'timeout')
    assert.throws(()=>assertProbeResults(targets,results.slice(1),'timeout'))
    for (const result of ['connected','refused','other_error'])
      assert.throws(()=>assertProbeResults(targets,[{...results[0],result},...results.slice(1)],'timeout'))
    assert.throws(()=>assertProbeResults(targets,results.map(x=>({...x,port:1})),'timeout'))
    console.log('passed')
  `,
  ])
  expect(output).toBe("passed")
})

test("connection probes distinguish listening ports, refusals and command failures", async () => {
  expect(
    await command([
      process.execPath,
      "--eval",
      `
    import assert from 'node:assert/strict'
    import { connectionScript, executeProbe, assertProbeResults } from './scripts/evidence/sandbox-network.mjs'
    const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('control')})
    const targets=[{host:'127.0.0.1',port:server.port}]
    try {
      assertProbeResults(targets,JSON.parse(await executeProbe(['python3','-'],connectionScript(targets))),'connected')
    } finally { await server.stop(true) }
    assertProbeResults(targets,JSON.parse(await executeProbe(['python3','-'],connectionScript(targets))),'refused')
    await assert.rejects(executeProbe(['python3','-'],'raise RuntimeError()'))
    await assert.rejects(executeProbe(['python3','-'],'import time;time.sleep(10)',50))
    console.log('passed')
  `,
    ]),
  ).toBe("passed")
})
