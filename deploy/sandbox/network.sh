#!/bin/sh
set -eu

# Only in the disposable VM or engine namespace, never on the controller.
chain=WFD-SANDBOX
case "$1" in
  host)
    subnet=${2:?Docker subnet required}
    for firewall in iptables ip6tables; do
      # Docker may not create the IPv6 hook on an IPv4-only network.
      "$firewall" -w -N DOCKER-USER 2>/dev/null || "$firewall" -w -S DOCKER-USER >/dev/null
      if ! "$firewall" -w -C FORWARD -j DOCKER-USER 2>/dev/null; then
        "$firewall" -w -I FORWARD 1 -j DOCKER-USER
      fi
      "$firewall" -w -N "$chain"
      "$firewall" -w -A "$chain" -o tailscale0 -j DROP
      if [ "$firewall" = iptables ]; then
        for destination in "$subnet" 100.64.0.0/10 169.254.0.0/16 168.63.129.16/32; do
          "$firewall" -w -A "$chain" -d "$destination" -j DROP
        done
      fi
      "$firewall" -w -I DOCKER-USER 1 -i wfd-sandbox0 -j "$chain"
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
    ;;
  stop)
    for firewall in iptables ip6tables; do
      for entry in "DOCKER-USER:$chain" INPUT:WFD-HOST; do
        parent=${entry%:*}
        owned=${entry#*:}
        if "$firewall" -w -C "$parent" -i wfd-sandbox0 -j "$owned" 2>/dev/null; then
          "$firewall" -w -D "$parent" -i wfd-sandbox0 -j "$owned"
        fi
        if "$firewall" -w -S "$owned" >/dev/null 2>&1; then
          "$firewall" -w -F "$owned"
          "$firewall" -w -X "$owned"
        fi
      done
    done
    ;;
  *) exit 2 ;;
esac
