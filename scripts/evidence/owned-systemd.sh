#!/bin/sh
# Runs only within the exact-owned outer container and its private engine.
set -eu
test "$(readlink /proc/self/ns/net)" != "$HOST_NETNS"
test "$(readlink /proc/self/ns/cgroup)" != "$HOST_CGROUPNS"
test "$DOCKER_HOST" = unix:///run/owned-engine/docker.sock
docker image load --input /evidence/systemd-image.tar > /evidence/systemd-load.log
image=$(cat /evidence/systemd-image-id)
test "${#image}" = 71
set -- --mount type=bind,src=/evidence,dst=/evidence
if test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = gid; then
  # The non-root filesystem fixture receives no host evidence or engine mount.
  set -- --tmpfs /evidence:rw,nosuid,nodev,noexec,mode=0700,size=32m
fi
if test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = nats; then
  docker image load --input /evidence/nats-image.tar > /evidence/nats-load.log
  docker tag "$(cat /evidence/nats-image-id)" nats:2.11.8-alpine
fi
if test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = resources; then
  docker image load --input /evidence/alpine-image.tar > /evidence/alpine-load.log
  docker tag "$(cat /evidence/alpine-image-id)" alpine:3.20
fi
if test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = nats || test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = resources; then
  cp -f /usr/local/bin/docker /evidence/docker-client
  chmod 0755 /evidence/docker-client
  chmod 0600 /run/owned-engine/docker.sock
  set -- "$@" --mount type=bind,src=/run/owned-engine,dst=/private-engine
