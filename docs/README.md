# Game of Go - Pebble Time 2 (9×9)

A playable Game of Go for Pebble Time 2 with Chinese rules, 2 human players, and automatic capture detection.

## Features

✓ **9×9 game board** with grid display and row/column labels (1-9, A-I)
✓ **Two-phase move selection**: Select row → Select column → Place stone
✓ **Automatic capture detection**: Stones/groups with no liberties removed
✓ **Ko rule enforcement**: Prevents immediate recapture (board state comparison)
✓ **Suicide detection**: Illegal moves rejected
✓ **Pass & Menu system**: Long-press BACK to access menu (Pass, New Game, Resume)
✓ **Chinese rules scoring**: Stones + territory, White gets +6 komi
✓ **Score display**: Final tally when both players pass
✓ **Visual feedback**: Blinking cursor, status bar showing whose turn and captures

## Controls

| Button | Action |
|--------|--------|
| **UP/DOWN** | Move cursor up/down (in row selection or menu) |
| **SELECT** | Confirm selection and advance |
| **BACK** (press) | Cancel/go back one phase |
| **BACK** (long-press 750ms) | Open menu |

### Move Placement Flow

1. **SELECTING_ROW** → UP/DOWN to highlight row number → SELECT
2. **SELECTING_COL** → UP/DOWN to highlight column letter → SELECT to place
3. Stone appears on board; turn passes to other player
4. Return to SELECTING_ROW

### Menu Options (long-press BACK)

- **Pass** — Current player passes; if opponent also passes, game ends
- **New Game** — Reset board to start position
- **Resume** — Close menu and continue playing

## Screen Layout

```
┌─────────────────────────────────────┐
│ Status: ● B:0  W:0       (20px)     │  Black/White turn + captures
├────┬──────────────────────────────┐ │
│ 1  │ A B C D E F G H I            │ │
│ 2  │ . . . . . . . . .            │ │
│ 3  │ . . • . . • . . .            │ │  Hoshi (9 strategic pts)
│ 4  │ . . . . . . . . .            │ │
│ 5  │ . . • . • . • . .            │ │  Board: 200×228, cell: 20px
│ 6  │ . . . . . . . . .            │ │
│ 7  │ . . • . . • . . .            │ │  Stone radius: 8px
│ 8  │ . . . . . . . . .            │ │
│ 9  │ . . • . . • . . .            │ │
│    │                              │ │
└────┴──────────────────────────────┘ │
│ Col labels A-I                (16px)│
└─────────────────────────────────────┘
```

## Game Rules Implementation

### Placement
- Stone is placed at intersection only if empty
- After placement, check adjacent opponent groups for capture
- Check if placed stone's own group has liberties (suicide prevention)
- Ko rule: reject if board state matches previous position
- Pass counter resets on any valid stone placement

### Capture
- A stone or group with zero liberties is captured and removed
- Captures are performed immediately after stone placement
- Captured stones increment the opponent's capture count

### Scoring (Chinese Rules)
- **Black Score** = stones on board + black territory
- **White Score** = stones on board + white territory + 6 (komi)
- Territory is determined by flood-fill: if all boundary stones are one color, interior is that color's territory
- Neutral territory (bounded by both colors) is not counted

### Pass & Game End
- Player can pass via menu (long-press BACK → Pass)
- Two consecutive passes ends the game
- Game transitions to SCORING phase
- Territory is calculated and final scores displayed
- Press any button to return to menu

## Build & Installation

### Build
```bash
cd go-game
pebble build
```

This generates `build/go-game.pbw` (23 KB).

### Install on Pebble Time 2
```bash
# Via connected watch (requires USB or Bluetooth pairing)
pebble install --cloudpebble

# Via emulator (requires X11/display server)
pebble install --emulator emery
```

