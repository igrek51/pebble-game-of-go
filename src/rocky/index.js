// Game of Go - 9x9 - Rocky.js for Pebble Time 2

// Constants
const BOARD_SIZE = 9;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

// Colors (Pebble 64-color palette)
const COLORS = {
  BOARD: '#F5DEB3',      // tan/wood
  GRID: '#2F4F4F',       // dark slate
  BLACK_STONE: '#000000',
  BLACK_OUTLINE: '#FFFFFF',
  WHITE_STONE: '#FFFFFF',
  WHITE_OUTLINE: '#000000',
  CURSOR: '#FF0000',     // red
  CURSOR_COL: '#FFD700', // gold
  STATUS_BG: '#1E90FF',  // dodger blue
  TEXT: '#FFFFFF',
  HOSHI: '#000000'       // hoshi (handicap) points
};

// Layout constants (emery: 200x228)
const LAYOUT = {
  ROW_LABEL_X: 2,
  ROW_LABEL_Y: 22,
  BOARD_ORIGIN_X: 28,
  BOARD_ORIGIN_Y: 22,
  CELL_SIZE: 20,
  STONE_RADIUS: 8,
  STATUS_BAR_HEIGHT: 20,
  COL_LABEL_Y: 212,
};

// Game state
let board = Array(BOARD_SIZE * BOARD_SIZE).fill(EMPTY);
let previousBoard = Array(BOARD_SIZE * BOARD_SIZE).fill(EMPTY);

let gameState = {
  currentPlayer: BLACK,
  passCount: 0,
  blackCaptures: 0,
  whiteCaptures: 0,
  gamePhase: 'PLAYING', // 'PLAYING' or 'SCORING'
  score: null,
};

// UI state
let uiState = {
  selectionPhase: 'SELECTING_ROW', // 'SELECTING_ROW', 'SELECTING_COL', 'MENU'
  selectedRow: 0,
  selectedCol: 0,
  menuOption: 0, // 0: Pass, 1: New Game, 2: Back (in menu)
  moveHistory: [], // for undo if needed
};

// Initialize
function init() {
  resetBoard();
}

function resetBoard() {
  board = Array(BOARD_SIZE * BOARD_SIZE).fill(EMPTY);
  previousBoard = Array(BOARD_SIZE * BOARD_SIZE).fill(EMPTY);
  gameState.currentPlayer = BLACK;
  gameState.passCount = 0;
  gameState.blackCaptures = 0;
  gameState.whiteCaptures = 0;
  gameState.gamePhase = 'PLAYING';
  gameState.score = null;
  uiState.selectionPhase = 'SELECTING_ROW';
  uiState.selectedRow = 0;
  uiState.selectedCol = 0;
  uiState.menuOption = 0;
  uiState.moveHistory = [];
}

// === Board Logic ===

function boardIndex(row, col) {
  return row * BOARD_SIZE + col;
}

function getStone(row, col) {
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
    return -1; // out of bounds
  }
  return board[boardIndex(row, col)];
}

function setStone(row, col, color) {
  board[boardIndex(row, col)] = color;
}

function boardsEqual(b1, b2) {
  for (let i = 0; i < b1.length; i++) {
    if (b1[i] !== b2[i]) return false;
  }
  return true;
}

function copyBoard(src) {
  return src.slice();
}

// Flood-fill to count liberties of a stone's group
function countLiberties(row, col, color) {
  const visited = new Set();
  let libertyCount = 0;

  function dfs(r, c) {
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return;

    const idx = boardIndex(r, c);
    if (visited.has(idx)) return;

    const cell = getStone(r, c);
    if (cell === EMPTY) {
      libertyCount++;
      return;
    }
    if (cell !== color) return;

    visited.add(idx);
    dfs(r - 1, c);
    dfs(r + 1, c);
    dfs(r, c - 1);
    dfs(r, c + 1);
  }

  dfs(row, col);
  return libertyCount;
}

// Recursively remove a group of stones
function removeGroup(row, col, color) {
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return;

  const idx = boardIndex(row, col);
  if (board[idx] !== color) return;

  board[idx] = EMPTY;
  if (color === BLACK) gameState.blackCaptures++;
  else gameState.whiteCaptures++;

  removeGroup(row - 1, col, color);
  removeGroup(row + 1, col, color);
  removeGroup(row, col - 1, color);
  removeGroup(row, col + 1, color);
}