fi
# Image-declared cgroup volumes are suppressed by a private tmpfs. The entrypoint
# mounts cgroup2 itself AFTER checking namespace custody, never a host bind mount.
inner=$(docker create --label "io.workflowd.fixture.owner=$FIXTURE_OWNER" \
  --privileged --network host --ipc private --cgroupns private \
  --memory 5g --memory-swap 5g --cpus 2 --pids-limit 768 \
  --tmpfs /run:rw,nosuid,nodev,mode=0755,size=64m \
  --tmpfs /tmp:rw,exec,nosuid,nodev,mode=1777,size=256m \
  --tmpfs /sys/fs/cgroup:rw,nosuid,nodev,noexec,size=1m \
  --env container=docker --env "HOST_NETNS=$HOST_NETNS" \
  --env "HOST_CGROUPNS=$HOST_CGROUPNS" \
  --env "OUTER_CGROUPNS=$(readlink /proc/self/ns/cgroup)" \
  --mount type=bind,src=/source,dst=/source,readonly \
  --mount type=bind,src=/dependencies,dst=/dependencies,readonly \
  "$@" \
  --entrypoint /bin/sh "$image" -exc '
    test "$(id -u)" = 0
    test "$$" = 1
    test "$(readlink /proc/self/ns/net)" != "$HOST_NETNS"
    test "$(readlink /proc/self/ns/cgroup)" != "$HOST_CGROUPNS"
    test "$(readlink /proc/self/ns/cgroup)" != "$OUTER_CGROUPNS"
    grep -qx "0::/" /proc/self/cgroup
    test -z "$(awk -F: '\''$3 != "/" { print }'\'' /proc/self/cgroup)"
    test ! -S /var/run/docker.sock
    umount /sys/fs/cgroup
    mount -t cgroup2 -o nosuid,nodev,noexec none /sys/fs/cgroup
    test "$(cat /sys/fs/cgroup/memory.max)" = 5368709120
    test "$(cat /sys/fs/cgroup/memory.swap.max)" = 0
    test "$(cat /sys/fs/cgroup/pids.max)" = 768
    test "$(cat /sys/fs/cgroup/cpu.max)" = "200000 100000"
    cat /proc/self/mountinfo > /evidence/systemd-mountinfo
    cat /proc/self/cgroup > /evidence/systemd-cgroup
    readlink /proc/self/ns/cgroup > /evidence/systemd-cgroupns
    groupadd --gid 61000 workflowd-model-auth
    useradd --uid 61001 --gid 61000 --no-create-home --shell /usr/sbin/nologin ben-fixture
    useradd --uid 61002 --gid 61000 --no-create-home --shell /usr/sbin/nologin agent-fixture
    mkdir /work
    cp -rf /source/repo/. /work/
    chmod -R a+rX /work
    ln -s /dependencies /work/node_modules
    ln -s /dependencies /node_modules
    mkdir -p /work/.scratch
    exec /lib/systemd/systemd --unit=multi-user.target --log-target=console
  ')
printf '%s\n' "$inner" > /evidence/systemd-container-id
trap 'docker logs "$inner" > /evidence/systemd-boot.log 2>&1 || true; docker inspect "$inner" > /evidence/systemd-final.json 2>&1 || true' EXIT HUP INT TERM
docker inspect "$inner" > /evidence/systemd-created.json
test "$(docker inspect --format '{{.HostConfig.CgroupnsMode}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}}' "$inner")" = 'private 5368709120 5368709120 768'
docker start "$inner" > /evidence/systemd-start
docker exec "$inner" /bin/sh -ec '
  for attempt in $(seq 1 100); do
    if test -S /run/systemd/private; then break; fi
    sleep .1
  done
  test -S /run/systemd/private
  test "$(cat /proc/1/comm)" = systemd
  systemctl start dbus.socket
  export PATH=/source/bin:/usr/bin:/bin HOME=/root
  export WORKFLOWD_AGENT_TEST_BEN_UID=61001 WORKFLOWD_AGENT_TEST_AGENT_UID=61002 WORKFLOWD_AGENT_TEST_AUTH_GID=61000
  cd /work
  bun --version > /evidence/systemd-bun-version
  node --version > /evidence/systemd-node-version
  systemd-run --wait --pipe --collect --service-type=exec \
    -p MemoryMax=4G -p MemorySwapMax=0 -p CPUQuota=200% -p TasksMax=512 \
    -p RuntimeMaxSec=90 --working-directory=/work \
    --setenv=PATH --setenv=HOME --setenv=WORKFLOWD_AGENT_TEST_BEN_UID \
    --setenv=WORKFLOWD_AGENT_TEST_AGENT_UID --setenv=WORKFLOWD_AGENT_TEST_AUTH_GID \
    /source/bin/bun scripts/evidence/agent-user.mjs --probe-supervision
' > /evidence/supervision.log 2>&1
if test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = gid; then
  docker exec "$inner" /bin/sh -ec '
    groupadd --gid 61003 workflowd-fixture-supplementary
    install -d -m 0700 -o 61001 -g 61000 /gid-home /gid-home/tmp /gid-home/runtime
    printf synthetic-outside-canary > /root/gid-outside-canary
    chmod 0600 /root/gid-outside-canary
    cd /work
    systemd-run --wait --pipe --collect --service-type=exec \
      -p MemoryMax=4G -p MemorySwapMax=0 -p CPUQuota=200% -p TasksMax=512 -p RuntimeMaxSec=90 \
      --working-directory=/work /usr/bin/env -i PATH=/source/bin:/usr/bin:/bin HOME=/gid-home \
      TMPDIR=/gid-home/tmp XDG_RUNTIME_DIR=/gid-home/runtime \
      DBUS_SESSION_BUS_ADDRESS=unix:path=/gid-home/runtime/no-bus DOCKER_HOST=unix:///gid-home/runtime/no-engine \
      /usr/bin/setpriv --reuid 61001 --regid 61000 --groups 61003 \
      --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
      /usr/bin/python3 /work/scripts/evidence/owned-gid.py probe
  ' > /evidence/gid-prerequisite.log 2>&1
  docker cp "$inner:/gid-home/probe.json" /evidence/gid-prerequisite.json
fi
touch /evidence/systemd-ready
if test "$FIXTURE_CASE" = systemd-death; then sleep 240; fi
if test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = legacy-inputs; then
  docker exec "$inner" cat /etc/os-release > /evidence/legacy-controller-os-release
  docker exec "$inner" dpkg-query -W > /evidence/legacy-controller-packages
  for name in legacy-ubuntu legacy-dagger; do
    docker image load --input "/evidence/$name.tar" > "/evidence/$name-load.log"
  done
  base=ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
  docker image inspect "$base" > /evidence/legacy-loaded-ubuntu.json 2>/evidence/legacy-loaded-ubuntu.stderr || manager_status=$?
  docker image inspect registry.dagger.io/engine@sha256:56b68be5d9fc8e0a4e7c8db7599a76571f8806d5a9623d9afa6764ae3f8cae36 > /evidence/legacy-loaded-dagger.json 2>/evidence/legacy-loaded-dagger.stderr || manager_status=$?
fi
if test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = gid; then
  docker exec "$inner" /bin/sh -ec '
    cd /work
    result=0
    systemd-run --wait --pipe --collect --service-type=exec \
      -p MemoryMax=4G -p MemorySwapMax=0 -p CPUQuota=200% -p TasksMax=512 -p RuntimeMaxSec=90 \
      --working-directory=/work /usr/bin/env -i PATH=/source/bin:/usr/bin:/bin HOME=/gid-home \
      TMPDIR=/gid-home/tmp XDG_RUNTIME_DIR=/gid-home/runtime \
      DBUS_SESSION_BUS_ADDRESS=unix:path=/gid-home/runtime/no-bus DOCKER_HOST=unix:///gid-home/runtime/no-engine \
      /usr/bin/setpriv --reuid 61001 --regid 61000 --groups 61003 \
      --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
      /usr/bin/python3 /work/scripts/evidence/owned-gid.py test || result=$?
    printf "%s\n" "$result" > /evidence/gid-exit
    /source/bin/bun -e '\''const {createHash}=require("node:crypto"); const fs=require("node:fs"); const hashes=await Bun.file("/source/input-hashes.json").json(); const changed=Object.entries(hashes).filter(([p,h])=>createHash("sha256").update(fs.readFileSync(p)).digest("hex")!==h).map(([p])=>p); await Bun.write("/evidence/source-after.json",JSON.stringify({changedInputs:changed})); if(changed.length) process.exit(1)'\''
    exit "$result"
  ' > /evidence/gid-test.log 2>&1 || manager_status=$?
  docker cp "$inner:/gid-home" /evidence/gid-home
  mkdir /evidence/gid-custody
  for proof in systemd-mountinfo systemd-cgroup systemd-cgroupns source-after.json gid-exit; do
    docker exec "$inner" cat "/evidence/$proof" > "/evidence/gid-custody/$proof"
  done
fi
if test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = prerequisites; then
  docker exec "$inner" /bin/sh -c '
    export PATH=/source/bin:/usr/bin:/bin
    missing=0
    for tool in bun node git python3 ssh sshd openssl curl jq setpriv unshare bash claude codex opencode2; do
      if command -v "$tool" >/dev/null 2>&1; then printf "%s present\n" "$tool"; else printf "%s missing\n" "$tool"; missing=1; fi
    done
    exit "$missing"
  ' > /evidence/remaining-tool-prerequisites.log 2>&1 || manager_status=$?
  for required in workflowd-sandbox-runner:fixture workflowd-sandbox-tooling:fixture; do
    if docker image inspect "$required" > /dev/null 2>&1; then
      state=present
    else
      state=missing
      manager_status=1
    fi
    printf '%s %s\n' "$required" "$state" >> /evidence/remaining-image-prerequisites.log
  done
fi
if test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = manager || test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = nats || test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = resources; then
  if test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = nats || test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = resources; then
    # Only the disposable controller receives the private engine socket. Its mode
    # excludes synthetic agent UIDs; the host engine is never mounted here.
    docker exec "$inner" mkdir -p /run/private-engine
    docker cp /evidence/docker-client "$inner:/usr/bin/docker"
    docker exec "$inner" /bin/sh -ec 'mkdir -p /evidence/test-tmp; ln -s /private-engine/docker.sock /var/run/docker.sock'
  fi
  if test "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" = nats; then
    broker=$(docker run -d --label "io.workflowd.fixture.owner=$FIXTURE_OWNER" --memory 128m --memory-swap 128m --cpus 1 --pids-limit 64 -p 127.0.0.1::4222 nats:2.11.8-alpine -js)
    port=$(docker port "$broker" 4222/tcp)
    docker inspect "$broker" > /evidence/nats-prerequisite-container.json
    docker exec "$inner" /source/bin/bun -e 'const [hostname,port]=process.argv[1].split(":"); const timeout=setTimeout(()=>process.exit(1),5000); await Bun.connect({hostname,port:Number(port),socket:{data(socket,data){if(!data.toString().startsWith("INFO "))process.exit(1); console.log("private-nats-ready");clearTimeout(timeout);socket.end()},error(){process.exit(1)}}})' "$port" > /evidence/nats-prerequisite.log 2>&1
    docker rm -f "$broker" > /evidence/nats-prerequisite-removed
  fi
  docker exec "$inner" /bin/sh -ec '
    systemctl start user@0.service
    test -S /run/user/0/bus
    export PATH=/source/bin:/usr/bin:/bin HOME=/root
    export XDG_RUNTIME_DIR=/run/user/0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus
    cd /work
    result=0
    files="test/review-systemd.e2e.test.ts test/resident/coordinator-e2e.test.ts test/reload-signal.test.ts"
    if test "$1" = nats; then
      export TMPDIR=/evidence/test-tmp
      files="test/ci/provider.test.ts test/remote/remote-transport.integration.test.ts test/remote/remote-transport-permissions.integration.test.ts test/remote/remote-coordinator.integration.test.ts test/remote/remote-vertical.integration.test.ts test/remote/remote-runner.integration.test.ts"
    fi
    if test "$1" = resources; then
      export TMPDIR=/evidence/test-tmp
      files="test/resources/fixture.test.ts test/resources/pinned-volume.test.ts test/resources/process-death.test.ts"
    fi
    for file in $files; do
      name=$(basename "$file" .test.ts)
      set -- /source/bin/bun test --coverage "--coverage-dir=/evidence/coverage-$name" --reporter=junit "--reporter-outfile=/evidence/tests-$name.xml" "$file"
      if test "$file" = test/reload-signal.test.ts; then
        mkdir -m 0700 /tmp/reload-evidence
        chown 61001:61000 /tmp/reload-evidence
        set -- /usr/bin/setpriv --reuid 61001 --regid 61000 --clear-groups /source/bin/bun test --coverage --coverage-dir=/tmp/reload-evidence/coverage --reporter=junit --reporter-outfile=/tmp/reload-evidence/tests.xml "$file"
      fi
      code=0
      systemd-run --wait --pipe --collect --service-type=exec \
        -p MemoryMax=4G -p MemorySwapMax=0 -p CPUQuota=200% -p TasksMax=512 \
        -p RuntimeMaxSec=90 --working-directory=/work \
        --setenv=PATH --setenv=HOME --setenv=XDG_RUNTIME_DIR --setenv=DBUS_SESSION_BUS_ADDRESS \
        --setenv=TMPDIR="${TMPDIR:-/tmp}" \
        "$@" > "/evidence/test-$name.log" 2>&1 || code=$?
      printf "%s\\n" "$code" > "/evidence/exit-$name"
      if test "$file" = test/reload-signal.test.ts; then cp -rf /tmp/reload-evidence /evidence/reload-evidence; fi
      if test "$code" != 0; then result=1; fi
    done
    /source/bin/bun -e '\''const {createHash}=require("node:crypto"); const fs=require("node:fs"); const hashes=await Bun.file("/source/input-hashes.json").json(); const changed=Object.entries(hashes).filter(([p,h])=>createHash("sha256").update(fs.readFileSync(p)).digest("hex")!==h).map(([p])=>p); await Bun.write("/evidence/source-after.json",JSON.stringify({changedInputs:changed})); if(changed.length) process.exit(1)'\''
    exit "$result"
  ' fixture "$WORKFLOWD_FIXTURE_SYSTEMD_SUITE" > /evidence/manager.log 2>&1 || manager_status=$?
fi
docker stop --time 5 "$inner" > /evidence/systemd-stop
docker wait "$inner" > /evidence/systemd-exit
docker logs "$inner" > /evidence/systemd-boot.log 2>&1
docker inspect "$inner" > /evidence/systemd-stopped.json
trap - EXIT HUP INT TERM
docker rm "$inner" > /evidence/systemd-removed
exit "${manager_status:-0}"
