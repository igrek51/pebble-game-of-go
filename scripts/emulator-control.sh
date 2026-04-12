#!/bin/bash
# Emulator control helper script

start_emulator() {
    if ps aux | grep -q "[q]emu-pebble"; then
        echo "✓ Emulator already running"
        return 0
    fi

    echo "Starting emulator..."
    nohup pebble install --emulator emery > /tmp/pebble-emulator.log 2>&1 &
    disown $! 2>/dev/null || true
    sleep 6

    if ps aux | grep -q "[q]emu-pebble"; then
        echo "✓ Emulator started"
        return 0
    else
        echo "✗ Emulator failed to start"
        tail -20 /tmp/pebble-emulator.log
        return 1
    fi
}

stop_emulator() {
    if ! ps aux | grep -q "[q]emu-pebble"; then
        echo "Emulator not running"
        return 0
    fi

    echo "Stopping emulator..."
    pkill qemu-pebble
    sleep 2

    if ! ps aux | grep -q "[q]emu-pebble"; then
        echo "✓ Emulator stopped"
        return 0
    else
        echo "Force-killing emulator..."
        pkill -9 qemu-pebble
        echo "✓ Emulator stopped"
        return 0
    fi
}

case "${1:-start}" in
    start)
        start_emulator
        ;;
    stop)
        stop_emulator
        ;;
    status)
        if ps aux | grep -q "[q]emu-pebble"; then
            echo "✓ Emulator is running"
            return 0
        else
            echo "Emulator is not running"
            return 1
        fi
        ;;
    *)
        echo "Usage: $0 {start|stop|status}"
        exit 1
        ;;
esac
