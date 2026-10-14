#!/bin/sh
set -eu
# Two synthetic peers, entirely inside a disposable network namespace.
ip netns add agent
ip netns add target
ip link add wfd-sandbox0 type bridge
ip addr add 172.30.0.1/24 dev wfd-sandbox0
ip link set wfd-sandbox0 up
ip link add uplink type veth peer name guest
ip link set uplink master wfd-sandbox0
ip link set uplink up
ip link set guest netns agent
ip -n agent addr add 172.30.0.2/24 dev guest
ip -n agent link set guest up
ip -n agent route add default via 172.30.0.1
ip link add external type veth peer name peer
ip link set peer netns target
ip addr add 192.0.2.1/24 dev external
ip link set external up
ip -n target addr add 192.0.2.2/24 dev peer
ip -n target addr add 100.64.0.9/32 dev peer
ip -n target addr add 169.254.169.254/32 dev peer
ip -n target link set peer up
ip -n target route add default via 192.0.2.1
ip route add 100.64.0.0/10 via 192.0.2.2
ip route add 169.254.169.254/32 via 192.0.2.2
sysctl -w net.ipv4.ip_forward=1 >/dev/null
iptables -N DOCKER-USER
iptables -A FORWARD -j DOCKER-USER
probe() { ip netns exec agent ping -c 1 -W 1 "$1" >/dev/null 2>&1; }
for address in 172.30.0.1 100.64.0.9 169.254.169.254; do probe "$address"; done
sh /network.sh host 172.30.0.0/24
for address in 172.30.0.1 100.64.0.9 169.254.169.254; do
  if probe "$address"; then exit 1; fi
done
# Public egress and other input interfaces remain usable.
probe 192.0.2.2
ip netns exec target ping -c 1 -W 1 172.30.0.1 >/dev/null
sh /network.sh stop
sh /network.sh stop
for address in 172.30.0.1 100.64.0.9 169.254.169.254; do probe "$address"; done
printf 'network-boundary-passed\n'
