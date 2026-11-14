#!/bin/sh
# Exact-owned, network-none outer namespace; only its private daemon is used here.
set -eu
case "$FIXTURE_CASE" in legacy-build|legacy-test) ;; *) exit 1 ;; esac
case "$WORKFLOWD_FIXTURE_LEGACY_SUITE" in lease|transport|runner-init|engine-host-boundary|audit|bridge-cancellation|observation|skill-discovery|permissions) ;; *) exit 1 ;; esac
runtime_env=
audit_env=
case "$WORKFLOWD_FIXTURE_LEGACY_SUITE" in
  audit|bridge-cancellation|observation|skill-discovery|permissions) audit_env=SANDBOX_POLICY_EVIDENCE=/evidence/opencode ;;
esac
temporary=/evidence/test-tmp
if test "$WORKFLOWD_FIXTURE_LEGACY_SUITE" != lease; then
  runtime_env=WORKFLOWD_SANDBOX_RUNTIME=1
  temporary=/tmp/workflowd-tests
fi
test "$(readlink /proc/self/ns/net)" != "$HOST_NETNS"
test "$(readlink /proc/self/ns/cgroup)" != "$HOST_CGROUPNS"
test "$DOCKER_HOST" = unix:///run/owned-engine/docker.sock
test "$(cat /evidence/storage-driver)" = overlay2
phase() {
  case "$1" in controller-load|ubuntu-load|dagger-load|tooling-load|controller-create|controller-start|controller-setup|legacy-admission|combined-admission) ;; *) return 1 ;; esac
  case "$2" in start|end) ;; *) return 1 ;; esac
  read -r phase_time phase_idle < /proc/uptime
  printf '%s %s %s\n' "$phase_time" "$1" "$2" >> /evidence/legacy-phases.log
}
phase controller-load start
if test -f /source/legacy/controller.tar; then
  docker image load --input /source/legacy/controller.tar > /evidence/systemd-load.log
  controller=$(cat /source/legacy/controller-id)
else
  docker image load --input /evidence/systemd-image.tar > /evidence/systemd-load.log
  controller=$(cat /evidence/systemd-image-id)
