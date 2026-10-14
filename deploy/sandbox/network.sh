#!/bin/sh
set -eu

# This script runs only in the disposable VM or its engine namespace.
# Do not apply it to the controller. Keep all rules in owned chains.
chain=WFD-SANDBOX
case "$1" in
  host)
    subnet=${2:?Docker subnet required}
    iptables -w -N "$chain"
    for destination in "$subnet" 100.64.0.0/10 169.254.169.254/32; do
      iptables -w -A "$chain" -d "$destination" -j DROP
    done
    iptables -w -I DOCKER-USER 1 -i wfd-sandbox0 -j "$chain"
    # Packets to the Docker gateway are local INPUT, not forwarded traffic.
    iptables -w -I INPUT 1 -i wfd-sandbox0 -j "$chain"
    ;;
  engine)
    subnet=${2:?Docker subnet required}
    iptables -w -N "$chain"
    for destination in "$subnet" 100.64.0.0/10 169.254.169.254/32; do
      iptables -w -A "$chain" -d "$destination" -j DROP
    done
    iptables -w -I FORWARD 1 -i dagger0 -j "$chain"
    # Dagger's embedded resolver is the sole agent-to-engine exception.
    iptables -w -N WFD-ENGINE
    for protocol in udp tcp; do
      iptables -w -A WFD-ENGINE -d 10.87.0.1 -p "$protocol" --dport 53 -j ACCEPT
    done
    iptables -w -A WFD-ENGINE -j DROP
    iptables -w -I INPUT 1 -i dagger0 -j WFD-ENGINE
    ;;
  stop)
    for parent in DOCKER-USER INPUT; do
      if iptables -w -C "$parent" -i wfd-sandbox0 -j "$chain" 2>/dev/null; then
        iptables -w -D "$parent" -i wfd-sandbox0 -j "$chain"
      fi
    done
    if iptables -w -S "$chain" >/dev/null 2>&1; then
      iptables -w -F "$chain"
      iptables -w -X "$chain"
    fi
    ;;
  *) exit 2 ;;
esac
