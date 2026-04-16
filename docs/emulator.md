# Pebble Emulator Control — Reliable CLI-Based Development Flow

This document establishes a proven, automated workflow for controlling the Pebble Time 2 (`emery`) emulator from CLI agents without graphical interaction. The solution enables agents to start, control, and test apps on the emulator autonomously.

## Problem Statement

The Pebble emulator presents challenges for agent automation:
1. **Graphical interface** requires X11/display server (not available in headless environments)
2. **Process attachment** — emulator typically dies when parent shell exits
3. **Process coordination** — blocking commands like `pebble logs` hang indefinitely
4. **Interactive input** — no direct way to simulate button presses programmatically

This document provides tested solutions for all four challenges.

---

## Proven Solution Architecture

```
Agent Script (exits)
    ↓
    └─→ Launch: nohup pebble install --emulator emery ... &
            ↓
            └─→ QEMU Emulator (detached, persists independently)
                    ↓
                    ├─→ Receives: pebble emu-button (button clicks)
                    ├─→ Sends: pebble screenshot (display capture)
                    ├─→ Updates: pebble install (app reinstall)
                    └─→ Logs: pebble logs (background process)
```

The key: **process detachment via `nohup` + `disown`** allows the emulator to survive after the agent exits.

---

## Core Operations

### 1. Check If Emulator Is Running

**Reliable detection using process lookup:**

```bash
# Non-blocking check
if ps aux | grep -q "[q]emu-pebble"; then
    echo "Emulator is running"
else
    echo "Emulator is NOT running"
fi
```

The `[q]emu-pebble` syntax (bracket around first character) prevents matching the grep command itself.

### 2. Start Emulator Persistently

**The critical insight: use `nohup` to decouple from parent shell**

```bash
# Start emulator in detached background process
nohup pebble install --emulator emery > /tmp/pebble-emulator.log 2>&1 &
local pid=$!
disown $pid 2>/dev/null || true

# Wait for QEMU to fully boot (typically 5-6 seconds)
sleep 6
```

**Why this works:**
- `nohup` ignores SIGHUP (hangup), so process survives parent exit
- `disown` removes process from job table, further detaching it
- Redirection to file prevents stdout/stderr from blocking
- Sleep allows QEMU time to initialize communication ports

**Why alternatives fail:**
- `pebble install --emulator emery` alone: emulator dies when script exits
- `screen` or `tmux`: requires interactive setup, not suitable for agents
- Background `&` without `disown`: shell still tracks it, can interfere

---

### 3. Take Screenshots (No GUI Needed)

**Screenshot works headless with the `--no-open` flag:**

```bash
pebble screenshot --no-open --emulator emery /tmp/screenshot.png
```

Output is a standard PNG file that agents can read and analyze. No X11 or display server required.

---

### 4. Send Button Presses

**Four buttons available:**

```bash
pebble emu-button click select --emulator emery    # Confirm/Accept
pebble emu-button click back --emulator emery       # Cancel/Back
pebble emu-button click up --emulator emery         # Move up
pebble emu-button click down --emulator emery       # Move down
```

Each command is non-blocking and returns immediately.

---

### 5. Read Logs (Background Process)

⚠️ **CRITICAL:** `pebble logs` blocks indefinitely. Always run in background.

```bash
# Start logging in background
pebble logs --emulator emery > /tmp/pebble-logs.txt 2>&1 &
local log_pid=$!

# Continue with other work...

# Kill logging process when done
kill $log_pid 2>/dev/null
```

---

## Complete Tested Function Library

Copy this into shell scripts for agent-ready emulator control:

```bash
#!/bin/bash

# Configuration
EMULATOR_LOG="/tmp/pebble-emulator.log"
SCREENSHOT_FILE="/tmp/pebble-screenshot.png"
LOGS_FILE="/tmp/pebble-logs.txt"

# ============================================================================
# Core Functions
# ============================================================================

# Check if emulator process is running
is_emulator_running() {
    ps aux | grep -q "[q]emu-pebble" && return 0 || return 1
}

# Start emulator in persistent background session
start_emulator() {
    if is_emulator_running; then
        echo "✓ Emulator already running"
        return 0
    fi
    
    echo "Starting emulator..."
    nohup pebble install --emulator emery > "$EMULATOR_LOG" 2>&1 &
    local pid=$!
    disown $pid 2>/dev/null || true
    
    echo "  Waiting 6 seconds for QEMU boot..."
    sleep 6
    
    if is_emulator_running; then
        echo "✓ Emulator started (PID: $pid)"
        return 0
    else
        echo "✗ Emulator failed to start"
        echo "  Log: $EMULATOR_LOG"
        tail -20 "$EMULATOR_LOG"
        return 1
    fi
}

# Stop emulator
stop_emulator() {
    if ! is_emulator_running; then
        echo "Emulator not running"
        return 0
    fi
    
    echo "Stopping emulator..."
    pkill qemu-pebble
    sleep 2
    
    if is_emulator_running; then
        echo "✗ Force-killing emulator..."
        pkill -9 qemu-pebble
    else
        echo "✓ Emulator stopped"
    fi
}

# Capture screenshot
take_screenshot() {
    local output="${1:-$SCREENSHOT_FILE}"
    
    if ! is_emulator_running; then
        echo "✗ Emulator not running"
        return 1
    fi
    
    pebble screenshot --no-open --emulator emery "$output" || return 1
    echo "✓ Screenshot: $output"
    return 0
}

# Send button press (non-blocking)
press_button() {
    local button="$1"
    if [ -z "$button" ]; then
        echo "Usage: press_button <up|down|select|back>"
        return 1
    fi
    
    if ! is_emulator_running; then
        echo "✗ Emulator not running"
        return 1
    fi
    
    pebble emu-button click "$button" --emulator emery
    sleep 0.1  # Brief delay to let emulator process input
}

# Start background logging
start_logging() {
    if ! is_emulator_running; then
        echo "✗ Emulator not running"
        return 1
    fi
    
    echo "Starting background logging..."
    pebble logs --emulator emery > "$LOGS_FILE" 2>&1 &
    local pid=$!
    echo $pid > /tmp/pebble-logs.pid
    echo "✓ Logging started (PID: $pid, output: $LOGS_FILE)"
}

# Stop background logging
stop_logging() {
    if [ -f /tmp/pebble-logs.pid ]; then
        local pid=$(cat /tmp/pebble-logs.pid)
        kill $pid 2>/dev/null
        rm /tmp/pebble-logs.pid
        echo "✓ Logging stopped"
    fi
}

# Show recent logs
show_logs() {
    if [ -f "$LOGS_FILE" ]; then
        tail -30 "$LOGS_FILE"
    else
        echo "No logs available"
    fi
}

# ============================================================================
# Example Test Workflow
# ============================================================================

test_emulator_control() {
    echo "=== Emulator Control Test ==="
    
    # 1. Start emulator
    start_emulator || return 1
    echo ""
    
    # 2. Verify running
    echo "Status:"
    is_emulator_running && echo "✓ Emulator running"
    echo ""
    
    # 3. Capture initial state
    echo "Capturing initial screenshot..."
    take_screenshot /tmp/test_1_initial.png
    echo ""
    
    # 4. Send button presses
    echo "Testing button presses..."
    press_button select
    press_button up
    press_button down
    echo ""
    
    # 5. Capture final state
    echo "Capturing final screenshot..."
    take_screenshot /tmp/test_2_final.png
    echo ""
    
    echo "✓ Test complete"
    echo "  Initial: /tmp/test_1_initial.png"
    echo "  Final:   /tmp/test_2_final.png"
}

# Run test if script is executed directly
if [ "$0" = "${BASH_SOURCE[0]}" ]; then
    test_emulator_control
fi
```