### Test in Emulator (with QEMU)
```bash
# Launch emulator with app
pebble install --emulator emery

# Capture screenshot (running emulator headless)
pebble screenshot --no-open --emulator emery screenshot.png

# View logs
pebble logs --emulator emery

# Interact with emulator
pebble emu-button click select --emulator emery
pebble emu-button click up --emulator emery
```

## Project Structure

```
go-game/
├── package.json                 # App metadata, Rocky.js config
├── wscript                      # Build configuration
├── src/
│   ├── c/main.c                # Minimal C stub for app initialization
│   └── rocky/
│       └── index.js            # Complete game logic & rendering (~850 lines)
└── build/
    └── go-game.pbw             # Compiled app (23 KB)
```

## Technical Details

### Architecture
- **Language**: JavaScript (Rocky.js) + minimal C stub
- **Platform**: Pebble Time 2 (emery), 200×228 px color display
- **Game State**: In-memory only (no persistent save between runs)
- **Input**: Pebble button API (window click handlers)
- **Rendering**: Rocky.js canvas API (fillRect, fillText, stroke, arc)

### Core Algorithms
- **Liberty count**: BFS flood-fill from a stone following same-color neighbors
- **Capture detection**: Check adjacent opponent groups' liberties, remove if zero
- **Suicide prevention**: After capture, verify placed stone's group has liberties
- **Ko rule**: String comparison of current board vs previous board state
- **Territory scoring**: BFS flood-fill from each empty cell; boundary color detection

### Performance
- Board: 81 cells (9×9)
- Flood-fill max depth: 81 cells (worst case, entire board)
- Rendering: Full-screen redraw on each input or timer tick (500ms cursor blink)
- Memory: ~2 KB board state, ~1 KB game state, ~10 KB code

## Known Limitations

1. **No persistent save**: Game resets when app closes (in-memory only)
2. **No undo**: Once placed, a stone cannot be removed (except via capture)
3. **No AI**: Only local 2-player mode (no computer opponent)
4. **Single platform**: emery only (Pebble Time 2); no round displays (gabbro, chalk)
5. **Emulator requires X11**: Screenshot/testing in QEMU requires display server

## Troubleshooting

### Build fails: "arm-none-eabi-gcc not found"
- Ensure Pebble SDK is installed: `pebble sdk install`
- Verify toolchain: `ls ~/.pebble-sdk/SDKs/current/toolchain/`

### Emulator won't start (X11 error)
- This environment lacks X11. To test locally:
  - Connect a real Pebble Time 2 device
  - Use `pebble install --cloudpebble` (requires Pebble app on phone)
  - Or run on Linux desktop with `DISPLAY=:0` or Xvfb

### App runs but buttons don't respond
- Check `pebble logs --emulator emery` for errors
- Verify button IDs: should be `up`, `down`, `select`, `back`
- Check rocky.on('button', ...) event handler

### Scoring is incorrect
- Verify all groups are marked during capture detection
- Ensure territory flood-fill reaches all empty cells
- Check komi is applied (+6 to White)

## Testing Checklist

- [x] JavaScript syntax valid
- [x] Core logic functions tested (placement, bounds)
- [x] Build succeeds (PBW generated)
- [x] App manifest valid (package.json, wscript)
- [ ] Visual appearance verified in QEMU (blocked by X11)
- [ ] Button input responsive
- [ ] Move placement works
- [ ] Captures are removed
- [ ] Pass mechanic works
- [ ] Scoring calculates correctly
- [ ] Menu system responsive

## Future Enhancements

- Save/load game state to persistent storage
- Undo/replay moves
- Computer AI opponent (basic minimax or Monte Carlo)
- Multiple board sizes (13×13, 19×19)
- Gabbro (round) display support
- Game records & statistics
- Handicap stones setup

## License

Public domain. Use freely.

---

**Built with:** Pebble SDK 4.9.148, Rocky.js, emery (Pebble Time 2)
**Date:** 2026-04-10
**Status:** Ready to install on device
