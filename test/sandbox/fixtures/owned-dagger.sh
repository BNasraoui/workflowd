#!/bin/sh
set -eu
test "$(readlink /proc/self/ns/net)" != "$HOST_NETNS"
operation=${1:-all}
if test "$operation" = all; then
  sh "$0" start
  sh "$0" check runtime
  exec sh "$0" stop
fi
if test "$operation" = start; then
docker load -i /evidence/dagger-image.tar > /evidence/dagger-load.log 2>&1
docker load -i /evidence/python-image.tar > /evidence/python-load.log 2>&1
mkdir -p /evidence/dagger-socket
docker volume create --label "io.workflowd.fixture.owner=$FIXTURE_OWNER" dagger-data > /evidence/dagger-volume
network=none
if test "$FIXTURE_CASE" = dagger-network; then network=workflowd-sandbox; fi
engine=$(docker create --label "io.workflowd.fixture.owner=$FIXTURE_OWNER" \
  --privileged --network "$network" --dns 192.0.2.2 --memory 3g --memory-swap 3g --cpus 2 --pids-limit 512 \
  --mount type=volume,src=dagger-data,dst=/var/lib/dagger \
  --mount type=bind,src=/evidence/dagger-socket,dst=/run/workflowd-engine \
  --mount type=bind,src=/source/engine.toml,dst=/etc/dagger/engine.toml,readonly \
  "$(cat /evidence/dagger-image-id)" --addr unix:///run/workflowd-engine/engine.sock --group 0)
echo "$engine" > /evidence/dagger-engine-id
docker start "$engine" > /evidence/dagger-start
docker exec "$engine" cat /etc/resolv.conf > /evidence/dagger-resolv.conf
test "$(docker exec "$engine" readlink /proc/self/ns/net)" != "$HOST_NETNS"
ready=0
for attempt in $(seq 1 60); do
  if test -S /evidence/dagger-socket/engine.sock; then ready=1; break; fi
  sleep 0.5
done
test "$ready" = 1
if test "$FIXTURE_CASE" = dagger-network; then
  listener=$(docker create --label "io.workflowd.fixture.owner=$FIXTURE_OWNER" \
    --network "container:$engine" --memory 128m --memory-swap 128m --pids-limit 32 \
    --read-only sha256:b8e978e6953b12078fd3be4cc48f73ee92f88878a28e2d3326feb48ce958dfd1 python3 -m http.server 1234)
  echo "$listener" > /evidence/dagger-listener-id
  docker start "$listener" > /evidence/dagger-listener-start
fi
exit 0
fi
engine=$(cat /evidence/dagger-engine-id)
if test "$operation" = check; then
phase=${2:?phase required}
mode=${3:-both}
controller=$(docker create --label "io.workflowd.fixture.owner=$FIXTURE_OWNER" \
  --network none --memory 512m --memory-swap 512m --cpus 1 --pids-limit 64 \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m --env HOME=/tmp \
  --env _EXPERIMENTAL_DAGGER_RUNNER_HOST=unix:///run/workflowd-engine/engine.sock \
  --env DO_NOT_TRACK=1 --env DAGGER_NO_NAG=1 \
  --mount type=bind,src=/evidence,dst=/evidence \
  --mount type=bind,src=/evidence/dagger-socket,dst=/run/workflowd-engine,readonly \
  --mount type=bind,src=/source,dst=/source,readonly \
  sha256:b8e978e6953b12078fd3be4cc48f73ee92f88878a28e2d3326feb48ce958dfd1 python3 /source/owned-dagger.py "$phase" "$mode")
echo "$controller" > /evidence/dagger-controller-id
docker start "$controller" > /evidence/dagger-controller-start
status=$(docker wait "$controller")
docker logs "$controller" > "/evidence/dagger-controller-$phase-$mode.log" 2>&1
docker logs "$engine" > /evidence/dagger-engine.log 2>&1
test "$status" = 0
docker rm "$controller" > /evidence/dagger-controller-removed
exit 0
fi
test "$operation" = stop
if test -f /evidence/dagger-listener-id; then
  listener=$(cat /evidence/dagger-listener-id)
  docker stop --time 2 "$listener" > /evidence/dagger-listener-stop
  docker rm "$listener" > /evidence/dagger-listener-removed
fi
docker stop --time 5 "$engine" > /evidence/dagger-stopped
docker wait "$engine" > /evidence/dagger-engine-exit
docker rm "$engine" > /evidence/dagger-removed
docker volume rm dagger-data > /evidence/dagger-volume-removed