// Check adjacent opponent groups for capture
function captureAdjacentGroups(row, col, placingPlayer) {
  const opponent = placingPlayer === BLACK ? WHITE : BLACK;
  const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  for (let [dr, dc] of directions) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE) {
      if (getStone(nr, nc) === opponent) {
        if (countLiberties(nr, nc, opponent) === 0) {
          removeGroup(nr, nc, opponent);
        }
      }
    }
  }
}

// Try to place a stone at (row, col)
function tryPlaceStone(row, col) {
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
    return false;
  }

  const idx = boardIndex(row, col);
  if (board[idx] !== EMPTY) {
    return false; // Occupied
  }

  // Save state for Ko detection
  previousBoard = copyBoard(board);

  // Place stone
  setStone(row, col, gameState.currentPlayer);

  // Check and capture adjacent opponent groups
  captureAdjacentGroups(row, col, gameState.currentPlayer);

  // Check suicide (illegal if own group has 0 liberties after captures)
  if (countLiberties(row, col, gameState.currentPlayer) === 0) {
    board = copyBoard(previousBoard);
    return false;
  }

  // Check Ko rule (board state same as before previous move)
  if (boardsEqual(board, previousBoard)) {
    board = copyBoard(previousBoard);
    return false;
  }

  // Move is legal
  gameState.passCount = 0;
  gameState.currentPlayer = gameState.currentPlayer === BLACK ? WHITE : BLACK;
  return true;
}

// Player passes
function playerPass() {
  gameState.passCount++;
  if (gameState.passCount >= 2) {
    // Both players passed, end game and start scoring
    gameState.gamePhase = 'SCORING';
    gameState.score = calculateScore();
  } else {
    // Switch player
    gameState.currentPlayer = gameState.currentPlayer === BLACK ? WHITE : BLACK;
  }
  uiState.selectionPhase = 'SELECTING_ROW';
  uiState.selectedRow = 0;
  uiState.selectedCol = 0;
}

// === Scoring (Chinese Rules) ===

function floodFillTerritory(startIdx, territory, visited) {
  if (visited.has(startIdx)) return null;

  const visited_group = new Set();
  let ownerColor = -1; // -1 = unknown/neutral

  function dfs(idx) {
    if (visited_group.has(idx)) return;
    visited_group.add(idx);

    const r = Math.floor(idx / BOARD_SIZE);
    const c = idx % BOARD_SIZE;

    if (board[idx] === EMPTY) {
      const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (let [dr, dc] of dirs) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE) {
          const nidx = boardIndex(nr, nc);
          if (board[nidx] !== EMPTY) {
            const color = board[nidx];
            if (ownerColor === -1) ownerColor = color;
            else if (ownerColor !== color) ownerColor = 2; // 2 = neutral/shared
          } else if (!visited_group.has(nidx)) {
            dfs(nidx);
          }
        }
      }
    }
  }

  dfs(startIdx);

  // Mark all visited cells
  for (let idx of visited_group) {
    visited.add(idx);
    if (ownerColor === -1 || ownerColor === 2) {
      territory[idx] = 2; // neutral
    } else {
      territory[idx] = ownerColor;
    }
  }

  return ownerColor;
}

function calculateScore() {
  const territory = Array(BOARD_SIZE * BOARD_SIZE).fill(-1);
  const visited = new Set();

  // Determine ownership of empty regions
  for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
    if (board[i] === EMPTY && !visited.has(i)) {
      floodFillTerritory(i, territory, visited);
    }
  }

  // Count stones on board
  let blackStones = 0;
  let whiteStones = 0;
  for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
    if (board[i] === BLACK) blackStones++;
    else if (board[i] === WHITE) whiteStones++;
  }

  // Count territory
  let blackTerritory = 0;
  let whiteTerritory = 0;
  for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
    if (territory[i] === BLACK) blackTerritory++;
    else if (territory[i] === WHITE) whiteTerritory++;
  }

  const komi = 6; // White gets 6 points
  const blackScore = blackStones + blackTerritory;
  const whiteScore = whiteStones + whiteTerritory + komi;

  return {
    blackStones,
    whiteStones,
    blackTerritory,
    whiteTerritory,
    blackScore,
    whiteScore,
    winner: blackScore > whiteScore ? 'Black' : (whiteScore > blackScore ? 'White' : 'Tie'),
    territory,
  };
}

