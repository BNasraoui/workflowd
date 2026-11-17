#!/bin/sh
set -eu

# Only in the disposable VM or engine namespace, never on the controller.
chain=WFD-SANDBOX
case "$1" in
  host)
    subnet=${2:?Docker subnet required}
    for firewall in iptables ip6tables; do
      # The forward rules are in the mangle table, which the kernel reads before the filter
      # table. In the filter table, tailscaled puts its own jump (ts-forward) first in FORWARD,
      # above Docker's DOCKER-USER, and ts-forward accepts each packet out of tailscale0: the
      # box then reaches the tailnet, 100.100.100.100 (tailscaled's resolver) too. The runner's
      # own packets go through OUTPUT, not FORWARD, and these rules do not see them.
      "$firewall" -w -t mangle -N "$chain"
      "$firewall" -w -t mangle -A "$chain" -o tailscale0 -j DROP
      if [ "$firewall" = iptables ]; then
        for destination in "$subnet" 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 168.63.129.16/32; do
          "$firewall" -w -t mangle -A "$chain" -d "$destination" -j DROP
        done
      else
        for destination in ::1/128 fc00::/7 fe80::/10 ff00::/8; do
          "$firewall" -w -t mangle -A "$chain" -d "$destination" -j DROP
        done
      fi
      "$firewall" -w -t mangle -I FORWARD 1 -i wfd-sandbox0 -j "$chain"
      # All local addresses, including eth0 and docker0, traverse INPUT.
      "$firewall" -w -N WFD-HOST
      "$firewall" -w -A WFD-HOST -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
      "$firewall" -w -A WFD-HOST -j DROP
      "$firewall" -w -I INPUT 1 -i wfd-sandbox0 -j WFD-HOST
    done
    ;;
  engine)
    subnet=${2:?Docker subnet required}
    shift 2
    iptables -w -N "$chain"
    for destination in "$subnet" 100.64.0.0/10 172.17.0.1/32 169.254.0.0/16 168.63.129.16/32 "$@"; do
      iptables -w -A "$chain" -d "$destination" -j DROP
    done
    # CNI inserts ACCEPT rules ahead of ordinary FORWARD hooks. Its admin
    # chain runs first and is preserved when CNI creates/removes containers.
    # The engine can create this shared chain concurrently during startup.
    iptables -w -N CNI-ADMIN 2>/dev/null || iptables -w -S CNI-ADMIN >/dev/null
    iptables -w -I CNI-ADMIN 1 -i dagger0 -j "$chain"
    # Dagger's embedded resolver is the sole agent-to-engine exception.
    iptables -w -N WFD-ENGINE
    for protocol in udp tcp; do
      iptables -w -A WFD-ENGINE -d 10.87.0.1 -p "$protocol" --dport 53 -j ACCEPT
    done
    iptables -w -A WFD-ENGINE -j DROP
    iptables -w -I INPUT 1 -i dagger0 -j WFD-ENGINE
    # The engine's pinned legacy ip6tables needs optional host kernel modules.
    # Disable IPv6 in this namespace instead, including dagger0 if CNI creates
    # it later. Agent DNS uses the IPv4 resolver above.
    sysctl -w net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1 >/dev/null
    ;;
  stop)
    for firewall in iptables ip6tables; do
      for entry in "mangle:FORWARD:$chain" filter:INPUT:WFD-HOST; do
        table=${entry%%:*}
        parent=${entry#*:}
        parent=${parent%:*}
        owned=${entry##*:}
        if "$firewall" -w -t "$table" -C "$parent" -i wfd-sandbox0 -j "$owned" 2>/dev/null; then
          "$firewall" -w -t "$table" -D "$parent" -i wfd-sandbox0 -j "$owned"
        fi
        if "$firewall" -w -t "$table" -S "$owned" >/dev/null 2>&1; then
          "$firewall" -w -t "$table" -F "$owned"
          "$firewall" -w -t "$table" -X "$owned"
        fi
      done
    done
    ;;
  *) exit 2 ;;
esac
