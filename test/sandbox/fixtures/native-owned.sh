#!/bin/sh
set -eu
test "$(readlink /proc/self/ns/net)" != "$HOST_NETNS"
docker image load --input /agent-image.tar > /evidence/agent-load.log 2>&1
image=$(docker image inspect --format '{{.Id}}' workflowd-agent-base:local)
echo "$image" > /evidence/agent-image-id
# The trusted publisher/runner uses Python3.12's pinned Unicode15 policy. Keep
# that runtime separate from the agent image's general Python3.13 tools.
docker image load --input /evidence/python312-image.tar > /evidence/python312-load.log 2>&1
python=$(docker create --label "io.workflowd.fixture.owner=$FIXTURE_OWNER" --network none \
  --memory 128m --memory-swap 128m --pids-limit 64 \
  sha256:602b20fbec782d0c4c9bc5314194d6a8e82a42cf208face7141a3d36b2edb39f)
mkdir -p /evidence/python312/usr
docker cp "$python:/usr/local" /evidence/python312/usr/local
docker cp "$python:/usr/lib" /evidence/python312/usr/lib
docker cp "$python:/lib" /evidence/python312/lib
docker rm "$python" > /evidence/python312-source-removed
if test "$WORKFLOWD_FIXTURE_NATIVE_APP" != 1; then
  docker network create --label "io.workflowd.fixture.owner=$FIXTURE_OWNER" \
    --internal --ipv6 --subnet 172.30.0.0/24 --subnet fd42:7766:6400::/64 \
    --opt com.docker.network.bridge.name=wfd-sandbox0 workflowd-sandbox > /evidence/native-network-id
fi
# Copy only tools from this pinned disposable outer image. No host system files.
mkdir -p /evidence/network-tools/usr
cp -rf /lib /evidence/network-tools/lib
cp -rf /usr/lib /evidence/network-tools/usr/lib
cp -f "$(readlink -f "$(command -v iptables)")" /evidence/network-tools/xtables
controller=$(docker create --label "io.workflowd.fixture.owner=$FIXTURE_OWNER" \
  --user 0:0 --network host --cap-add NET_ADMIN --memory 1g --memory-swap 1g --cpus 2 --pids-limit 128 \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m --tmpfs /usr/bin:rw,nosuid,nodev,size=1m \
  --tmpfs /usr/sbin:rw,nosuid,nodev,size=1m --tmpfs /run:rw,nosuid,nodev,size=16m,mode=0755 \
  --tmpfs /var/empty:rw,nosuid,nodev,size=1m,mode=0755 \
  --env "WORKFLOWD_FIXTURE_HOST_NETNS=$HOST_NETNS" --env WORKFLOWD_FIXTURE_NODE=/bin/node \
  --env "WORKFLOWD_FIXTURE_NATIVE_APP=$WORKFLOWD_FIXTURE_NATIVE_APP" \
  --env "WORKFLOWD_FIXTURE_NATIVE_FAULT=$WORKFLOWD_FIXTURE_NATIVE_FAULT" \
  --env "WORKFLOWD_FIXTURE_NATIVE_FENCE=$WORKFLOWD_FIXTURE_NATIVE_FENCE" \
  --env "WORKFLOWD_FIXTURE_NATIVE_CLIENT=$WORKFLOWD_FIXTURE_NATIVE_CLIENT" \
  --mount type=bind,src=/evidence,dst=/evidence \
  --mount type=bind,src=/source,dst=/source,readonly \
  --mount type=bind,src=/source/deploy,dst=/deploy,readonly \
  --mount type=bind,src=/source/native-owned-passwd,dst=/etc/passwd,readonly \
  --mount type=bind,src=/run/owned-engine/docker.sock,dst=/var/run/docker.sock \
  --mount type=bind,src=/usr/local/bin/docker,dst=/tmp/docker,readonly \
  --mount type=bind,src=/evidence/python312/usr/local,dst=/usr/local,readonly \
  --mount type=bind,src=/evidence/python312/usr/lib,dst=/usr/lib,readonly \
  --mount type=bind,src=/evidence/python312/lib,dst=/lib,readonly \
  --mount type=bind,src=/evidence/network-tools,dst=/network-tools,readonly \
  --entrypoint /bin/sh "$image" -ec 'for tool in git sudo iptables ip6tables; do ln -s /source/native-owned-tools.py /usr/bin/$tool; done; ln -s /usr/local/bin/python3 /usr/bin/python3; ln -s /source/native-owned-docker.py /usr/bin/docker; ln -s /bin/ssh /usr/bin/ssh; ln -s /bin/ssh-keygen /usr/bin/ssh-keygen; ln -s /bin/sshd /usr/sbin/sshd; ln -s /evidence/native-runtime /run/workflowd-sandbox; mkdir -p /run/sshd; cd /run; /bin/python3 -c "import sys,unicodedata; print(sys.version,unicodedata.unidata_version)" > /evidence/agent-python-version; /usr/bin/python3 -c "import sys,unicodedata; print(sys.version,unicodedata.unidata_version); assert unicodedata.unidata_version==\"15.0.0\"" > /evidence/controller-python-version; if test "$WORKFLOWD_FIXTURE_NATIVE_APP" = 1; then exec /bin/bun /source/native-owned.mjs; else exec /bin/node /source/native-owned.mjs; fi')
echo "$controller" > /evidence/native-controller-id
docker start "$controller" > /evidence/native-controller-start
docker logs --follow "$controller" > /evidence/native-controller.log 2>&1 &
logger=$!
chown "$FIXTURE_UID:$FIXTURE_GID" /evidence/native-controller.log
status=$(docker wait "$controller")
wait "$logger"
docker inspect "$controller" > /evidence/native-controller.json
test "$status" = 0
docker rm "$controller" > /evidence/native-controller-removed
iptables-save > /evidence/native-ipv4.rules
ip6tables-save > /evidence/native-ipv6.rules
if test "$WORKFLOWD_FIXTURE_NATIVE_APP" = 1; then
  sh /source/network.sh stop > /evidence/native-firewall-cleanup.log 2>&1
fi
docker network rm workflowd-sandbox > /evidence/native-network-removed