// === Input Handling ===

function moveUp() {
  if (uiState.selectionPhase === 'SELECTING_ROW') {
    uiState.selectedRow = Math.max(0, uiState.selectedRow - 1);
  } else if (uiState.selectionPhase === 'SELECTING_COL') {
    uiState.selectedCol = Math.max(0, uiState.selectedCol - 1);
  } else if (uiState.selectionPhase === 'MENU') {
    uiState.menuOption = Math.max(0, uiState.menuOption - 1);
  }
  Rocky.requestDraw();
}

function moveDown() {
  if (uiState.selectionPhase === 'SELECTING_ROW') {
    uiState.selectedRow = Math.min(BOARD_SIZE - 1, uiState.selectedRow + 1);
  } else if (uiState.selectionPhase === 'SELECTING_COL') {
    uiState.selectedCol = Math.min(BOARD_SIZE - 1, uiState.selectedCol + 1);
  } else if (uiState.selectionPhase === 'MENU') {
    uiState.menuOption = Math.min(2, uiState.menuOption + 1);
  }
  Rocky.requestDraw();
}

function selectAction() {
  if (uiState.selectionPhase === 'SELECTING_ROW') {
    uiState.selectionPhase = 'SELECTING_COL';
  } else if (uiState.selectionPhase === 'SELECTING_COL') {
    // Try to place stone
    if (tryPlaceStone(uiState.selectedRow, uiState.selectedCol)) {
      uiState.selectionPhase = 'SELECTING_ROW';
      uiState.selectedRow = 0;
      uiState.selectedCol = 0;
    }
    // If illegal, stay in SELECTING_COL
  } else if (uiState.selectionPhase === 'MENU') {
    if (uiState.menuOption === 0) {
      // Pass
      playerPass();
      uiState.selectionPhase = 'SELECTING_ROW';
    } else if (uiState.menuOption === 1) {
      // New Game
      resetBoard();
      uiState.selectionPhase = 'SELECTING_ROW';
    } else if (uiState.menuOption === 2) {
      // Back to game
      uiState.selectionPhase = 'SELECTING_ROW';
    }
  }
  Rocky.requestDraw();
}

function backAction() {
  if (uiState.selectionPhase === 'SELECTING_COL') {
    uiState.selectionPhase = 'SELECTING_ROW';
  } else if (uiState.selectionPhase === 'SELECTING_ROW' && gameState.gamePhase === 'PLAYING') {
    // Can't go back from row selection; long press opens menu
  }
  Rocky.requestDraw();
}

function backLongPress() {
  if (uiState.selectionPhase === 'MENU') {
    // Already in menu, close it
    uiState.selectionPhase = 'SELECTING_ROW';
    uiState.menuOption = 0;
  } else {
    // Open menu
    uiState.selectionPhase = 'MENU';
    uiState.menuOption = 0;
  }
  Rocky.requestDraw();
}

// Unified button handler
let backPressTime = null;

Rocky.on('button', ({ button, action }) => {
  // Handle back button press/release for long-press detection
  if (button === 'back') {
    if (action === 'down') {
      backPressTime = Date.now();
    } else if (action === 'up') {
      const pressedFor = Date.now() - backPressTime;
      if (pressedFor >= 750) {
        backLongPress();
      } else {
        backAction();
      }
      backPressTime = null;
      Rocky.requestDraw();
    }
    return;
  }

  // Handle other buttons on release only
  if (action !== 'up') return;

  if (button === 'up') {
    moveUp();
  } else if (button === 'down') {
    moveDown();
  } else if (button === 'select') {
    selectAction();
  }
});

// === Rendering ===

