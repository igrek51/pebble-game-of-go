# Game of Go — Pebble App

## Requirements

### Platform
- Device: Pebble Time 2 (emery)
- Display: 200×228 px, rectangular, 64-color
- Language: **JavaScript (Rocky.js)** — runs on the watch itself

### Game Rules
- 9×9 board, Chinese rules
- 2 human players alternate turns (no AI)
- Black plays first
- Capture: a stone/group with no liberties is removed from the board
- Ko rule: cannot recreate the immediately previous board position
- Pass: a player may pass instead of placing a stone
- Two consecutive passes end the game
- **Scoring (Chinese rules):** stones on board + surrounded empty territory
- Komi: White gets +6 points to compensate for Black's first-move advantage

### UI
- Board grid with **row and column numbers** visible on screen
- Current player indicator (Black / White)
- Captured stone counts per player
- Cursor highlighting the currently selected intersection

### Input — Two-Step Selection
Button flow for placing a stone:
1. **Phase 1 — Row selection:** UP/DOWN moves cursor row; SELECT confirms row
2. **Phase 2 — Column selection:** UP/DOWN moves cursor column; SELECT places stone
3. BACK cancels current phase (returns from column → row selection, or row → idle)

Additional actions (e.g. long-press SELECT or dedicated sequence):
- **Pass** — player passes their turn
- **New game** — reset board

### Game States
| State | Description |
|---|---|
| `SELECTING_ROW` | Player moves cursor vertically; SELECT advances to column phase |
| `SELECTING_COL` | Player moves cursor horizontally; SELECT places stone |
| `SCORING` | Both players passed; territory is counted |
| `GAME_OVER` | Final score shown with winner |

## Key Design Conclusions

### Layout (200×228)
- Reserve ~20 px top for status bar (whose turn, captures)
- Reserve ~20 px left for row numbers (1–9)
- Reserve ~16 px bottom for column labels (A–I)
- Remaining board area: ~164×192 px → cell size ≈ 20 px (8×20 = 160 px board)
- Board origin: approximately x=28, y=22
- Stone radius: ~8 px

### Rocky.js Notes
- Use `Rocky.on('draw', ctx => { ... })` for all rendering
- Use `Rocky.on('button', ({ button, action }) => { ... })` for input
- Canvas API is a subset of HTML5 Canvas (arc, fillRect, strokeRect, fillText, etc.)
- No floating point issues in JS; use integer pixel math for clarity
- `Rocky.requestDraw()` to trigger a redraw after state change

### Go Logic Algorithms
- **Liberty check:** BFS/DFS from a stone following same-color neighbors; count empty neighbors
- **Capture:** after placing, check all adjacent opponent groups; remove any with 0 liberties; then check if placed stone's group has liberties (suicide check)
- **Ko:** store previous board state as string/array; reject move that recreates it
- **Territory scoring:** BFS flood-fill from each empty intersection; if all boundary stones are one color → that color's territory

### File Structure
```
go-game/
├── package.json        # Rocky.js app config, "rocky" platform
├── wscript
└── src/
    └── rocky/
        └── index.js    # all game logic + rendering
```

### package.json differences for Rocky.js
- `"targetPlatforms": ["emery"]`
- Rocky.js apps do NOT use `"watchapp"` section the same way as C apps
- JS entry point is `src/rocky/index.js`

## Developer references

* SDK Documentation: https://developer.repebble.com/docs/
* Alloy: https://developer.repebble.com/guides/alloy/
* Build a Watchface in JS (Alloy): https://developer.repebble.com/tutorials/alloy-watchface-tutorial/part1/
* Build a Watchface in JS (Alloy): https://developer.repebble.com/tutorials/alloy-watchface-tutorial/part2/
* User settings: https://developer.repebble.com/tutorials/alloy-watchface-tutorial/part6/
* Guides / Alloy / Storage: https://developer.repebble.com/guides/alloy/storage/
* Guides / Alloy / Poco Graphics: https://developer.repebble.com/guides/alloy/poco-guide/
* Guides / Alloy / Piu UI Framework: https://developer.repebble.com/guides/alloy/piu-guide/
* App resources: https://developer.repebble.com/guides/app-resources/
* Moddable SDK: https://www.moddable.com/documentation/readme
* Developer Examples: https://developer.repebble.com/examples/
