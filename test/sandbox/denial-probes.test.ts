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
      assert.throws(()=>assertProbeResults(targets,[{...results[0],result},...results.slice(1)],'timeout'), {message:'Unexpected network result for 100.64.0.1:22: '+result+' (expected timeout)'})
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

test("runner-local targets, route inventory and firewall counters fail closed", async () => {
  expect(
    await command([
      process.execPath,
      "--eval",
      `
    import assert from 'node:assert/strict'
    import { runnerTargets, assertRunnerRoutes, dropCounters, assertDropsIncreased } from './scripts/evidence/sandbox-network.mjs'
    const local={addresses:['127.0.0.1','192.0.2.1','100.64.0.5','172.17.0.1'],gateway:'172.30.0.1',defaultGateway:'10.1.0.1'}
    const targets=runnerTargets(local)
    for(const host of ['10.1.0.1','192.0.2.1','100.64.0.5','172.17.0.1','172.30.0.1','169.254.169.254','168.63.129.16'])
      assert.ok(targets.some(t=>t.host===host))
    assert.ok(!targets.some(t=>t.host==='127.0.0.1'))
    assert.throws(()=>runnerTargets({...local,gateway:''}))
    assert.throws(()=>runnerTargets({...local,defaultGateway:''}))
    assertRunnerRoutes('100.64.0.2 dev tailscale0\\n100.100.100.100 dev tailscale0')
    assert.throws(()=>assertRunnerRoutes('10.0.0.0/8 dev tailscale0'))
    assert.throws(()=>assertRunnerRoutes('default dev tailscale0'))
    const before=dropCounters('[2:120] -A WFD-SANDBOX -d 169.254.0.0/16 -j DROP\\n[0:0] -A WFD-ENGINE -j DROP')
    const after=dropCounters('[3:180] -A WFD-SANDBOX -d 169.254.0.0/16 -j DROP\\n[1:60] -A WFD-ENGINE -j DROP')
    assertDropsIncreased(before,after,['WFD-SANDBOX','WFD-ENGINE'])
    assert.throws(()=>assertDropsIncreased(before,before,['WFD-SANDBOX']))
    assert.throws(()=>assertDropsIncreased({},after,['WFD-SANDBOX']))
    const tailBefore=dropCounters('[0:0] -A WFD-SANDBOX -o tailscale0 -j DROP')
    const tailAfter=dropCounters('[1:60] -A WFD-SANDBOX -o tailscale0 -j DROP')
    assertDropsIncreased(tailBefore,tailAfter,['WFD-SANDBOX:tailscale0'])
    assert.throws(()=>assertDropsIncreased(tailBefore,after,['WFD-SANDBOX:tailscale0']))
    console.log('passed')
  `,
    ]),
  ).toBe("passed")
})

test("Dagger http probes use engine requests and reject non-timeout GraphQL errors", async () => {
  expect(
    await command([
      process.execPath,
      "--eval",
      `
    import assert from 'node:assert/strict'
    import {httpScript,executeProbe,assertProbeResults} from './scripts/evidence/sandbox-network.mjs'
    const targets=[{host:'192.0.2.1',port:80}]
    let message='dial tcp 192.0.2.1:80: i/o timeout'
    const server=Bun.serve({port:0,async fetch(req){
      assert.equal(req.headers.get('authorization'),'Basic '+Buffer.from('fixture:').toString('base64'))
      const {query}=await req.json()
      assert.match(query,/http\\(url:/)
      assert.match(query,/contents/)
      return Response.json({errors:[{message}]})
    }})
    try {
      const script=httpScript(targets)
      const prefix='import os\\nos.environ["DAGGER_SESSION_PORT"]="'+server.port+'"\\nos.environ["DAGGER_SESSION_TOKEN"]="fixture"\\n'
      const run=async()=>JSON.parse((await executeProbe(['python3','-'],prefix+script)).split('WORKFLOWD_NETWORK=')[1])
      assertProbeResults(targets,await run(),'timeout')
      message='connection refused'
      await assert.rejects(async()=>assertProbeResults(targets,await run(),'timeout'))
      message='dial tcp 192.0.2.99:443: i/o timeout'
      await assert.rejects(async()=>assertProbeResults(targets,await run(),'timeout'))
      message='unknown field http'
      await assert.rejects(async()=>assertProbeResults(targets,await run(),'timeout'))
    } finally {await server.stop(true)}
    console.log('passed')
  `,
    ]),
  ).toBe("passed")
})