fi
test "$(docker image inspect --format '{{.Id}}' "$controller")" = "$controller"
docker image inspect "$controller" > /evidence/controller-image.json
phase controller-load end
ln -s /source/repo /work
cp -f /usr/local/bin/docker /evidence/docker-client
cp -f /usr/local/libexec/docker/cli-plugins/docker-buildx /evidence/docker-buildx
chmod 0755 /evidence/docker-client /evidence/docker-buildx
chmod 0600 /run/owned-engine/docker.sock
import_pid=
import_status=
import_signal=0
# Latching handlers cannot exit between EXIT recovery and its final drain.
trap 'import_signal=129' HUP
trap 'import_signal=130' INT
trap 'import_signal=143' TERM
drain_import() {
  import_parent_status=$?
  trap '' HUP INT TERM
  trap - EXIT
  if test -n "$import_pid"; then
    import_status=0
    wait "$import_pid" || import_status=$?
    if test "$import_status" = 127; then
      # Do not turn a lost job/status into successful completion or admission.
      printf 'legacy-import unresolved-wait parent=%s import=127\n' "$import_parent_status" >&2 || :
    else
      import_pid=
    fi
  fi
  if test "$import_parent_status" = 0; then
    if test "$import_signal" != 0; then
      import_parent_status=$import_signal
    else
      import_parent_status=${import_status:-127}
    fi
  fi
  if test "$import_parent_status" != 0 && test "${import_status:-0}" != 0; then
    printf 'legacy-import parent=%s import=%s\n' "$import_parent_status" "$import_status" >&2 || :
  fi
  exit "$import_parent_status"
}
trap drain_import EXIT
(
  trap - EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  for name in ubuntu dagger; do
    phase "$name-load" start
    docker image load --input "/source/legacy/$name.tar" > "/evidence/$name-load.log"
    phase "$name-load" end
  done
  if test "$FIXTURE_CASE" = legacy-test; then
    phase tooling-load start
    docker image load --input /source/legacy/built.tar > /evidence/built-load.log
    phase tooling-load end
  fi
) &
import_pid=$!
test "$import_signal" = 0 || exit "$import_signal"
phase controller-create start
inner=$(docker create --label "io.workflowd.fixture.owner=$FIXTURE_OWNER" \
  --privileged --network host --ipc private --cgroupns private \
  --memory 5g --memory-swap 5g --cpus 2 --pids-limit 768 \
  --tmpfs /run:rw,nosuid,nodev,mode=0755,size=64m \
  --tmpfs /tmp:rw,exec,nosuid,nodev,mode=1777,size=256m \
  --tmpfs /sys/fs/cgroup:rw,nosuid,nodev,noexec,size=1m \
  --tmpfs /work/.scratch:rw,nosuid,nodev,mode=0700,size=64m \
  --env container=docker --env "HOST_NETNS=$HOST_NETNS" --env "HOST_CGROUPNS=$HOST_CGROUPNS" \
  --env "OUTER_CGROUPNS=$(readlink /proc/self/ns/cgroup)" \
  --mount type=bind,src=/source,dst=/source,readonly \
  --mount type=bind,src=/source/repo,dst=/work,readonly \
  --mount type=bind,src=/dependencies,dst=/work/node_modules,readonly \
  --mount type=bind,src=/dependencies,dst=/node_modules,readonly \
  --mount type=bind,src=/evidence,dst=/evidence \
  --mount type=bind,src=/run/owned-engine,dst=/private-engine \
  --entrypoint /bin/sh "$controller" -ec '
    test "$(id -u)" = 0; test "$$" = 1
    test "$(readlink /proc/self/ns/net)" != "$HOST_NETNS"
    test "$(readlink /proc/self/ns/cgroup)" != "$HOST_CGROUPNS"
    test "$(readlink /proc/self/ns/cgroup)" != "$OUTER_CGROUPNS"
    grep -qx "0::/" /proc/self/cgroup
    test ! -S /var/run/docker.sock
    umount /sys/fs/cgroup
    mount -t cgroup2 -o nosuid,nodev,noexec none /sys/fs/cgroup
    test "$(cat /sys/fs/cgroup/memory.max)" = 5368709120
    test "$(cat /sys/fs/cgroup/memory.swap.max)" = 0
    test "$(cat /sys/fs/cgroup/pids.max)" = 768
    test "$(cat /sys/fs/cgroup/cpu.max)" = "200000 100000"
    cat /proc/self/mountinfo > /evidence/controller-mountinfo
    cat /proc/self/cgroup > /evidence/controller-cgroup
    exec /lib/systemd/systemd --unit=multi-user.target --log-target=console
  ')
printf '%s\n' "$inner" > /evidence/controller-id
docker inspect "$inner" > /evidence/controller-created.json
test "$(docker inspect --format '{{.HostConfig.CgroupnsMode}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}}' "$inner")" = 'private 5368709120 5368709120 768'
phase controller-create end
test "$import_signal" = 0 || exit "$import_signal"
phase controller-start start
docker start "$inner" > /evidence/controller-start
phase controller-start end
test "$import_signal" = 0 || exit "$import_signal"
remaining=$((FIXTURE_STARTUP_DEADLINE - $(date +%s)))
test "$remaining" -gt 0
phase controller-setup start
docker exec "$inner" timeout "$remaining" /bin/sh -ec '
  for attempt in $(seq 1 100); do test ! -S /run/systemd/private || break; sleep .1; done
  test -S /run/systemd/private; test "$(cat /proc/1/comm)" = systemd
  systemctl start dbus.socket user@0.service
  test -S /run/user/0/bus
  mkdir -p /usr/local/libexec/docker/cli-plugins /evidence/test-tmp /tmp/workflowd-tests
  python3 -c '\''import json,os; paths=["/evidence","/evidence/test-tmp","/tmp","/tmp/workflowd-tests"]; print(json.dumps([{ "path":p,"uid":os.stat(p).st_uid,"gid":os.stat(p).st_gid,"mode":oct(os.stat(p).st_mode&0o777)} for p in paths]))'\'' > /evidence/controller-temp-paths.json
  if test ! -f /source/legacy/controller.json; then
    cp -f /evidence/docker-client /usr/bin/docker
    cp -f /evidence/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
    WORKFLOWD_LEGACY_MIRROR=/source/legacy/apt-inputs sh /work/scripts/evidence/legacy-offline.sh git openssh-client zip unzip
  else
    python3 -c '\''import hashlib,json,pathlib; m=json.loads(pathlib.Path("/source/legacy/controller.json").read_text()); actual=json.loads(pathlib.Path("/evidence/controller-image.json").read_text())[0]; assert actual["Id"]==m["image"]["Id"] and actual["RootFS"]==m["image"]["RootFS"]; assert all(hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()==h for p,h in m["tools"].items())'\''
  fi
  ln -s /private-engine/docker.sock /var/run/docker.sock
  for tool in git ssh zip unzip docker; do command -v "$tool"; done
' > /evidence/controller-setup.log 2>&1
phase controller-setup end
test "$import_signal" = 0 || exit "$import_signal"
import_wait_status=0
wait "$import_pid" || import_wait_status=$?
if test "$import_signal" != 0 && test "$import_wait_status" -ge 128; then
  # No external command/job may reclaim ash's saved status before final drain.
  # A signal-valued wait with a pending signal has not established completion.
  exit "$import_signal"
fi
if test "$import_wait_status" = 127; then
  exit 127
fi
import_status=$import_wait_status import_pid=
trap - HUP INT TERM
test "$import_signal" = 0 || exit "$import_signal"
trap - EXIT
test "$import_status" = 0 || exit "$import_status"
test "$(date +%s)" -le "$FIXTURE_STARTUP_DEADLINE"
if test "$FIXTURE_CASE" = legacy-test; then
  phase legacy-admission start
  docker exec "$inner" systemd-run --wait --pipe --collect --service-type=exec \
    -p MemoryMax=4G -p MemorySwapMax=0 -p CPUQuota=200% -p TasksMax=512 -p RuntimeMaxSec=40 \
    --working-directory=/work /usr/bin/env -i PATH=/source/bin:/usr/bin:/bin HOME=/root \
    "TMPDIR=$temporary" XDG_RUNTIME_DIR=/run/user/0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus \
    WORKFLOWD_SANDBOX_PREBUILT=1 $runtime_env /source/bin/bun --preload ./test/resources/preload.ts scripts/evidence/legacy-admission.mjs \
    > /evidence/legacy-admission.log 2>&1
  phase legacy-admission end
  test "$(date +%s)" -le "$FIXTURE_STARTUP_DEADLINE"
fi
touch /evidence/legacy-ready
result=0
limit=1100
set -- --preload ./test/resources/preload.ts scripts/evidence/legacy-build.mjs
if test "$FIXTURE_CASE" = legacy-test; then
  limit=260
  set -- test --reporter=junit "--reporter-outfile=/evidence/$WORKFLOWD_FIXTURE_LEGACY_SUITE.xml" "test/sandbox/$WORKFLOWD_FIXTURE_LEGACY_SUITE.e2e.test.ts"
  if test "$WORKFLOWD_FIXTURE_LEGACY_SUITE" = engine-host-boundary; then
    set -- test --reporter=junit --reporter-outfile=/evidence/engine-host-boundary.xml test/sandbox/engine-host-boundary.test.ts
  fi
  if test "$WORKFLOWD_FIXTURE_LEGACY_STARTUP" = 1; then
    limit=90
    remaining=$((FIXTURE_STARTUP_DEADLINE - $(date +%s)))
    test "$remaining" -gt 0
    if test "$remaining" -lt "$limit"; then limit=$remaining; fi
    set -- --preload ./test/resources/preload.ts scripts/evidence/legacy-startup.mjs
    if test -n "$audit_env"; then
      set -- --preload ./test/resources/preload.ts scripts/evidence/legacy-audit-startup.mjs
    fi
  fi
fi
if test "$WORKFLOWD_FIXTURE_LEGACY_STARTUP" = 1; then phase combined-admission start; fi
docker exec "$inner" systemd-run --wait --pipe --collect --service-type=exec \
  -p MemoryMax=4G -p MemorySwapMax=0 -p CPUQuota=200% -p TasksMax=512 -p "RuntimeMaxSec=$limit" \
  --working-directory=/work /usr/bin/env -i PATH=/source/bin:/usr/bin:/bin HOME=/root \
  "TMPDIR=$temporary" XDG_RUNTIME_DIR=/run/user/0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus \
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
  "WORKFLOWD_FIXTURE_LEGACY_CONTROLLER_STAGE=$WORKFLOWD_FIXTURE_LEGACY_CONTROLLER_STAGE" \
  "WORKFLOWD_FIXTURE_LEGACY_DEATH=$WORKFLOWD_FIXTURE_LEGACY_DEATH" \
  "WORKFLOWD_FIXTURE_LEGACY_SUITE=$WORKFLOWD_FIXTURE_LEGACY_SUITE" \
  "WORKFLOWD_FIXTURE_EVIDENCE_UID=$FIXTURE_UID" "WORKFLOWD_FIXTURE_EVIDENCE_GID=$FIXTURE_GID" \
  WORKFLOWD_SANDBOX_PREBUILT=1 $runtime_env $audit_env /source/bin/bun "$@" \
  > "/evidence/$FIXTURE_CASE.log" 2>&1 || result=$?
if test "$WORKFLOWD_FIXTURE_LEGACY_STARTUP" = 1 && test "$result" = 0; then phase combined-admission end; fi
printf '%s\n' "$result" > /evidence/legacy-exit
if test -n "$audit_env"; then
  docker exec "$inner" journalctl --user-unit='workflowd-sandbox-fixture-*' --no-pager --output=short-monotonic --lines=300 > /evidence/audit-controller-journal.log
fi
docker exec "$inner" python3 -c '
import hashlib,json,pathlib
expected=json.loads(pathlib.Path("/source/input-hashes.json").read_text())
changed=[name for name,digest in expected.items() if hashlib.sha256((pathlib.Path("/work")/name).read_bytes()).hexdigest()!=digest]
pathlib.Path("/evidence/source-after.json").write_text(json.dumps({"changedInputs":changed}))
assert not changed
'
if test "$WORKFLOWD_FIXTURE_LEGACY_STARTUP" = 1; then
  test "$(date +%s)" -le "$FIXTURE_STARTUP_DEADLINE"
fi
docker logs "$inner" > /evidence/controller-boot.log 2>&1
docker stop --time 5 "$inner" > /evidence/controller-stop
docker wait "$inner" > /evidence/controller-exit
docker inspect "$inner" > /evidence/controller-stopped.json
docker rm "$inner" > /evidence/controller-removed
exit "$result"
