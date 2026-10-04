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
retry_delay=1

while true; do
	remaining=15
	if (( timeout > 0 )); then
		remaining=$(( timeout - (SECONDS - started) ))
		if (( remaining <= 0 )); then
			printf 'wait-mailbox: timed out after %s seconds waiting for %s\n' "$timeout" "$mailbox_id" >&2
			exit 1
		fi
		if (( remaining > 15 )); then remaining=15; fi
	fi
	connect_timeout=5
	if (( remaining < connect_timeout )); then connect_timeout=$remaining; fi
	request_error=0
	status=$(curl --silent --show-error --connect-timeout "$connect_timeout" --max-time "$remaining" \
		--output "$response_file" --write-out '%{http_code}' \
		--header 'Content-Type: application/json' \
		--header 'Accept: application/json, text/event-stream' \
		--header "Authorization: Bearer $token" \
		--data "$request" "$url") || request_error=$?
	if (( request_error != 0 )); then
		case "$request_error" in
			7|28|52|56) ;;
			*) printf 'wait-mailbox: MCP HTTP request failed (curl exit %s)\n' "$request_error" >&2; exit 1 ;;
		esac
	elif [[ "$status" == 401 || "$status" == 403 ]]; then
		printf 'wait-mailbox: unauthorized (MCP HTTP error %s)\n' "$status" >&2
		exit 1
	elif [[ "$status" == 5* ]]; then
		:
	elif [[ "$status" != 2* ]]; then
		printf 'wait-mailbox: MCP HTTP error %s\n' "$status" >&2
		exit 1
	else
		if jq -e '.result.isError == true' "$response_file" >/dev/null 2>&1; then
			printf 'wait-mailbox: %s\n' "$(jq -r '.result.content[0].text // "MCP tool error"' "$response_file")" >&2
			exit 1
		fi
		if ! jq -e '.result.structuredContent.messages | type == "array"' "$response_file" >/dev/null 2>&1; then
			printf 'wait-mailbox: invalid MCP mailbox response\n' >&2
			exit 1
		fi
		if jq -e '.result.structuredContent.messages | length > 0' "$response_file" >/dev/null 2>&1; then
			if ! message=$(jq -ce '.result.structuredContent.messages[0] | select(type == "object" and has("run_id") and has("status") and has("final_message") and has("final_message_ref"))' "$response_file"); then
				printf 'wait-mailbox: invalid terminal mailbox message\n' >&2
				exit 1
			fi
			printf '%s\n' "$message"
			exit 0
		fi
		retry_delay=30
	fi
	if (( timeout > 0 && SECONDS - started >= timeout )); then
		printf 'wait-mailbox: timed out after %s seconds waiting for %s\n' "$timeout" "$mailbox_id" >&2
		exit 1
	fi
	sleep_for=$retry_delay
	if (( timeout > 0 && timeout - (SECONDS - started) < sleep_for )); then
		sleep_for=$(( timeout - (SECONDS - started) ))
	fi
	sleep "$sleep_for"
	if (( retry_delay < 30 )); then
		retry_delay=$(( retry_delay * 2 ))
		if (( retry_delay > 30 )); then retry_delay=30; fi
	fi
done
