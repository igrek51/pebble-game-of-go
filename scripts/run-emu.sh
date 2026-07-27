#!/bin/bash -ex
export DISPLAY=:0
eval "$(systemctl --user show-environment | grep '^XAUTHORITY')"
export XAUTHORITY
pebble install --emulator emery 2>&1
