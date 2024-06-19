#!/bin/bash
set -e

# If the first argument is a flag, pass it as an argument to npm start
if [ "${1:0:1}" = '-' ]; then
  set -- npm start "$@"
fi

# If the first argument is npm or node, execute the command
if [ "$1" = 'npm' ] || [ "$1" = 'node' ]; then
  exec "$@"
fi

# Default command
exec "$@"
