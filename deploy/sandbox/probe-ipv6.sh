#!/bin/sh
set -eu
# Run only on a disposable runner/engine. The source lives in a temporary
# namespace; restore all IPv6 forwarding settings and remove our address.
bridge=${1:?bridge required}
tailnet=${2:-}
namespace=wfd-probe-$$
link=wfdp$$
address=fd42:7766:64::1
source=fd42:7766:64::2
saved=$(mktemp -d)
address_added=false
for setting in /proc/sys/net/ipv6/conf/*/forwarding; do
  interface=${setting%/forwarding}
  cat "$setting" > "$saved/${interface##*/}"
done
cleanup() {
  ip netns del "$namespace" 2>/dev/null || true
  ip link del "$link" 2>/dev/null || true
  if "$address_added"; then ip -6 addr del "$address/128" dev "$bridge"; fi
  # Writing all changes individual interfaces too; restore it first.
  cat "$saved/all" > /proc/sys/net/ipv6/conf/all/forwarding
  for setting in "$saved"/*; do
    interface=${setting##*/}
    [ "$interface" != all ] || continue
    path=/proc/sys/net/ipv6/conf/$interface/forwarding
    if [ -f "$path" ]; then cat "$setting" > "$path"; fi
  done
  rm -rf "$saved"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
ip netns add "$namespace"
ip link add "$link" type veth peer name guest netns "$namespace"
ip link set "$link" master "$bridge"
ip link set "$link" up
ip -6 addr add "$address/128" dev "$bridge" nodad
address_added=true
ip -n "$namespace" link set guest up
ip -n "$namespace" -6 addr add "$source/128" dev guest nodad
ip -n "$namespace" -6 route add "$address/128" dev guest
mac=$(ip -o link show "$bridge" | sed -n 's/.*link\/ether \([^ ]*\).*/\1/p')
ip -n "$namespace" -6 neigh replace "$address" lladdr "$mac" dev guest nud permanent
if ip netns exec "$namespace" ping -6 -c 1 -W 2 "$address" >/dev/null 2>&1; then
  echo 'IPv6 bridge INPUT unexpectedly reachable' >&2
  exit 1
fi
if [ -n "$tailnet" ]; then
  # IPv6 checks the global forwarding switch before reaching FORWARD. Preserve
  # every interface's setting because writing "all" changes them as well.
  printf '1\n' > /proc/sys/net/ipv6/conf/all/forwarding
  ip -6 route get "$tailnet" | grep -q 'dev tailscale0'
  ip -n "$namespace" -6 route add "$tailnet/128" via "$address" dev guest
  if ip netns exec "$namespace" ping -6 -c 1 -W 2 "$tailnet" >/dev/null 2>&1; then
    echo 'IPv6 tailscale egress unexpectedly reachable' >&2
    exit 1
  fi
fi
ip6tables-save -c
