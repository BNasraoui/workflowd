#!/bin/sh
set -eu
# A sidecar shares the real engine's network namespace. Only the synthetic
# destinations below route through this disposable stand-in for the runner VM.
ip netns add host
ip netns add target
ip netns add tailtarget
ip link add engine-probe type veth peer name ingress
ip link set ingress netns host
# Pin the MAC: temporary IPv6 probe ports must not invalidate cached ARP entries.
ip -n host link add wfd-sandbox0 address 02:00:00:00:00:01 type bridge
ip -n host addr add 198.18.0.1/24 dev wfd-sandbox0
ip -n host link set wfd-sandbox0 up
ip -n host link set ingress master wfd-sandbox0
ip -n host link set ingress up
ip addr add 198.18.0.2/24 dev engine-probe
ip link set engine-probe up
ip -n host link add external type veth peer name peer
ip -n host link set peer netns target
ip -n host addr add 192.0.2.1/24 dev external
ip -n host link set external up
ip -n target addr add 192.0.2.2/24 dev peer
ip -n target link set peer up
ip -n target link set lo up
ip -n target route add default via 192.0.2.1
for address in 10.23.0.2 172.16.254.2 192.168.23.2 169.254.169.254 168.63.129.16 100.64.0.9; do
  ip -n target addr add "$address/32" dev peer
  ip -n host route add "$address/32" via 192.0.2.2
  ip route add "$address/32" via 198.18.0.1
done
ip route add 192.0.2.2/32 via 198.18.0.1
ip netns exec host sysctl -w net.ipv4.ip_forward=1 >/dev/null
ip -n host link add tailscale0 type veth peer name tailpeer
ip -n host link set tailpeer netns tailtarget
ip -n host addr add 198.51.100.1/24 dev tailscale0
ip -n tailtarget addr add 198.51.100.2/24 dev tailpeer
ip -n host link set tailscale0 up
ip -n tailtarget link set tailpeer up
ip -n tailtarget link set lo up
# Give the synthetic tailnet peer its own return path. Sharing target's
# default route through peer makes strict reverse-path filtering drop it.
ip -n tailtarget route add default via 198.51.100.1
ip route add 198.51.100.2/32 via 198.18.0.1
ip -n host -6 addr add 2001:db8:2::1/64 dev tailscale0 nodad
ip -n tailtarget -6 addr add 2001:db8:2::2/64 dev tailpeer nodad
ip netns exec target python3 -m http.server 80 >/tmp/http.log 2>&1 &
ip netns exec tailtarget python3 -m http.server 80 >/tmp/tail-http.log 2>&1 &
