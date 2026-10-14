#!/bin/sh
set -eu
# Two synthetic peers, entirely inside a disposable network namespace.
# The enclosing Docker container resolves via its own embedded resolver.
getent hosts github.com >/dev/null
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
ip addr add 172.17.0.1/32 dev external
ip link set external up
ip -n target addr add 192.0.2.2/24 dev peer
ip -n target addr add 100.64.0.9/32 dev peer
ip -n target addr add 169.254.169.254/32 dev peer
ip -n target addr add 169.254.1.1/32 dev peer
ip -n target addr add 168.63.129.16/32 dev peer
ip -n target link set peer up
ip -n target route add default via 192.0.2.1
ip route add 100.64.0.0/10 via 192.0.2.2
ip route add 169.254.0.0/16 via 192.0.2.2
ip route add 168.63.129.16/32 via 192.0.2.2
sysctl -w net.ipv4.ip_forward=1 >/dev/null
sysctl -w net.ipv6.conf.all.disable_ipv6=0 >/dev/null
ip netns exec agent sysctl -w net.ipv6.conf.all.disable_ipv6=0 >/dev/null
ip netns exec target sysctl -w net.ipv6.conf.all.disable_ipv6=0 >/dev/null
sysctl -w net.ipv6.conf.all.forwarding=1 >/dev/null
ip addr add 2001:db8:30::1/64 dev wfd-sandbox0 nodad
ip -n agent addr add 2001:db8:30::2/64 dev guest nodad
ip -n agent -6 route add default via 2001:db8:30::1
ip addr add 2001:db8:1::1/64 dev external nodad
ip -n target addr add 2001:db8:1::2/64 dev peer nodad
ip -n target -6 route add default via 2001:db8:1::1
# Pin neighbor entries so ND timing and the intentional INPUT drop cannot
# masquerade as a forwarding denial; only test packets hit the DROP counters.
mac() { ip "$@" | sed -n 's/.*link\/ether \([^ ]*\).*/\1/p'; }
ip -6 neigh replace 2001:db8:30::2 lladdr "$(mac -n agent -o link show guest)" dev wfd-sandbox0 nud permanent
ip -n agent -6 neigh replace 2001:db8:30::1 lladdr "$(mac -o link show wfd-sandbox0)" dev guest nud permanent
ip -6 neigh replace 2001:db8:1::2 lladdr "$(mac -n target -o link show peer)" dev external nud permanent
ip -n target -6 neigh replace 2001:db8:1::1 lladdr "$(mac -o link show external)" dev peer nud permanent
ip link add tailscale0 type veth peer name tailpeer
ip link set tailpeer netns target
ip addr add 198.51.100.1/24 dev tailscale0
ip -n target addr add 198.51.100.2/24 dev tailpeer
ip link set tailscale0 up
ip -n target link set tailpeer up
ip addr add 2001:db8:2::1/64 dev tailscale0 nodad
ip -n target addr add 2001:db8:2::2/64 dev tailpeer nodad
ip -6 neigh replace 2001:db8:2::2 lladdr "$(mac -n target -o link show tailpeer)" dev tailscale0 nud permanent
iptables -N DOCKER-USER
iptables -A FORWARD -j DOCKER-USER
probe() {
  destination=$1
  ip netns exec agent ping -c 1 -W 2 "$destination" >/dev/null 2>&1
}
for address in 172.30.0.1 192.0.2.1 172.17.0.1 100.64.0.9 169.254.169.254 169.254.1.1 168.63.129.16; do probe "$address"; done
probe 2001:db8:30::1
probe 2001:db8:1::1
probe 2001:db8:1::2
probe 198.51.100.2
probe 2001:db8:2::2
sh /network.sh host 172.30.0.0/24
for address in 2001:db8:30::1 2001:db8:1::1; do
  if probe "$address"; then exit 1; fi
done
ip6tables -nvxL WFD-HOST | awk '$3 == "DROP" {n += $1} END {exit !(n > 0)}'
for address in 172.30.0.1 192.0.2.1 172.17.0.1 100.64.0.9 169.254.169.254 169.254.1.1 168.63.129.16; do
  if probe "$address"; then exit 1; fi
done
# Both INPUT and forwarding must record actual drops, not just rule presence.
for chain in WFD-HOST WFD-SANDBOX; do
  iptables -nvxL "$chain" | awk '$3 == "DROP" {n += $1} END {exit !(n > 0)}'
done
# Public egress, Docker DNS and replies to host-initiated connections still work.
getent hosts github.com >/dev/null
ping -c 1 -W 1 172.30.0.2 >/dev/null
probe 192.0.2.2
ip netns exec target ping -c 1 -W 1 172.30.0.1 >/dev/null
# An accepted subnet route must not bypass the tailnet boundary in either family.
for address in 198.51.100.2 2001:db8:2::2; do
  if probe "$address"; then exit 1; fi
done
for firewall in iptables ip6tables; do
  "$firewall" -nvxL WFD-SANDBOX | awk '$3 == "DROP" && $7 == "tailscale0" {n += $1} END {exit !(n > 0)}'
done
sh /network.sh stop
sh /network.sh stop
for address in 172.30.0.1 192.0.2.1 172.17.0.1 100.64.0.9 169.254.169.254 169.254.1.1 168.63.129.16; do probe "$address"; done
printf 'network-boundary-passed\n'
