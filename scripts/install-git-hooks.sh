#!/bin/sh

set -eu

repository_root=$(git rev-parse --show-toplevel)
git -C "$repository_root" config --local core.hooksPath .githooks
printf '%s\n' "Configured core.hooksPath=.githooks for $repository_root"
