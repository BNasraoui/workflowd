#!/bin/sh
set -eu
test "$(readlink /proc/self/ns/net)" != "$HOST_NETNS"
image=sha256:b8e978e6953b12078fd3be4cc48f73ee92f88878a28e2d3326feb48ce958dfd1
docker image load --input /evidence/python-image.tar > /evidence/python-load.log 2>&1
create() {
  docker create --label "io.workflowd.fixture.owner=$FIXTURE_OWNER" \
    --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --read-only \
    --memory 128m --memory-swap 128m --pids-limit 64 --cpus 1 \
    --mount type=bind,src=/source/native-network.py,dst=/fixture.py,readonly \
    "$@"
}
docker network create --label "io.workflowd.fixture.owner=$FIXTURE_OWNER" \
  --opt com.docker.network.bridge.name=wfd-sandbox0 \
  --subnet 172.30.0.0/24 --ipv6 --subnet 2001:db8:30::/64 workflowd-sandbox > /evidence/network-id
client=$(create --network workflowd-sandbox --dns 192.0.2.2 "$image" python3 -c 'import time; time.sleep(240)')
target=$(create --network none "$image" python3 /fixture.py serve)
host=$(create --network host "$image" python3 /fixture.py serve)
printf '%s\n' "$client" "$target" "$host" > /evidence/network-container-ids
docker start "$client" "$target" "$host" > /evidence/network-started
trap 'docker logs "$target" > /evidence/target-listener.log 2>&1; docker logs "$host" > /evidence/host-listener.log 2>&1' EXIT
pid=$(docker inspect --format '{{.State.Pid}}' "$target")
mkdir -p /run/netns
ln -s "/proc/$pid/ns/net" /run/netns/target
ip link add external type veth peer name peer
ip link set peer netns "$pid"
ip addr add 192.0.2.1/24 dev external
ip link set external up
ip -n target addr add 192.0.2.2/24 dev peer
ip -n target link set peer up
ip -n target route add default via 192.0.2.1
for address in 10.23.0.2 172.20.0.2 192.168.23.2 169.254.169.254 168.63.129.16 100.64.0.9; do
  ip -n target addr add "$address/32" dev peer
  ip route add "$address/32" via 192.0.2.2
done
sysctl -w net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1 >/dev/null
ip -6 addr add 2001:db8:1::1/64 dev external nodad
ip -n target -6 addr add 2001:db8:1::2/64 dev peer nodad
ip -n target -6 addr add fd7a:115c:a1e0::2/128 dev peer nodad
ip -n target -6 route add default via 2001:db8:1::1
ip -6 route add fd7a:115c:a1e0::2/128 via 2001:db8:1::2
ip link add tailscale0 type veth peer name tailpeer
ip link set tailpeer netns "$pid"
ip addr add 198.51.100.1/24 dev tailscale0
ip link set tailscale0 up
ip -n target addr add 198.51.100.2/24 dev tailpeer
ip -n target link set tailpeer up
ip -6 addr add 2001:db8:2::1/64 dev tailscale0 nodad
ip -n target -6 addr add 2001:db8:2::2/64 dev tailpeer nodad
# Pin IPv6 neighbors: blocking ICMP ND must not masquerade as a TCP DROP.
client_pid=$(docker inspect --format '{{.State.Pid}}' "$client")
ln -s "/proc/$client_pid/ns/net" /run/netns/agent
mac() { ip "$@" | sed -n 's/.*link\/ether \([^ ]*\).*/\1/p'; }
client6=$(docker inspect --format '{{(index .NetworkSettings.Networks "workflowd-sandbox").GlobalIPv6Address}}' "$client")
ip -6 neigh replace "$client6" lladdr "$(mac -n agent -o link show eth0)" dev wfd-sandbox0 nud permanent
ip -n agent -6 neigh replace 2001:db8:30::1 lladdr "$(mac -o link show wfd-sandbox0)" dev eth0 nud permanent
ip -6 neigh replace 2001:db8:1::2 lladdr "$(mac -n target -o link show peer)" dev external nud permanent
ip -n target -6 neigh replace 2001:db8:1::1 lladdr "$(mac -o link show external)" dev peer nud permanent
ip -6 neigh replace 2001:db8:2::2 lladdr "$(mac -n target -o link show tailpeer)" dev tailscale0 nud permanent
docker exec "$client" python3 /fixture.py connected > /evidence/network-positive.json
if test "$FIXTURE_CASE" = dagger-network; then
  sh /source/owned-dagger.sh start
  sh /source/owned-dagger.sh check connected
  engine=$(cat /evidence/dagger-engine-id)
  test "$(docker exec "$engine" readlink /proc/self/ns/net)" != "$HOST_NETNS"
  docker cp /source/network.sh "$engine:/network.sh"
  docker exec "$engine" sh /network.sh engine 172.30.0.0/24
  docker exec "$engine" iptables-save -c > /evidence/dagger-before.rules
fi
sh /source/network.sh host 172.30.0.0/24
iptables-save -c > /evidence/ipv4-before.rules
ip6tables-save -c > /evidence/ipv6-before.rules
docker exec "$client" python3 /fixture.py denied > /evidence/network-negative.json
if test "$FIXTURE_CASE" = dagger-network; then
  docker exec "$engine" iptables-save -c > /evidence/dagger-before-http.rules
  iptables-save -c > /evidence/host-before-http.rules
  sh /source/owned-dagger.sh check denied http
  docker exec "$engine" iptables-save -c > /evidence/dagger-after-http.rules
  iptables-save -c > /evidence/host-after-http.rules
  sh /source/owned-dagger.sh check denied nested
  docker exec "$engine" iptables-save -c > /evidence/dagger-after.rules
  docker exec "$engine" cat /proc/sys/net/ipv6/conf/all/disable_ipv6 /proc/sys/net/ipv6/conf/default/disable_ipv6 /proc/sys/net/ipv6/conf/dagger0/disable_ipv6 > /evidence/dagger-ipv6
fi
iptables-save -c > /evidence/ipv4-after.rules
ip6tables-save -c > /evidence/ipv6-after.rules
sh /source/network.sh stop
sh /source/network.sh stop
docker exec "$client" python3 /fixture.py connected > /evidence/network-restored.json
if test "$FIXTURE_CASE" = dagger-network; then
  sh /source/owned-dagger.sh check restored
  sh /source/owned-dagger.sh stop
fi
docker inspect "$client" "$target" "$host" > /evidence/network-container-receipts.json
docker logs "$target" > /evidence/target-listener.log 2>&1
docker logs "$host" > /evidence/host-listener.log 2>&1
trap - EXIT
docker stop --time 2 "$client" "$target" "$host" > /evidence/network-stopped
docker rm "$client" "$target" "$host" > /evidence/network-removed
docker network rm workflowd-sandbox > /evidence/network-removed-id