---

## Agent Workflow Pattern

Typical usage in an agent loop:

```bash
#!/bin/bash
set -e
source ./emulator-control.sh

# 1. Ensure emulator is running
start_emulator

# 2. Build and install app
pebble build
pebble install --emulator emery
sleep 2

# 3. Test sequence
take_screenshot /tmp/state_1.png
# → Use Read tool to analyze screenshot

press_button select
sleep 1

take_screenshot /tmp/state_2.png
# → Use Read tool to analyze result

# 4. Cleanup (emulator stays running for next iteration)
show_logs
```

---

## Proof of Concept Results

Tested on 2026-04-12 with the following verified outcomes:

✅ **Process Detection:** `ps aux | grep [q]emu-pebble` works reliably  
✅ **Persistent Startup:** `nohup ... &` + `disown` keeps emulator running after script exit  
✅ **Screenshot Capture:** `pebble screenshot --no-open` produces valid PNG files  
✅ **Button Control:** `pebble emu-button click <button>` sends input successfully  
✅ **Non-blocking:** All commands return immediately (except intentional sleeps)  

**QEMU Command Line Used:**
```
/home/igrek/.pebble-sdk/SDKs/4.9.148/toolchain/bin/qemu-pebble \
  -rtc base=localtime \
  -serial null \
  -serial tcp::PORT,server,nowait \
  -pflash /path/to/qemu_micro_flash.bin \
  -gdb tcp::PORT,server,nowait \
  -monitor tcp::PORT,server,nowait \
  -machine pebble-snowy-emery-bb \
  -cpu cortex-m4 \
  -pflash /path/to/qemu_spi_flash.bin
```

---

## Key Design Decisions

| Challenge | Solution | Why |
|-----------|----------|-----|
| Emulator dies when agent exits | `nohup` + `disown` | Process becomes independent |
| Don't know when QEMU is ready | Fixed sleep(6) | QEMU typically ready in 5–6 sec |
| Screenshots fail in headless | `--no-open` flag | Prevents image viewer launch |
| Button presses missed | Small sleep after press | Gives emulator time to process |
| Logs block forever | Background process + file redirection | Prevents script hang |
| Can't verify state | Read PNG screenshots | Visual feedback replaces output |

---

## Troubleshooting

| Issue | Diagnosis | Solution |
|-------|-----------|----------|
| Emulator won't start | Check `$EMULATOR_LOG` | Verify SDK installed, check disk space |
| Screenshot is black | QEMU still booting | Increase sleep time to 8-10 seconds |
| Button presses ignored | App may be frozen/crashed | Check logs with `show_logs` |
| Logs don't appear | Process may have exited | Restart with `start_logging` |
| Port conflicts | Multiple emulator instances | Kill others with `pkill qemu-pebble` |

---

## Limitations & Future Work

1. **No keyboard input simulation** — only button presses (select/back/up/down)
2. **No touch input** — Pebble buttons only
3. **No accelerometer/sensor simulation** — beyond `pebble emu-tap` (if implemented)
4. **No persistent storage** — emulator state resets on restart
5. **Single-instance only** — can't run multiple emulator versions simultaneously

## Useful commands
```
pebble kill # Kills running emulators, if any.
pebble wipe # Wipes data for running emulators. By default, only clears data for the current SDK version.
pebble install --emulator emery # Installs the given app on the watch.
pebble screenshot # Takes a screenshot from the watch.

pebble --help # see other useful commands
```

## References

- [Pebble SDK Documentation](https://developer.repebble.com/)
- [Pebble Tool Command Reference](https://developer.repebble.com/guides/tools-and-resources/pebble-tool/)
- [QEMU for Pebble](https://github.com/pebble/qemu)
