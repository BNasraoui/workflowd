#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || -z "$1" || ( $# -eq 2 && ! "$2" =~ ^[1-9][0-9]*$ ) ]]; then
	printf 'usage: wait-mailbox.sh <mailbox_id> [timeout_seconds]\n' >&2
	exit 2
fi

mailbox_id=$1
timeout=${2:-0}
url=${WORKFLOWD_MCP_URL:-http://127.0.0.1:8791/mcp}
token=${WORKFLOWD_MCP_TOKEN:-}
if [[ -z "$token" && -f "$HOME/.config/workflowd/mcp-token" ]]; then
	token=$(<"$HOME/.config/workflowd/mcp-token")
fi
if [[ -z "$token" ]]; then
	printf 'wait-mailbox: MCP bearer token missing (WORKFLOWD_MCP_TOKEN or ~/.config/workflowd/mcp-token)\n' >&2
	exit 1
fi

request=$(jq -nc --arg mailbox_id "$mailbox_id" \
	'{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"read_agent_mailbox",arguments:{mailbox_id:$mailbox_id}}}')
response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT
started=$SECONDS

while true; do
	if ! status=$(curl --silent --show-error --connect-timeout 5 --max-time 15 \
		--output "$response_file" --write-out '%{http_code}' \
		--header 'Content-Type: application/json' \
		--header 'Accept: application/json, text/event-stream' \
		--header "Authorization: Bearer $token" \
		--data "$request" "$url"); then
		printf 'wait-mailbox: MCP HTTP request failed\n' >&2
		exit 1
	fi
	if [[ "$status" != 2* ]]; then
		printf 'wait-mailbox: MCP HTTP error %s\n' "$status" >&2
		exit 1
	fi
	if ! jq -e '.result.structuredContent.messages | type == "array"' "$response_file" >/dev/null 2>&1; then
		if jq -e '.result.isError == true' "$response_file" >/dev/null 2>&1; then
			printf 'wait-mailbox: %s\n' "$(jq -r '.result.content[0].text // "MCP tool error"' "$response_file")" >&2
		else
			printf 'wait-mailbox: invalid MCP mailbox response\n' >&2
		fi
		exit 1
	fi
	if message=$(jq -ce '.result.structuredContent.messages[0]' "$response_file"); then
		printf '%s\n' "$message"
		exit 0
	fi
	if (( timeout > 0 && SECONDS - started >= timeout )); then
		printf 'wait-mailbox: timed out after %s seconds waiting for %s\n' "$timeout" "$mailbox_id" >&2
		exit 1
	fi
	sleep_for=30
	if (( timeout > 0 && timeout - (SECONDS - started) < sleep_for )); then
		sleep_for=$(( timeout - (SECONDS - started) ))
	fi
	sleep "$sleep_for"
done
