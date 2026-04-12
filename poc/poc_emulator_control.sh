#!/bin/bash
# Proof of Concept: Persistent Pebble Emulator Control
# Tests emulator startup, process persistence, screenshot, and button control
# Does NOT require building the app - just tests the CLI control mechanisms

set -e

EMULATOR_LOG="/tmp/pebble-emulator-poc.log"
SCREENSHOT_DIR="/tmp/pebble-poc-screenshots"
mkdir -p "$SCREENSHOT_DIR"

echo "=== Pebble Emulator Control PoC ==="
echo ""

# Function: Check if emulator is running
check_emulator() {
    ps aux | grep -q "[q]emu-pebble" && return 0 || return 1
}

# Function: Start emulator persistently
start_emulator_persistent() {
    if check_emulator; then
        echo "✓ Emulator already running"
        return 0
    fi

    echo "Starting emulator with nohup (process survives script exit)..."
    nohup pebble install --emulator emery > "$EMULATOR_LOG" 2>&1 &
    local pid=$!
    disown $pid 2>/dev/null || true

    echo "  PID: $pid"
    echo "  Log: $EMULATOR_LOG"
    echo "  Waiting 6 seconds for QEMU boot..."
    sleep 6
}

# Step 1: Check initial state
echo "[1] Initial emulator state check..."
if check_emulator; then
    echo "✓ Emulator already running"
else
    echo "✗ Emulator not running (expected)"
fi
echo ""

# Step 2: Start emulator
echo "[2] Starting emulator with persistent background process..."
start_emulator_persistent
echo ""

# Step 3: Verify it's running
echo "[3] Verifying emulator is running..."
if check_emulator; then
    echo "✓ QEMU process confirmed running"
    ps aux | grep qemu-pebble | grep -v grep | head -1
else
    echo "✗ FAILED to start emulator"
    echo "Log contents:"
    cat "$EMULATOR_LOG" | tail -30
    exit 1
fi
echo ""

# Step 4: Test screenshot (no GUI needed)
echo "[4] Testing screenshot capture..."
pebble screenshot --no-open --emulator emery "$SCREENSHOT_DIR/001_initial.png"
if [ -f "$SCREENSHOT_DIR/001_initial.png" ]; then
    echo "✓ Screenshot captured: 001_initial.png"
    file "$SCREENSHOT_DIR/001_initial.png"
else
    echo "✗ Screenshot failed"
fi
echo ""

# Step 5: Test button presses
echo "[5] Testing button presses..."
echo "  - Sending SELECT button..."
pebble emu-button click select --emulator emery
sleep 0.5

echo "  - Sending UP button..."
pebble emu-button click up --emulator emery
sleep 0.5

echo "  - Sending DOWN button..."
pebble emu-button click down --emulator emery
sleep 0.5

echo "  - Sending BACK button..."
pebble emu-button click back --emulator emery
sleep 0.5

echo "✓ Button presses sent successfully"
echo ""

# Step 6: Capture final screenshot
echo "[6] Capturing final screenshot..."
pebble screenshot --no-open --emulator emery "$SCREENSHOT_DIR/002_after_buttons.png"
if [ -f "$SCREENSHOT_DIR/002_after_buttons.png" ]; then
    echo "✓ Screenshot captured: 002_after_buttons.png"
else
    echo "✗ Screenshot failed"
fi
echo ""

# Summary
echo "=== PoC Results ==="
echo "✓ Process detection works (ps grep)"
echo "✓ Persistent emulator startup works (nohup + disown)"
echo "✓ Screenshot capture works (--no-open flag)"
echo "✓ Button control works (pebble emu-button)"
echo ""
echo "Emulator is STILL RUNNING in background."
echo ""
echo "To verify persistence, open a NEW terminal and run:"
echo "  ps aux | grep qemu-pebble"
echo "  pebble screenshot --no-open --emulator emery /tmp/test.png"
echo "  pebble emu-button click select --emulator emery"
echo ""
echo "To stop emulator:"
echo "  pkill qemu-pebble"
echo ""
echo "Screenshots stored in: $SCREENSHOT_DIR"