function getPixelForCell(row, col) {
  const x = LAYOUT.BOARD_ORIGIN_X + col * LAYOUT.CELL_SIZE + LAYOUT.CELL_SIZE / 2;
  const y = LAYOUT.BOARD_ORIGIN_Y + row * LAYOUT.CELL_SIZE + LAYOUT.CELL_SIZE / 2;
  return { x, y };
}

function drawStatusBar(ctx) {
  ctx.fillStyle = COLORS.STATUS_BG;
  ctx.fillRect(0, 0, 200, LAYOUT.STATUS_BAR_HEIGHT);

  const currentPlayerColor = gameState.currentPlayer === BLACK ? '●' : '○';
  const statusText = currentPlayerColor + ' B:' + gameState.blackCaptures + ' W:' + gameState.whiteCaptures;

  ctx.fillStyle = COLORS.TEXT;
  ctx.font = 'bold 14px';
  ctx.textAlign = 'center';
  ctx.fillText(statusText, 100, 16);
}

function drawBoard(ctx) {
  // Draw grid
  ctx.strokeStyle = COLORS.GRID;
  ctx.lineWidth = 1;

  // Horizontal lines
  for (let row = 0; row < BOARD_SIZE; row++) {
    const y = LAYOUT.BOARD_ORIGIN_Y + row * LAYOUT.CELL_SIZE;
    ctx.beginPath();
    ctx.moveTo(LAYOUT.BOARD_ORIGIN_X, y);
    ctx.lineTo(LAYOUT.BOARD_ORIGIN_X + (BOARD_SIZE - 1) * LAYOUT.CELL_SIZE, y);
    ctx.stroke();
  }

  // Vertical lines
  for (let col = 0; col < BOARD_SIZE; col++) {
    const x = LAYOUT.BOARD_ORIGIN_X + col * LAYOUT.CELL_SIZE;
    ctx.beginPath();
    ctx.moveTo(x, LAYOUT.BOARD_ORIGIN_Y);
    ctx.lineTo(x, LAYOUT.BOARD_ORIGIN_Y + (BOARD_SIZE - 1) * LAYOUT.CELL_SIZE);
    ctx.stroke();
  }

  // Draw hoshi (handicap) points at strategic positions (3x3, 3x6, 3x9, etc.)
  const hoshiPositions = [
    [2, 2], [2, 6], [6, 2], [6, 6],
    [2, 4], [4, 2], [4, 4], [4, 6], [6, 4]
  ];

  ctx.fillStyle = COLORS.HOSHI;
  for (let [r, c] of hoshiPositions) {
    const pos = getPixelForCell(r, c);
    ctx.fillRect(pos.x - 1, pos.y - 1, 2, 2);
  }

  // Draw row labels (1-9)
  ctx.fillStyle = COLORS.GRID;
  ctx.font = 'bold 11px';
  ctx.textAlign = 'right';
  for (let row = 0; row < BOARD_SIZE; row++) {
    const y = LAYOUT.BOARD_ORIGIN_Y + row * LAYOUT.CELL_SIZE;
    ctx.fillText((row + 1).toString(), LAYOUT.ROW_LABEL_X + 16, y + 5);
  }

  // Draw column labels (A-I)
  ctx.font = 'bold 11px';
  ctx.textAlign = 'center';
  const colLabels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
  for (let col = 0; col < BOARD_SIZE; col++) {
    const x = LAYOUT.BOARD_ORIGIN_X + col * LAYOUT.CELL_SIZE;
    ctx.fillText(colLabels[col], x, LAYOUT.COL_LABEL_Y + 14);
  }
}

function drawStones(ctx) {
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const stone = getStone(row, col);
      if (stone === EMPTY) continue;

      const pos = getPixelForCell(row, col);

      if (stone === BLACK) {
        ctx.fillStyle = COLORS.BLACK_STONE;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, LAYOUT.STONE_RADIUS, 0, 2 * Math.PI);
        ctx.fill();

        // White outline
        ctx.strokeStyle = COLORS.BLACK_OUTLINE;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (stone === WHITE) {
        ctx.fillStyle = COLORS.WHITE_STONE;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, LAYOUT.STONE_RADIUS, 0, 2 * Math.PI);
        ctx.fill();

        // Black outline
        ctx.strokeStyle = COLORS.WHITE_OUTLINE;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }
}

