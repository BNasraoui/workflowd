import { command, type runnerFixture } from "../harness"
import { readFile, readlink, stat } from "node:fs/promises"

export async function engineHostBoundaryFixture(runner: Awaited<ReturnType<typeof runnerFixture>>) {
  const alias = "workflowd-sandbox-runner:fixture"
  if (process.env.WORKFLOWD_SANDBOX_PREBUILT === "1") {
    const images: { runner: string } = JSON.parse(
      await command(["python3", "scripts/evidence/legacy-admit.py"]),
    )
    if (images.runner !== "sha256:2a0710fd65eacdf289028e3c090842bf8bb044d887549e522c8c55c2983c5652")
      throw new Error("Private boundary runner image differs")
    await runner.docker("tag", images.runner, alias)
    if ((await runner.docker("image", "inspect", "--format", "{{.Id}}", alias)) !== images.runner)
      throw new Error("Private boundary runner alias differs")
  }
  const image = await runner.docker("image", "inspect", "--format", "{{.Id}}", alias)
  if ((await runner.docker("info", "--format", "{{.Driver}}")) !== "overlay2")
    throw new Error("Private boundary storage driver differs")
  const setup = `${process.cwd()}/test/sandbox/fixtures/engine-host-boundary.sh`
  const container = `${runner.name}-boundary`
  const close = () => runner.docker("rm", "--force", container)
  await runner.docker(
    "create",
    "--name",
    container,
    "--network",
    "none",
    "--privileged",
    "--user",
    "root",
    "--ipc=private",
    "--cgroupns=private",
    "--memory=256m",
    "--memory-swap=256m",
    "--cpus=1",
    "--pids-limit=64",
    "--read-only",
    "--tmpfs",
    "/run:rw,nosuid,nodev,mode=0755,size=16m",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,mode=1777,size=16m",
    "--entrypoint",
    "sh",
    "-v",
    `${setup}:/setup.sh:ro`,
    alias,
    "-c",
    "exec sleep 120",
  )
  try {
    const config: { owner: string } = JSON.parse(
      await readFile(process.env.WORKFLOWD_TEST_RESOURCE_CONFIG!, "utf8"),
    )
    const configured = await runner.docker(
      "inspect",
      "--format",
      '{{.Image}} {{.HostConfig.NetworkMode}} {{.HostConfig.CgroupnsMode}} {{.HostConfig.IpcMode}} {{json .HostConfig.PidMode}} {{.HostConfig.Privileged}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}} {{index .Config.Labels "io.workflowd.test-run"}} {{index .Config.Labels "io.workflowd.test-fixture"}}',
      container,
    )
    if (
      configured !==
      `${image} none private private "" true true 268435456 268435456 1000000000 64 ${config.owner} ${runner.name}`
    )
      throw new Error("Private boundary container custody differs")
    const mounts: Array<{ Source: string; Destination: string; RW: boolean }> = JSON.parse(
      await runner.docker("inspect", "--format", "{{json .Mounts}}", container),
    )
    if (
      mounts.length !== 1 ||
      mounts[0]?.Source !== setup ||
      mounts[0].Destination !== "/setup.sh" ||
      mounts[0].RW
    )
      throw new Error("Private boundary mounts differ")
    await runner.docker("start", container)
    const namespaces = await Promise.all(
      ["net", "cgroup", "mnt", "pid"].map((name) => readlink(`/proc/self/ns/${name}`)),
    )
    const root = await stat("/")
    const source = await stat(setup)
    const custody = await runner.docker(
      "exec",
      container,
      "python3",
      "-c",
      `
import json,os,pathlib,sys
assert os.getuid()==0 and os.getgid()==0
assert pathlib.Path('/proc/1/comm').read_text().strip()=='sleep'
namespaces=[os.readlink('/proc/self/ns/'+n) for n in ['net','cgroup','mnt','pid']]
assert all(a!=b for a,b in zip(namespaces,json.loads(sys.argv[1])))
root=os.stat('/');assert f'{root.st_dev}:{root.st_ino}'!=sys.argv[2]
source=os.stat('/setup.sh');assert f'{source.st_dev}:{source.st_ino}'==sys.argv[3]
assert pathlib.Path('/proc/self/cgroup').read_text().strip() in ['0::/','1:net_cls:/\\n0::/']
limits={n:pathlib.Path('/sys/fs/cgroup/'+n).read_text().strip() for n in ['memory.max','memory.swap.max','cpu.max','pids.max']}
assert limits=={'memory.max':'268435456','memory.swap.max':'0','cpu.max':'100000 100000','pids.max':'64'}
assert not any(pathlib.Path(p).exists() for p in ['/var/run/docker.sock','/run/owned-engine','/private-engine','/run/systemd/private','/run/user/0/bus','/source','/evidence','/root/.config','/root/.ssh'])
mountinfo=pathlib.Path('/proc/self/mountinfo').read_text()
for target in ['/','/setup.sh']:
 row=next(line.split(' - ')[0].split() for line in mountinfo.splitlines() if line.split()[4]==target)
 assert 'ro' in row[5].split(',')
assert sorted(p.name for p in pathlib.Path('/sys/class/net').iterdir())==['lo']
print(json.dumps({'namespaces':namespaces,'limits':limits,'mountinfo':mountinfo}))
`,
      JSON.stringify(namespaces),
      `${root.dev}:${root.ino}`,
      `${source.dev}:${source.ino}`,
    )
    const live: unknown = JSON.parse(custody)
    return {
      custody: { configured, mounts, live },
      probe: () =>
        runner.docker(
          "exec",
          container,
          "sh",
          "-c",
          `set -eu
sh /setup.sh
ip netns exec host cat /sys/class/net/wfd-sandbox0/address
ip -n host link add temporary address 00:00:00:00:00:01 type veth peer name temporary-peer
ip -n host link set temporary master wfd-sandbox0
ip netns exec host cat /sys/class/net/wfd-sandbox0/address
ip -n host link del temporary
ip netns exec host cat /sys/class/net/wfd-sandbox0/address`,
        ),
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
