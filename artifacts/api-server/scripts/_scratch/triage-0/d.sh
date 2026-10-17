#!/bin/sh
# wrapper: no MSYS path conversion, secrets file in the session scratchpad
export MSYS_NO_PATHCONV=1
export TRIAGE0_SECRETS="C:/Users/hanst/AppData/Local/Temp/claude/c--Cooking-App-Kiwi-App/10e6bf86-3997-43f3-a7e2-b9c14dbb75b8/scratchpad/secrets.json"
exec node "$(dirname "$0")/drive.cjs" "$@"