function drawCursor(ctx) {
  if (uiState.selectionPhase === 'SELECTING_ROW') {
    // Draw cursor on selected row
    const row = uiState.selectedRow;
    const pos = getPixelForCell(row, BOARD_SIZE / 2);

    ctx.strokeStyle = COLORS.CURSOR;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, LAYOUT.STONE_RADIUS + 4, 0, 2 * Math.PI);
    ctx.stroke();

    // Draw row number highlight
    ctx.fillStyle = COLORS.CURSOR;
    ctx.font = 'bold 11px';
    ctx.textAlign = 'right';
    ctx.fillText((row + 1).toString(), LAYOUT.ROW_LABEL_X + 16, LAYOUT.BOARD_ORIGIN_Y + row * LAYOUT.CELL_SIZE + 5);
  } else if (uiState.selectionPhase === 'SELECTING_COL') {
    // Draw cursor on selected column
    const col = uiState.selectedCol;
    const pos = getPixelForCell(BOARD_SIZE / 2, col);

    ctx.strokeStyle = COLORS.CURSOR_COL;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, LAYOUT.STONE_RADIUS + 4, 0, 2 * Math.PI);
    ctx.stroke();

    // Draw column label highlight
    const colLabels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
    ctx.fillStyle = COLORS.CURSOR_COL;
    ctx.font = 'bold 11px';
    ctx.textAlign = 'center';
    ctx.fillText(colLabels[col], LAYOUT.BOARD_ORIGIN_X + col * LAYOUT.CELL_SIZE, LAYOUT.COL_LABEL_Y + 14);
  }
}

function drawScoringOverlay(ctx) {
  if (!gameState.score) return;

  // Semi-transparent overlay
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(0, 0, 200, 228);

  // Score box
  ctx.fillStyle = COLORS.STATUS_BG;
  ctx.fillRect(20, 60, 160, 100);

  ctx.fillStyle = COLORS.TEXT;
  ctx.font = 'bold 16px';
  ctx.textAlign = 'center';
  ctx.fillText('GAME OVER', 100, 80);

  ctx.font = '12px';
  ctx.fillText('Black: ' + gameState.score.blackScore, 100, 100);
  ctx.fillText('White: ' + gameState.score.whiteScore, 100, 115);
  ctx.fillText('Winner: ' + gameState.score.winner, 100, 135);

  ctx.font = '11px';
  ctx.fillText('Press BACK', 100, 155);
}

function drawMenu(ctx) {
  // Semi-transparent overlay
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(0, 0, 200, 228);

  // Menu box
  ctx.fillStyle = COLORS.STATUS_BG;
  ctx.fillRect(30, 50, 140, 120);

  ctx.fillStyle = COLORS.TEXT;
  ctx.font = 'bold 14px';
  ctx.textAlign = 'center';
  ctx.fillText('MENU', 100, 70);

  // Menu options
  const options = ['Pass', 'New Game', 'Resume'];
  for (let i = 0; i < options.length; i++) {
    const y = 90 + i * 25;
    if (i === uiState.menuOption) {
      ctx.fillStyle = COLORS.CURSOR;
      ctx.fillRect(35, y - 10, 130, 18);
      ctx.fillStyle = COLORS.STATUS_BG;
    } else {
      ctx.fillStyle = COLORS.TEXT;
    }
    ctx.font = 'bold 12px';
    ctx.textAlign = 'center';
    ctx.fillText(options[i], 100, y + 3);
  }
}

// Main draw function
Rocky.on('draw', (ctx) => {
  // Clear screen
  ctx.fillStyle = COLORS.BOARD;
  ctx.fillRect(0, 0, 200, 228);

  // Draw game elements
  drawStatusBar(ctx);
  drawBoard(ctx);
  drawStones(ctx);

  if (uiState.selectionPhase === 'MENU') {
    drawMenu(ctx);
  } else {
    drawCursor(ctx);
  }

  if (gameState.gamePhase === 'SCORING') {
    drawScoringOverlay(ctx);
  }
});

// Initialize game
init();

// Initial draw request
Rocky.requestDraw();
