#!/usr/bin/env bash
# A small local example; stdout is data and stderr is diagnostic output.
if [[ "${1:-}" == "--help" ]]; then
  printf '%s\n' 'Usage: pass-input.sh' 'Copy stdin to stdout. Useful for checking trigger data.'
  exit 0
fi
cat
