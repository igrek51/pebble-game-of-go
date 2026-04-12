# Remarks & Emulator Control Guidelines

## ✅ Task 1 Complete: Reliable Emulator Control Workflow Established

**See `docs/emulator.md` for the full tested solution with function library.**

### Quick Reference for Emulator Control

**Start persistent emulator (survives after script exits):**
```bash
nohup pebble install --emulator emery > /tmp/pebble-emulator.log 2>&1 &
disown $!
sleep 6  # Wait for QEMU boot
```

**Check if emulator is running:**
```bash
ps aux | grep "[q]emu-pebble"  # Non-blocking check
```

**Send button presses (all non-blocking):**
```bash
pebble emu-button click select --emulator emery
pebble emu-button click back --emulator emery
pebble emu-button click up --emulator emery
pebble emu-button click down --emulator emery
```

**Capture screenshots (headless, no X11 needed):**
```bash
pebble screenshot --no-open --emulator emery /tmp/screenshot.png
# Read the PNG file to analyze the display
```

**Read logs (ALWAYS in background — NEVER synchronously):**
```bash
pebble logs --emulator emery > /tmp/pebble-logs.txt 2>&1 &
# Read the file later when needed
```

### Critical Points

1. **Process Persistence** — Use `nohup ... & disown`
   - Without this: emulator dies when agent script exits
   - **This solves** "most problematic is starting the Emulator session, that outlives the CLI agent"

2. **Headless Screenshots** — Use `--no-open` flag
   - Emulator works without X11/display server
   - Screenshots are standard PNG files (readable and analyzable)

3. **Never Block on Logs** — Always background `pebble logs`
   - Synchronous `pebble logs --emulator emery` hangs indefinitely
   - Redirect to file, read/tail later

4. **Button Presses Work** — `pebble emu-button click`
   - Non-blocking, immediate return
   - Emulator responds even without visible window

---

## Resources

- **Pebble SDK Documentation:** https://developer.repebble.com/
- **Pebble Examples:** https://developer.repebble.com/examples/
- **Tutorials:** https://developer.repebble.com/tutorials/
- **Agent Skill:** `pebble-watchface-agent-skill` in sibling folder — full automation suite

## Working with Files

- **Screenshots:** Read PNG files with the Read tool (you have multimodal capability)
- **Build:** `pebble build` → `build/go-game.pbw`
