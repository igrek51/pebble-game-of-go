var BOARD_SIZE = 9;
var EMPTY = 0, BLACK = 1, WHITE = 2;

var MCTS_PASS_ROW = 9;
var MCTS_PASS_COL = 9;
var MCTS_POOL_SIZE = 10000;
var MCTS_NO_NODE = -1;
var MCTS_ITERATIONS = 1000;
var MCTS_MAX_PLAYOUT = 120;
// Passing is strictly prohibited before this many moves have been made
// (passes possible starting with the 41st move). Mirrored in main.c
// (AI_PASS_MIN_MOVES); when the search wants to pass earlier, or finds no
// move at all, an error reply (isPass 2) is sent so the watch reports it
// instead of silently passing.
var PKJS_PASS_MIN_MOVES = 40;// Wall-clock budget for one AI move. The watch falls back to its local AI
// after COMM_TIMEOUT_MS (72000ms), so the reply must leave well before that,
// including AppMessage transport time. Phone JS engines are much slower than
// desktop V8 (300 iterations measured ~1.7s on V8), so mctsRun() stops early
// once this budget is exceeded instead of running all iterations.
var MCTS_TIME_BUDGET_MS = 60000;

var nodePool = [];
var nodePoolUsed = 0;
var rootNode = MCTS_NO_NODE;

var simBoard = [];
var simKoBoard = [];
var simKoActive = false;
var simPlayer = EMPTY;
var simLastRow = -1;
var simLastCol = -1;
var simPasses = 0;

var playBoard = [];
var playKoBoard = [];
var playKoActive = false;
var playPlayer = EMPTY;
var playLastRow = -1;
var playLastCol = -1;
var playPasses = 0;

var mctsPath = [];
var mctsPathLen = 0;

var simTempBoard = [];
var probeBoard = [];  // scratch for tactical simulations (capture/eye/self-atari tests)
var probeKo = [];
var gBoard = [];
var gKoBoard = [];
var gKoActive = false;

var rngState = 12345;

// Request counter: seeds each search differently (deterministic per boot)
// so that a manual retry after an error explores different lines instead
// of reproducing the identical result forever. Unit tests reload the module
// per case, so every test still starts from the same seed.
var requestSeq = 0;

// Shared DFS mark buffer with generation counter: the hottest functions
// (liberty counting, group removal) run millions of times per request, so
// they must not allocate a visited array per call. Calls are strictly
// sequential (no reentrancy), one buffer suffices. Monotonic, never reset.
var dfsSeen = [];
var dfsGen = 0;
for (var _di = 0; _di < BOARD_SIZE * BOARD_SIZE; _di++)
    dfsSeen[_di] = 0;

// RAVE/AMAF: global all-moves-as-first statistics. amafV[color][idx] counts
// playouts where `color` played idx; amafW counts those the mover eventually
// won. Shared across the whole tree, so even a few hundred iterations rank
// moves sensibly. Blend weight beta = K/(K+visits) fades toward pure UCT.
var AMAF_K = 500;
var amafV = [[], [], []];
var amafW = [[], [], []];

// Pass prior depends on board fullness: in near-finished positions (few
// empties) pass competes normally at 0.5; in open positions it is crippled
// to PASS_OPEN_PRIOR, because playout noise otherwise lets it outrank
// struggling stone moves and produce unjustified early passes. Set per
// request in mctsRun().
var PASS_OPEN_PRIOR = 0.05;
var ENDGAME_EMPTIES = 12;
var passPrior = 0.5;

// Cost gates (out of 10) for the expensive simulation-based checks.
// Was Pachi-style probabilistic (1 and 3); now always-on: tactics and
// self-atari/eye penalties run on every step. Phone JS still fits the
// 60s budget at 1000 iterations, and skipping them is what produced
// immediately-dead moves.
var TIER3_PROB10 = 10;
var TACT_PEN_PROB10 = 10;

// Move history of the current iteration (tree + playout applied stones),
// used to update AMAF once the playout outcome is known.
var playHistR = [];
var playHistC = [];
var playHistP = [];
var playHistN = 0;

var UCT_EXPLORE_TABLE = [
    0,   0,   117, 140, 155, 166, 175, 182, 189, 195, 201, 205, 210, 214, 218,
    222, 225, 228, 232, 235, 237, 240, 243, 245, 248, 250, 252, 255, 257, 259,
    261, 263, 265, 267, 269, 271, 272, 274, 276, 277, 279, 281, 282, 284, 285,
    287, 288, 290, 291, 292, 294, 295, 296, 298, 299, 300, 301, 303, 304, 305,
    306, 307, 308, 309, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321,
    322, 323, 324, 325, 326, 327, 328, 329, 330, 330, 331, 332, 333, 334, 335,
    336, 336, 337, 338, 339, 340, 340, 341, 342, 343, 344, 345, 346, 347, 347,
    348, 349, 350, 351, 351, 352, 353, 354, 354, 355, 356, 357, 357, 358, 359,
    360, 360, 361, 362, 363, 363, 364, 365, 365, 366, 367, 367, 368, 369, 369,
    370, 371, 372, 372, 373, 374, 374, 375, 376, 376, 377, 378, 378, 379, 379,
    380, 381, 381, 382, 383, 383, 384, 385, 385, 386, 387, 387, 388, 388, 389,
    390, 390, 391, 391, 392, 393, 393, 394, 394, 395, 396, 396, 397, 397, 398,
    399, 399, 400, 400, 401, 401, 402, 403, 403, 404, 404, 405, 405, 406, 407,
    407, 408, 408, 409, 409, 410
];

function boardIndex(row, col) {
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE)
        return -1;
    return row * BOARD_SIZE + col;
}

function mctsRng() {
    rngState = (rngState * 1664525 + 1013904223) | 0;
    return rngState >>> 0;
}

function initPools() {
    nodePool = [];
    nodePoolUsed = 0;
    rootNode = MCTS_NO_NODE;
    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (simBoard.length <= i) {
            simBoard[i] = 0;
            simKoBoard[i] = 0;
            playBoard[i] = 0;
            playKoBoard[i] = 0;
            simTempBoard[i] = 0;
            probeBoard[i] = 0;
            probeKo[i] = 0;
        } else {
            simBoard[i] = 0;
            simKoBoard[i] = 0;
            playBoard[i] = 0;
            playKoBoard[i] = 0;
            simTempBoard[i] = 0;
            probeBoard[i] = 0;
            probeKo[i] = 0;
        }
        amafV[BLACK][i] = 0;
        amafW[BLACK][i] = 0;
        amafV[WHITE][i] = 0;
        amafW[WHITE][i] = 0;
    }
    playHistN = 0;
    simKoActive = false;
    playKoActive = false;
}

function recordHistMove(r, c, p) {
    if (r === MCTS_PASS_ROW || playHistN >= 128)
        return;
    playHistR[playHistN] = r;
    playHistC[playHistN] = c;
    playHistP[playHistN] = p;
    playHistN++;
}

function updateAmaf(blackWon) {
    for (var i = 0; i < playHistN; i++) {
        var p = playHistP[i];
        var idx = playHistR[i] * BOARD_SIZE + playHistC[i];
        amafV[p][idx]++;
        if ((p === BLACK) === (blackWon === 1))
            amafW[p][idx]++;
    }
}

function allocNode(moveRow, moveCol, player) {
    if (nodePoolUsed >= MCTS_POOL_SIZE)
        return MCTS_NO_NODE;
    var idx = nodePoolUsed;
    nodePoolUsed++;
    nodePool[idx] = {
        visits: 0,
        wins: 0,
        firstChild: MCTS_NO_NODE,
        nextSibling: MCTS_NO_NODE,
        moveRow: moveRow,
        moveCol: moveCol,
        player: player
    };
    return idx;
}

// Static shape knowledge for move selection: 1st-line moves are almost
// never good (no room for eyes), 2nd line is weak, 3rd line and inside is
// where opening and fighting belongs. Pass is neutral.
//
// Magnitudes are deliberately huge: 300 iterations spread over ~80 root
// children means ~4 visits each, so the winrate is pure lottery (0..1000)
// and the explore term is near-identical for all siblings. Only a prior far
// above that noise steers the opening; divided by visits it still fades
// (e.g. -6000 is -1500 at 4 visits but -60 at 100) so real statistics and
// tactics take over in fought variations.
function shapeScore(r, c) {
    if (r === MCTS_PASS_ROW)
        return 0;
    var firstLine = (r === 0 || r === 8 || c === 0 || c === 8);
    var secondLine = (r === 1 || r === 7 || c === 1 || c === 7);
    if (firstLine)
        return -6000;
    if (secondLine)
        return -2000;
    if (r >= 2 && r <= 6 && c >= 2 && c <= 6)
        return 1200;
    return 0;
}

function uct(childIdx, parentVisits) {
    if (childIdx === MCTS_NO_NODE)
        return -999999;
    var node = nodePool[childIdx];
    if (node.visits === 0)
        return 999999;
    if (parentVisits === 0)
        return 999999;

    var exploit = Math.floor((node.wins * 1000) / node.visits);

    var numerator = 0;
    if (parentVisits < 200) {
        numerator = UCT_EXPLORE_TABLE[parentVisits] * 10;
    } else {
        numerator = 4100;
    }

    var v = node.visits;
    var rootN = 1;
    if (v >= 4) rootN = 2;
    if (v >= 9) rootN = 3;
    if (v >= 16) rootN = 4;
    if (v >= 25) rootN = 5;
    if (v >= 36) rootN = 6;
    if (v >= 49) rootN = 7;
    if (v >= 64) rootN = 8;
    if (v >= 81) rootN = 9;
    if (v >= 100) rootN = 10;
    if (v >= 121) rootN = 11;
    if (v >= 144) rootN = 12;
    if (v >= 169) rootN = 13;
    if (v >= 196) rootN = 14;

    var value = exploit + Math.floor(numerator / rootN);

    // RAVE/AMAF blend with heuristic (shape) initialization, MoGo-style.
    // Every move starts with PRIOR_W pseudo-observations at priorRate, so
    // selection is guided before any playout data exists; real AMAF data
    // dilutes the prior, and beta fades the whole blend toward pure UCT
    // with visits. Pass uses the neutral 0.5 prior. This keeps all children
    // (including pass) on one comparable scale.
    var AMAF_PRIOR_W = 20;
    var pr = passPrior;
    if (node.moveRow !== MCTS_PASS_ROW) {
        pr = 0.5 + shapeScore(node.moveRow, node.moveCol) / 2000;
        if (pr < 0)
            pr = 0;
        if (pr > 1)
            pr = 1;
    }
    var arNum = AMAF_PRIOR_W * pr;
    var arDen = AMAF_PRIOR_W;
    if (node.moveRow !== MCTS_PASS_ROW && node.player !== EMPTY) {
        var ridx = node.moveRow * BOARD_SIZE + node.moveCol;
        arNum += amafW[node.player][ridx];
        arDen += amafV[node.player][ridx];
    }
    var beta = AMAF_K / (AMAF_K + v);
    value = Math.floor((1 - beta) * value + beta * (arNum / arDen) * 1000);

    return value;
}

function copyBoard(dst, src) {
    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
        dst[i] = src[i];
}

function countLibertiesOn(b, startRow, startCol, color) {
    dfsGen++;
    var mark = dfsGen;

    var liberties = 0;
    var stack = [];
    var startIdx = boardIndex(startRow, startCol);
    if (startIdx < 0 || b[startIdx] !== color)
        return 0;

    stack.push({r: startRow, c: startCol});
    dfsSeen[startIdx] = mark;

    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];

    while (stack.length > 0) {
        var cell = stack.pop();
        for (var d = 0; d < 4; d++) {
            var nr = cell.r + dr[d];
            var nc = cell.c + dc[d];
            var nidx = boardIndex(nr, nc);
            if (nidx < 0 || dfsSeen[nidx] === mark)
                continue;
            var ns = b[nidx];
            if (ns === EMPTY) {
                liberties++;
                dfsSeen[nidx] = mark;
            } else if (ns === color) {
                dfsSeen[nidx] = mark;
                stack.push({r: nr, c: nc});
            }
        }
    }
    return liberties;
}

function removeGroupOn(b, startRow, startCol, color) {
    dfsGen++;
    var mark = dfsGen;

    var stack = [];
    var startIdx = boardIndex(startRow, startCol);
    if (startIdx < 0 || b[startIdx] !== color)
        return;

    stack.push({r: startRow, c: startCol});
    dfsSeen[startIdx] = mark;

    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];

    while (stack.length > 0) {
        var cell = stack.pop();
        var idx = boardIndex(cell.r, cell.c);
        if (idx >= 0)
            b[idx] = EMPTY;

        for (var d = 0; d < 4; d++) {
            var nr = cell.r + dr[d];
            var nc = cell.c + dc[d];
            var nidx = boardIndex(nr, nc);
            if (nidx < 0 || dfsSeen[nidx] === mark)
                continue;
            if (b[nidx] === color) {
                dfsSeen[nidx] = mark;
                stack.push({r: nr, c: nc});
            }
        }
    }
}

function findLiberty(b, r, c) {
    var color = b[boardIndex(r, c)];
    dfsGen++;
    var mark = dfsGen;

    var stack = [{r: r, c: c}];
    dfsSeen[boardIndex(r, c)] = mark;

    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];

    while (stack.length > 0) {
        var cell = stack.pop();
        for (var d = 0; d < 4; d++) {
            var nr = cell.r + dr[d], nc = cell.c + dc[d];
            var nidx = boardIndex(nr, nc);
            if (nidx < 0 || dfsSeen[nidx] === mark)
                continue;
            if (b[nidx] === EMPTY) {
                return {r: nr, c: nc};
            } else if (b[nidx] === color) {
                dfsSeen[nidx] = mark;
                stack.push({r: nr, c: nc});
            }
        }
    }
    return {r: -1, c: -1};
}

function getLegalMovesOn(b, koB, koActive, player, fast) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    var moves = [];
    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];

    for (var row = 0; row < BOARD_SIZE; row++) {
        for (var col = 0; col < BOARD_SIZE; col++) {
            var idx = boardIndex(row, col);
            if (b[idx] !== EMPTY)
                continue;

            // Fast mode (playouts only): occupied-check only; suicide/ko
            // fallout is filtered by the retry loop on the selected move.
            // Exact mode (tree/root): full legality simulation.
            if (fast) {
                moves.push({r: row, c: col});
                continue;
            }

            b[idx] = player;

            var legal = true;
            var anyCaptured = false;

            for (var d = 0; d < 4; d++) {
                var nr = row + dr[d], nc = col + dc[d];
                var nidx = boardIndex(nr, nc);
                if (nidx >= 0 && b[nidx] === opp) {
                    if (countLibertiesOn(b, nr, nc, opp) === 0) {
                        anyCaptured = true;
                    }
                }
            }

            if (!anyCaptured && countLibertiesOn(b, row, col, player) === 0) {
                legal = false;
            }

            b[idx] = EMPTY;

            if (legal) {
                moves.push({r: row, c: col});
            }
        }
    }

    moves.push({r: MCTS_PASS_ROW, c: MCTS_PASS_COL});

    for (var i = moves.length - 1; i > 0; i--) {
        var j = Math.floor((mctsRng() / 65536) % (i + 1));
        var tmp = moves[i];
        moves[i] = moves[j];
        moves[j] = tmp;
    }

    return moves;
}

function simTryPlace(b, koB, koActiveFlag, player, row, col) {
    if (row === MCTS_PASS_ROW && col === MCTS_PASS_COL)
        return {success: true, koActive: koActiveFlag};

    var idx = boardIndex(row, col);
    if (idx < 0 || b[idx] !== EMPTY)
        return {success: false, koActive: koActiveFlag};

    var opponent = (player === BLACK) ? WHITE : BLACK;

    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
        simTempBoard[i] = b[i];

    b[idx] = player;

    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];
    var anyCaptured = false;

    for (var d = 0; d < 4; d++) {
        var nr = row + dr[d];
        var nc = col + dc[d];
        var nidx = boardIndex(nr, nc);
        if (nidx < 0)
            continue;
        if (b[nidx] === opponent &&
            countLibertiesOn(b, nr, nc, opponent) === 0) {
            removeGroupOn(b, nr, nc, opponent);
            anyCaptured = true;
        }
    }

    if (countLibertiesOn(b, row, col, player) === 0) {
        for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
            b[i] = simTempBoard[i];
        return {success: false, koActive: koActiveFlag};
    }

    if (koActiveFlag) {
        var equal = true;
        for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
            if (b[i] !== koB[i]) {
                equal = false;
                break;
            }
        }
        if (equal) {
            for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
                b[i] = simTempBoard[i];
            return {success: false, koActive: koActiveFlag};
        }
    }

    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
        koB[i] = simTempBoard[i];
    koActiveFlag = anyCaptured;

    return {success: true, koActive: koActiveFlag};
}

function scoreBoard(b) {
    var visited = [];
    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
        visited[i] = false;

    var bTerritory = 0, wTerritory = 0;
    var bStones = 0, wStones = 0;

    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (b[i] === BLACK) bStones++;
        else if (b[i] === WHITE) wStones++;
    }

    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];

    for (var sr = 0; sr < BOARD_SIZE; sr++) {
        for (var sc = 0; sc < BOARD_SIZE; sc++) {
            var sidx = boardIndex(sr, sc);
            if (b[sidx] !== EMPTY || visited[sidx])
                continue;

            var queue = [{r: sr, c: sc}];
            var head = 0;
            visited[sidx] = true;

            var regionSize = 0;
            var touchesBlack = false;
            var touchesWhite = false;

            while (head < queue.length) {
                var cell = queue[head];
                head++;
                regionSize++;

                for (var d = 0; d < 4; d++) {
                    var nr = cell.r + dr[d], nc = cell.c + dc[d];
                    var nidx = boardIndex(nr, nc);
                    if (nidx < 0)
                        continue;
                    var ns = b[nidx];
                    if (ns === BLACK) {
                        touchesBlack = true;
                    } else if (ns === WHITE) {
                        touchesWhite = true;
                    } else if (!visited[nidx]) {
                        visited[nidx] = true;
                        queue.push({r: nr, c: nc});
                    }
                }
            }

            if (touchesBlack && !touchesWhite) {
                bTerritory += regionSize;
            } else if (touchesWhite && !touchesBlack) {
                wTerritory += regionSize;
            }
        }
    }

    var blackTotal = bStones + bTerritory;
    var whiteTotal = wStones + wTerritory + 7;
    return blackTotal - whiteTotal;
}

// ---- shared tactics (tree expansion + playouts) ----

function findMoveIndex(moves, r, c) {
    for (var m = 0; m < moves.length; m++) {
        if (moves[m].r === r && moves[m].c === c)
            return m;
    }
    return -1;
}

// Does the move fill one of our own single-point eyes? Filling finished
// eyes corrupts Tromp-Taylor playout scoring, so playouts avoid it (no
// capture exception: eye-captures are vanishingly rare). Edge points never
// count (they are territory plays, not eye fills). Simulation-free.
function fillsOwnEye(b, r, c, player) {
    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];
    for (var d = 0; d < 4; d++) {
        var nidx = boardIndex(r + dr[d], c + dc[d]);
        if (nidx < 0)
            return false;
        if (b[nidx] !== player)
            return false;
    }
    return true;
}

// Does the move leave our own new group in atari without capturing?
function putsSelfInAtari(b, koB, koActiveFlag, player, r, c) {
    copyBoard(probeBoard, b);
    copyBoard(probeKo, koB);
    var res = simTryPlace(probeBoard, probeKo, koActiveFlag, player, r, c);
    if (!res.success)
        return false;
    var opp = (player === BLACK) ? WHITE : BLACK;
    var before = 0, after = 0;
    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (b[i] === opp)
            before++;
        if (probeBoard[i] === opp)
            after++;
    }
    if (after < before)
        return false;
    return countLibertiesOn(probeBoard, r, c, player) === 1;
}

// Collect distinct empty liberties of the `color` group containing (sr,sc)
// into `out` (local flood, bounded). Returns the count.
function groupLiberties(b, sr, sc, color, out) {
    dfsGen++;
    var mark = dfsGen;
    var stackR = [sr], stackC = [sc], top = 1;
    dfsSeen[boardIndex(sr, sc)] = mark;
    var n = 0;
    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];
    while (top > 0) {
        top--;
        var r = stackR[top], c = stackC[top];
        for (var d = 0; d < 4; d++) {
            var nr = r + dr[d], nc = c + dc[d];
            var nidx = boardIndex(nr, nc);
            if (nidx < 0 || dfsSeen[nidx] === mark)
                continue;
            if (b[nidx] === EMPTY) {
                dfsSeen[nidx] = mark;
                out[n] = {r: nr, c: nc};
                n++;
            } else if (b[nidx] === color) {
                dfsSeen[nidx] = mark;
                stackR[top] = nr;
                stackC[top] = nc;
                top++;
            }
        }
    }
    return n;
}

// Snapback guard for the forced-capture shortcut: simulate the kill, then
// see if the opponent immediately recaptures at our sole liberty for at
// least as many stones as we took. If so this is a throw-in trap, not a
// free capture — return true (unsafe, let search decide).
function isUnsafeCapture(b, koB, koActive, player, r, c) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    copyBoard(probeBoard, b);
    copyBoard(probeKo, koB);
    var res = simTryPlace(probeBoard, probeKo, koActive, player, r, c);
    if (!res.success)
        return true;
    var before = 0, after = 0, i;
    for (i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (b[i] === opp)
            before++;
        if (probeBoard[i] === opp)
            after++;
    }
    var gained = before - after;
    if (gained <= 0)
        return true;
    if (countLibertiesOn(probeBoard, r, c, player) > 1)
        return false;
    var lib = findLiberty(probeBoard, r, c);
    if (lib.r < 0)
        return true;
    // Opponent recapture test (playBoard is idle at root-decision time).
    copyBoard(playBoard, probeBoard);
    copyBoard(playKoBoard, probeKo);
    var ores = simTryPlace(playBoard, playKoBoard, res.koActive, opp,
                           lib.r, lib.c);
    if (!ores.success)
        return false;
    var ourBefore = 0, ourAfter = 0;
    for (i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (probeBoard[i] === player)
            ourBefore++;
        if (playBoard[i] === player)
            ourAfter++;
    }
    return (ourBefore - ourAfter) >= gained;
}

// Tier-1 scan factored out: index into `moves` of a killing reply to a
// 1-lib enemy group, or -1. Used by the shared tactical finder and by the
// root forced-capture override.
function findAtariKill(b, player, moves) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    for (var r = 0; r < BOARD_SIZE; r++) {
        for (var c = 0; c < BOARD_SIZE; c++) {
            var idx = boardIndex(r, c);
            if (b[idx] === opp && countLibertiesOn(b, r, c, opp) === 1) {
                var lib = findLiberty(b, r, c);
                if (lib.r >= 0) {
                    var m = findMoveIndex(moves, lib.r, lib.c);
                    if (m >= 0)
                        return m;
                }
            }
        }
    }
    return -1;
}

// Tiered tactical move choice shared by expansion and playouts.
// Tiers: (1) kill a 1-lib enemy group, (2) escape our 1-lib group,
// (3) local 2-lib attack/defense around the last move (gated by probability
// for speed). Returns the index into `moves`, or -1.
function findTacticalMove(b, koB, koActive, player, moves, lastR, lastC) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    var r, c, m;
    // Tier 1: immediate atari kill, but never a suicide throw-in: the
    // killing point itself must not end in atari (snapback/eye-steal).
    // Capturing kills that live on are still returned.
    m = findAtariKill(b, player, moves);
    if (m >= 0) {
        copyBoard(probeBoard, b);
        copyBoard(probeKo, koB);
        var ktest = simTryPlace(probeBoard, probeKo, koActive, player,
                                moves[m].r, moves[m].c);
        if (ktest.success &&
            countLibertiesOn(probeBoard, moves[m].r, moves[m].c, player) > 1)
            return m;
        // Suspicious kill (ends in atari): fall through to Tier 2/3 and
        // the scored fallback instead of forcing it.
    }
    // Tier 2: escape our 1-lib group, skipping escapes that stay in
    // atari without capturing (ladder-following, snapback-feeding).
    for (r = 0; r < BOARD_SIZE; r++) {
        for (c = 0; c < BOARD_SIZE; c++) {
            var idx = boardIndex(r, c);
            if (b[idx] === player && countLibertiesOn(b, r, c, player) === 1) {
                var lib = findLiberty(b, r, c);
                if (lib.r >= 0) {
                    m = findMoveIndex(moves, lib.r, lib.c);
                    if (m >= 0 &&
                        !putsSelfInAtari(b, koB, koActive, player,
                                         moves[m].r, moves[m].c))
                        return m;
                }
            }
        }
    }
    // Tier 3: local 2-lib tactics around the last move (bounded window,
    // probabilistic for speed — Pachi-style).
    if ((mctsRng() % 10) < TIER3_PROB10) {
        var libs = [];
        var dr2 = [-1, 1, 0, 0];
        var dc2 = [0, 0, -1, 1];
        for (var wr = lastR - 2; wr <= lastR + 2; wr++) {
            for (var wc = lastC - 2; wc <= lastC + 2; wc++) {
                var widx = boardIndex(wr, wc);
                if (widx < 0)
                    continue;
                var col = b[widx];
                if (col !== player && col !== opp)
                    continue;
                if (countLibertiesOn(b, wr, wc, col) !== 2)
                    continue;
                var nlib = groupLiberties(b, wr, wc, col, libs);
                for (var li = 0; li < nlib; li++) {
                    m = findMoveIndex(moves, libs[li].r, libs[li].c);
                    if (m < 0)
                        continue;
                    if (col === opp) {
                        // Attack: enemy ends in atari (or captured) and we live.
                        copyBoard(probeBoard, b);
                        copyBoard(probeKo, koB);
                        var res = simTryPlace(probeBoard, probeKo, koActive,
                                              player, libs[li].r, libs[li].c);
                        if (!res.success)
                            continue;
                        var captured = true;
                        var inAtari = false;
                        for (var d = 0; d < 4; d++) {
                            var ni = boardIndex(libs[li].r + dr2[d],
                                                libs[li].c + dc2[d]);
                            if (ni < 0)
                                continue;
                            if (b[ni] === opp && probeBoard[ni] === opp) {
                                captured = false;
                                var nr = libs[li].r + dr2[d];
                                var nc = libs[li].c + dc2[d];
                                if (countLibertiesOn(probeBoard, nr, nc, opp) === 1)
                                    inAtari = true;
                            }
                        }
                        var ol = countLibertiesOn(probeBoard, libs[li].r,
                                                  libs[li].c, player);
                        if ((captured || inAtari) && ol >= 1)
                            return m;
                    } else {
                        // Defense: any liberty that doesn't self-atari.
                        if (!putsSelfInAtari(b, koB, koActive, player,
                                             libs[li].r, libs[li].c))
                            return m;
                    }
                }
            }
        }
    }
    return -1;
}

// Scored fallback choice: base score (randomness + locality + shape),
// contender-only eye/self-atari penalties, hard pass discipline (pass only
// when the board is nearly full, so playouts resolve instead of ending on
// komi noise), and retry on failed placements. Applies the winning move to
// (b, koB) and records it; returns the move index, or -1 for a pass turn.
function chooseScoredMove(b, koB, koActiveObj, player, moves, lastR, lastC) {
    var n = moves.length;
    var scores = [];
    var i, best = -99999;
    for (i = 0; i < n; i++) {
        var s;
        if (moves[i].r === MCTS_PASS_ROW) {
            s = (n <= 3) ? 2000 : (mctsRng() % 10) - 40;
        } else {
            s = mctsRng() % 10;
            var dist = Math.abs(moves[i].r - lastR) +
                       Math.abs(moves[i].c - lastC);
            if (dist <= 2)
                s += 20;
            else if (dist <= 4)
                s += 10;
            var mr = moves[i].r, mc = moves[i].c;
            var firstLine = (mr === 0 || mr === 8 || mc === 0 || mc === 8);
            var secondLine = (mr === 1 || mr === 7 || mc === 1 || mc === 7);
            if (firstLine)
                s -= 25;
            else if (secondLine)
                s -= 8;
            else if (mr >= 2 && mr <= 6 && mc >= 2 && mc <= 6)
                s += 6;
        }
        scores[i] = s;
        if (s > best)
            best = s;
    }
    // Expensive tactical penalties for contenders only, applied
    // probabilistically (Pachi-style cost gate).
    var doPen = ((mctsRng() % 10) < TACT_PEN_PROB10);
    for (i = 0; i < n; i++) {
        if (moves[i].r === MCTS_PASS_ROW || scores[i] < best - 40)
            continue;
        if (!doPen)
            continue;
        if (fillsOwnEye(b, moves[i].r, moves[i].c, player))
            scores[i] -= 100;
        else if (putsSelfInAtari(b, koB, koActiveObj.flag, player, moves[i].r, moves[i].c))
            scores[i] -= 60;
    }
    // Try in score order until a placement succeeds (ko can still reject).
    var tried = [];
    for (i = 0; i < n; i++)
        tried[i] = false;
    for (var attempt = 0; attempt < 6; attempt++) {
        var bi = -1, bs = -99999;
        for (i = 0; i < n; i++) {
            if (!tried[i] && scores[i] > bs) {
                bs = scores[i];
                bi = i;
            }
        }
        if (bi < 0)
            return -1;
        tried[bi] = true;
        if (moves[bi].r === MCTS_PASS_ROW)
            return bi;
        var res = simTryPlace(b, koB, koActiveObj.flag, player,
                              moves[bi].r, moves[bi].c);
        if (res.success) {
            koActiveObj.flag = res.koActive;
            recordHistMove(moves[bi].r, moves[bi].c, player);
            return bi;
        }
    }
    return -1;
}

// Terminal scoring that does not reward dead stones: before Tromp-Taylor
// counting, strip groups with <=1 liberty (likely dead at playout end) so
// self-atari invasions score as losses, not free points. Single pass over
// the terminal position; uses probeBoard as scratch (playout is finished).
function scoreBoardDeadAware(b) {
    copyBoard(probeBoard, b);
    for (var r = 0; r < BOARD_SIZE; r++) {
        for (var c = 0; c < BOARD_SIZE; c++) {
            var idx = boardIndex(r, c);
            var col = probeBoard[idx];
            if (col !== BLACK && col !== WHITE)
                continue;
            if (countLibertiesOn(probeBoard, r, c, col) <= 1)
                removeGroupOn(probeBoard, r, c, col);
        }
    }
    return scoreBoard(probeBoard);
}

function mctsPlayout(initialPlayer) {
    copyBoard(playBoard, simBoard);
    copyBoard(playKoBoard, simKoBoard);
    playKoActive = simKoActive;
    playPlayer = initialPlayer;
    playLastRow = simLastRow;
    playLastCol = simLastCol;
    playPasses = 0;

    var playoutMoves = 0;

    while (playoutMoves < MCTS_MAX_PLAYOUT) {
        var moves = getLegalMovesOn(playBoard, playKoBoard, playKoActive, playPlayer, true);
        if (moves.length === 0)
            break;

        // Tiered tactics first (atari kill/escape, local 2-lib fights),
        // then the scored fallback. Both apply the move (or report a pass).
        var moveIdx = findTacticalMove(playBoard, playKoBoard, playKoActive,
                                       playPlayer, moves, playLastRow,
                                       playLastCol);
        if (moveIdx >= 0) {
            var tm = moves[moveIdx];
            var tres = simTryPlace(playBoard, playKoBoard, playKoActive,
                                   playPlayer, tm.r, tm.c);
            if (tres.success) {
                playKoActive = tres.koActive;
                playLastRow = tm.r;
                playLastCol = tm.c;
                playPasses = 0;
                recordHistMove(tm.r, tm.c, playPlayer);
                moveIdx = -2; // applied
            } else {
                moveIdx = -1; // ko-rejected: fall through to scored choice
            }
        }

        if (moveIdx === -1) {
            var koBox = {flag: playKoActive};
            var si = chooseScoredMove(playBoard, playKoBoard, koBox,
                                      playPlayer, moves, playLastRow,
                                      playLastCol);
            playKoActive = koBox.flag;
            if (si < 0) {
                playPasses++;
                if (playPasses >= 2)
                    break;
            } else if (moves[si].r === MCTS_PASS_ROW) {
                playPasses++;
                if (playPasses >= 2)
                    break;
            } else {
                playPasses = 0;
                playLastRow = moves[si].r;
                playLastCol = moves[si].c;
            }
        }

        playPlayer = (playPlayer === BLACK) ? WHITE : BLACK;
        playoutMoves++;
    }

    var score = scoreBoardDeadAware(playBoard);
    return (score > 0) ? 1 : 0;
}

function mctsRun(iterations, currentPlayer, lastRow, lastCol, consecutivePasses) {
    initPools();

    rngState = (12345 + requestSeq * 7919) | 0;
    requestSeq++;

    // Fullness gate for the pass prior (see above).
    var empties = 0;
    for (var ei = 0; ei < BOARD_SIZE * BOARD_SIZE; ei++) {
        if (gBoard[ei] === EMPTY)
            empties++;
    }
    passPrior = (empties <= ENDGAME_EMPTIES) ? 0.5 : PASS_OPEN_PRIOR;

    rootNode = allocNode(MCTS_PASS_ROW, MCTS_PASS_COL, EMPTY);

    // Expand ALL root children up front. Without this the selection loop
    // only ever descends through the single first-expanded child, so the
    // tree grows as one degenerate line and the reply is just the first
    // shuffled move (usually an edge point) instead of a searched choice.
    // With real siblings at the root, UCT + progressive shape bias actually
    // compare all opening moves by visits.
    copyBoard(simBoard, gBoard);
    copyBoard(simKoBoard, gKoBoard);
    simKoActive = gKoActive;
    var openingMoves = getLegalMovesOn(simBoard, simKoBoard, simKoActive, currentPlayer);
    var root = nodePool[rootNode];
    for (var om = 0; om < openingMoves.length; om++) {
        var oc = allocNode(openingMoves[om].r, openingMoves[om].c, currentPlayer);
        if (oc === MCTS_NO_NODE)
            break;
        if (root.firstChild === MCTS_NO_NODE) {
            root.firstChild = oc;
        } else {
            var sib = root.firstChild;
            while (nodePool[sib].nextSibling !== MCTS_NO_NODE)
                sib = nodePool[sib].nextSibling;
            nodePool[sib].nextSibling = oc;
        }
    }

    var startTime = Date.now();
    var iter = 0;
    for (iter = 0; iter < iterations; iter++) {
        // Time-boxed: stop early so the reply beats the watch-side timeout.
        // Date.now() is checked every 16 iterations to keep overhead low.
        if ((iter & 15) === 0 && iter > 0) {
            if (iter === 64) {
                // Adaptive iteration count: measure this engine's speed and
                // fit the search into 85% of the budget. Slow phone engines
                // would otherwise run a thin, noise-dominated search (or
                // trip the watchdog), which is when random-looking moves and
                // unjustified passes happen.
                var elapsed = Date.now() - startTime;
                if (elapsed > 0) {
                    var estFit = Math.floor(64 * (MCTS_TIME_BUDGET_MS * 0.85) / elapsed);
                    if (estFit < iterations) {
                        iterations = Math.max(150, estFit);
                        console.log('pkjs: adaptive iterations -> ' + iterations);
                    }
                }
            }
            if ((Date.now() - startTime) > MCTS_TIME_BUDGET_MS) {
                console.log('pkjs: time budget exceeded at iter ' + iter + '/' + iterations);
                break;
            }
        }
        if (iter % 500 === 0)
            console.log('pkjs: MCTS iter ' + iter + '/' + iterations + ' pool=' + nodePoolUsed);
        mctsPathLen = 0;
        playHistN = 0;
        var nodeIdx = rootNode;

        copyBoard(simBoard, gBoard);
        copyBoard(simKoBoard, gKoBoard);
        simKoActive = gKoActive;
        simPlayer = currentPlayer;
        simLastRow = lastRow;
        simLastCol = lastCol;
        simPasses = consecutivePasses;

        mctsPath[mctsPathLen] = nodeIdx;
        mctsPathLen++;

        while (mctsPathLen < 200 && nodeIdx < MCTS_POOL_SIZE) {
            var n = nodePool[nodeIdx];
            var child = n.firstChild;
            if (child === MCTS_NO_NODE)
                break;

            var bestChild = MCTS_NO_NODE;
            var bestUct = -999999;

            while (child !== MCTS_NO_NODE && child < MCTS_POOL_SIZE) {
                var uctVal = uct(child, n.visits);
                if (uctVal > bestUct) {
                    bestUct = uctVal;
                    bestChild = child;
                }
                child = nodePool[child].nextSibling;
            }

            if (bestChild === MCTS_NO_NODE)
                break;

            var bc = nodePool[bestChild];
            if (bc.moveRow === MCTS_PASS_ROW) {
                simPasses++;
            } else {
                simPasses = 0;
                var mover = simPlayer;
                var result = simTryPlace(simBoard, simKoBoard, simKoActive,
                                         simPlayer, bc.moveRow, bc.moveCol);
                simKoActive = result.koActive;
                if (result.success)
                    recordHistMove(bc.moveRow, bc.moveCol, mover);
                simLastRow = bc.moveRow;
                simLastCol = bc.moveCol;
            }
            simPlayer = (simPlayer === BLACK) ? WHITE : BLACK;

            mctsPath[mctsPathLen] = bestChild;
            mctsPathLen++;
            nodeIdx = bestChild;
        }

        var leaf = nodePool[nodeIdx];
        var moves = getLegalMovesOn(simBoard, simKoBoard, simKoActive, simPlayer);

        var unexpandedIdx = -1;

        for (var m = 0; m < moves.length; m++) {
            var found = false;
            var child = leaf.firstChild;
            while (child !== MCTS_NO_NODE && child < MCTS_POOL_SIZE) {
                var c = nodePool[child];
                if (c.moveRow === moves[m].r && c.moveCol === moves[m].c) {
                    found = true;
                    break;
                }
                child = c.nextSibling;
            }
            if (!found && unexpandedIdx < 0) {
                unexpandedIdx = m;
            }
        }

        // Shared tactical priority (atari kill/escape, local 2-lib fights)
        // overrides the first-unexpanded default when it names an untried move.
        var tactIdx = findTacticalMove(simBoard, simKoBoard, simKoActive,
                                       simPlayer, moves, simLastRow,
                                       simLastCol);
        if (tactIdx >= 0) {
            var already = false;
            var ch = leaf.firstChild;
            while (ch !== MCTS_NO_NODE && ch < MCTS_POOL_SIZE) {
                var cn = nodePool[ch];
                if (cn.moveRow === moves[tactIdx].r &&
                    cn.moveCol === moves[tactIdx].c) {
                    already = true;
                    break;
                }
                ch = cn.nextSibling;
            }
            if (!already)
                unexpandedIdx = tactIdx;
        }

        if (unexpandedIdx >= 0) {
            var newChild = allocNode(moves[unexpandedIdx].r, moves[unexpandedIdx].c, simPlayer);
            if (newChild !== MCTS_NO_NODE) {
                if (leaf.firstChild === MCTS_NO_NODE) {
                    leaf.firstChild = newChild;
                } else {
                    var sib = leaf.firstChild;
                    while (nodePool[sib].nextSibling !== MCTS_NO_NODE) {
                        sib = nodePool[sib].nextSibling;
                    }
                    nodePool[sib].nextSibling = newChild;
                }

                if (moves[unexpandedIdx].r === MCTS_PASS_ROW) {
                    simPasses++;
                } else {
                    simPasses = 0;
                    var emover = simPlayer;
                    var result = simTryPlace(simBoard, simKoBoard, simKoActive,
                                             simPlayer, moves[unexpandedIdx].r,
                                             moves[unexpandedIdx].c);
                    simKoActive = result.koActive;
                    if (result.success)
                        recordHistMove(moves[unexpandedIdx].r,
                                       moves[unexpandedIdx].c, emover);
                    simLastRow = moves[unexpandedIdx].r;
                    simLastCol = moves[unexpandedIdx].c;
                }
                simPlayer = (simPlayer === BLACK) ? WHITE : BLACK;

                if (mctsPathLen < 199) {
                    mctsPath[mctsPathLen] = newChild;
                    mctsPathLen++;
                    nodeIdx = newChild;
                }
            }
        }

        var resultVal = mctsPlayout(simPlayer);
        updateAmaf(resultVal);

        for (var i = mctsPathLen - 1; i >= 0; i--) {
            var n = nodePool[mctsPath[i]];
            n.visits++;
            if (n.player === BLACK && resultVal === 1) {
                n.wins++;
            } else if (n.player === WHITE && resultVal === 0) {
                n.wins++;
            }
        }
    }
}

// Pass replies need justification: a pass in an open position is almost
// always wrong, but thin searches (few visits per child) and komi-skewed
// playouts can make it look attractive. So the pass child wins only with
// dominant evidence (>PASS_VISIT_MARGIN x the best stone's visits); with no
// visited stone at all (search tripped the budget almost immediately) we
// play static shape instead of passing.
var PASS_VISIT_MARGIN = 2;

function mctsGetBestMove() {
    var root = nodePool[rootNode];
    var bestStone = MCTS_NO_NODE;
    var bestStoneV = -1;
    var bestPass = MCTS_NO_NODE;
    var bestPassV = -1;

    var child = root.firstChild;
    while (child !== MCTS_NO_NODE && child < MCTS_POOL_SIZE) {
        var c = nodePool[child];
        if (c.moveRow === MCTS_PASS_ROW) {
            if (c.visits > bestPassV) {
                bestPassV = c.visits;
                bestPass = child;
            }
        } else if (c.visits > bestStoneV) {
            bestStoneV = c.visits;
            bestStone = child;
        }
        child = c.nextSibling;
    }

    if (bestStone === MCTS_NO_NODE)
        return bestPass; // only pass exists (board full): pass is correct
    if (bestStoneV <= 0)
        return bestPriorStone(); // too thin to have tried anything: shape
    if (bestPass !== MCTS_NO_NODE &&
        bestPassV > PASS_VISIT_MARGIN * bestStoneV)
        return bestPass;
    return bestStone;
}

// Highest static-shape non-pass root child (deterministic fallback).
function bestPriorStone() {
    var root = nodePool[rootNode];
    var best = MCTS_NO_NODE;
    var bestShape = -99999;
    var child = root.firstChild;
    while (child !== MCTS_NO_NODE && child < MCTS_POOL_SIZE) {
        var c = nodePool[child];
        if (c.moveRow !== MCTS_PASS_ROW) {
            var s = shapeScore(c.moveRow, c.moveCol);
            if (s > bestShape) {
                bestShape = s;
                best = child;
            }
        }
        child = c.nextSibling;
    }
    return best;
}


// ---- opening book (moves 1-2) ----
// Research basis (katagobooks.org 9x9 book, area scoring like ours):
// Black's optimal first moves are the 4-4 point (most popular with strong
// bots), tengen, and 4-5; vs a 4-4 corner White takes the diagonally
// opposing 4-4. Vs tengen White takes a solid 3-3 corner. All other
// single-stone classes use the diagonal strategy (180-degree rotation),
// which splits the board.
// Symmetry classes: the 8 D4 transforms (rotation/reflection) map any
// single stone to one canonical representative; the reply is computed in
// canonical coords and mapped back, so rotated positions provably get
// rotated replies. INV[t] inverts transform t.
var SYM_COUNT = 8;
var SYM_INV = [0, 3, 2, 1, 4, 5, 6, 7];

function symApply(t, r, c) {
    if (t === 0) return [r, c];
    if (t === 1) return [c, 8 - r];
    if (t === 2) return [8 - r, 8 - c];
    if (t === 3) return [8 - c, r];
    if (t === 4) return [8 - r, c];
    if (t === 5) return [r, 8 - c];
    if (t === 6) return [c, r];
    return [8 - c, 8 - r];
}

// Canonical reply table, keyed by canonical single-stone coord (row*9+col).
// Tengen (40) -> solid 3-3 corner (18); 4-4 corner (30) -> opposing 4-4 (50).
var OPENING_REPLY = {
    40: [2, 2],
    30: [5, 5]
};

function canonicalTransform(r, c) {
    var bestT = 0, bestKey = 999;
    for (var t = 0; t < SYM_COUNT; t++) {
        var p = symApply(t, r, c);
        var key = p[0] * BOARD_SIZE + p[1];
        if (key < bestKey) {
            bestKey = key;
            bestT = t;
        }
    }
    return bestT;
}

// Returns [r, c] or null. Only for genuine 1-2 move openings.
function openingBookMove(b, movesMade, player) {
    var stones = 0, sr = -1, sc = -1, i;
    for (i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (b[i] !== EMPTY) {
            stones++;
            sr = Math.floor(i / BOARD_SIZE);
            sc = i % BOARD_SIZE;
        }
    }
    if (movesMade === 0) {
        if (stones !== 0 || player !== BLACK)
            return null;
        return [3, 3]; // 4-4 point: KataGo's most popular optimal opener
    }
    if (movesMade !== 1 || stones !== 1)
        return null;
    var t = canonicalTransform(sr, sc);
    var cp = symApply(t, sr, sc);
    var key = cp[0] * BOARD_SIZE + cp[1];
    var rep = OPENING_REPLY[key];
    var br, bc;
    if (rep) {
        br = rep[0];
        bc = rep[1];
    } else {
        br = 8 - cp[0]; // diagonal strategy: rotate 180 in canonical space
        bc = 8 - cp[1];
    }
    var back = symApply(SYM_INV[t], br, bc);
    if (boardIndex(back[0], back[1]) < 0 || b[back[0] * BOARD_SIZE + back[1]] !== EMPTY)
        return null;
    return back;
}
// Send a move reply back to the watch. This is the ONLY way the watch
// leaves AI_THINKING (besides its own timeout), so every code path below
// must end here — never throw without replying, or the game appears hung
// with dead buttons until the watch-side timeout fires.
function sendMoveReply(moveRow, moveCol, isPass) {
    console.log('pkjs: sending result back to watch...');
    try {
        Pebble.sendAppMessage({
            0: 1,
            1: moveRow,
            2: moveCol,
            3: isPass
        }, function() {
            console.log('pkjs: result sent OK');
        }, function() {
            console.log('pkjs: result send FAILED');
        });
    } catch (e) {
        console.log('pkjs: sendAppMessage threw: ' + (e && e.message));
    }
}

// Copy a byte-array payload (Uint8Array, ArrayBuffer, or plain Array) into
// a plain JS array of length `len`. Returns false when the payload is
// missing, short, or non-numeric — caller then replies pass instead of
// running MCTS on garbage.
function copyBytesFromPayload(data, len, dst) {
    var src = data;
    if (src instanceof ArrayBuffer) {
        src = new Uint8Array(src);
    }
    if (!src || typeof src.length !== 'number' || src.length < len) {
        return false;
    }
    for (var i = 0; i < len; i++) {
        var v = src[i];
        if (typeof v !== 'number' || !(v >= 0 && v <= 255)) {
            return false;
        }
        dst[i] = v | 0;
    }
    return true;
}

Pebble.addEventListener('ready', function() {
    console.log('pkjs: ready');
    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        gBoard[i] = 0;
        gKoBoard[i] = 0;
    }
    gKoActive = false;
});

// ---- Pebble app message handler ----

Pebble.addEventListener('appmessage', function(e) {
    try {
        handleAiRequest(e && e.payload);
    } catch (err) {
        // Last-resort guarantee: any unexpected throw still unblocks the
        // watch with an error (never a silent pass).
        console.log('pkjs: handler threw, replying error: ' + (err && err.message));
        sendMoveReply(0, 0, 2);
    }
});

function handleAiRequest(payload) {
    var type = payload ? payload[0] : undefined;
    console.log('pkjs: appmessage received, type=' + type);
    if (type !== 0) {
        console.log('pkjs: ignoring type=' + type);
        return;
    }

    console.log('pkjs: parsing board data...');
    if (!copyBytesFromPayload(payload[5], 81, gBoard)) {
        console.log('pkjs: invalid board payload, replying error');
        sendMoveReply(0, 0, 2);
        return;
    }

    var koRaw = payload[6];
    var koSrc = (koRaw instanceof ArrayBuffer) ? new Uint8Array(koRaw) : koRaw;
    if (!copyBytesFromPayload(koSrc, 81, gKoBoard)) {
        console.log('pkjs: invalid ko payload, replying error');
        sendMoveReply(0, 0, 2);
        return;
    }
    gKoActive = (koSrc[81] | 0) !== 0;

    var currentPlayer = payload[1] | 0;
    var lastRow = payload[2] | 0;
    var lastCol = payload[3] | 0;
    var consecutivePasses = payload[4] | 0;
    var movesMade = payload[7] | 0;
    if (currentPlayer !== BLACK && currentPlayer !== WHITE) {
        console.log('pkjs: invalid player=' + payload[1] + ', replying error');
        sendMoveReply(0, 0, 2);
        return;
    }
    console.log('pkjs: player=' + currentPlayer + ' last=(' + lastRow + ',' + lastCol + ') passes=' + consecutivePasses + ' moves=' + movesMade);

    // Opening book first (moves 1-2): deterministic, no search needed.
    var bookMove = openingBookMove(gBoard, movesMade, currentPlayer);
    if (bookMove) {
        console.log('pkjs: opening book plays (' + bookMove[0] + ',' + bookMove[1] + ')');
        sendMoveReply(bookMove[0], bookMove[1], 0);
        return;
    }

    // Forced capture shortcut: a hanging 1-lib enemy group is captured
    // outright when tactically sound. Snapback/throw-in traps are filtered
    // by isUnsafeCapture — those fall through to full search instead.
    var rootMoves = getLegalMovesOn(gBoard, gKoBoard, gKoActive, currentPlayer);
    var killIdx = findAtariKill(gBoard, currentPlayer, rootMoves);
    if (killIdx >= 0) {
        copyBoard(probeBoard, gBoard);
        copyBoard(probeKo, gKoBoard);
        var ktest = simTryPlace(probeBoard, probeKo, gKoActive, currentPlayer,
                                rootMoves[killIdx].r, rootMoves[killIdx].c);
        if (ktest.success &&
            !isUnsafeCapture(gBoard, gKoBoard, gKoActive, currentPlayer,
                             rootMoves[killIdx].r, rootMoves[killIdx].c)) {
            console.log('pkjs: forced capture at (' + rootMoves[killIdx].r + ',' + rootMoves[killIdx].c + ')');
            sendMoveReply(rootMoves[killIdx].r, rootMoves[killIdx].c, 0);
            return;
        } else {
            console.log('pkjs: atari kill looks unsafe (snapback?), searching instead');
        }
    }

    console.log('pkjs: running MCTS with up to ' + MCTS_ITERATIONS + ' iterations...');
    var startTime = Date.now();
    mctsRun(MCTS_ITERATIONS, currentPlayer, lastRow, lastCol, consecutivePasses);
    var elapsed = Date.now() - startTime;
    console.log('pkjs: MCTS finished in ' + elapsed + 'ms');

    var best = mctsGetBestMove();
    console.log('pkjs: best node index=' + best);

    // Root safety veto: never play an immediately-dead move when a tried
    // alternative exists. If the visits-winner is a pure self-atari (or
    // fills our own eye), walk down the visit ranking for the first safe
    // stone. Captures are never vetoed (putsSelfInAtari is false for them).
    if (best !== MCTS_NO_NODE) {
        var bn = nodePool[best];
        if (bn.moveRow !== MCTS_PASS_ROW &&
            (putsSelfInAtari(gBoard, gKoBoard, gKoActive, currentPlayer,
                             bn.moveRow, bn.moveCol) ||
             fillsOwnEye(gBoard, bn.moveRow, bn.moveCol, currentPlayer))) {
            console.log('pkjs: veto unsafe best (' + bn.moveRow + ',' + bn.moveCol + '), seeking safe alternative');
            var cands = [];
            var ch = nodePool[rootNode].firstChild;
            while (ch !== MCTS_NO_NODE && ch < MCTS_POOL_SIZE) {
                var cn = nodePool[ch];
                if (cn.moveRow !== MCTS_PASS_ROW && cn.visits > 0)
                    cands.push(ch);
                ch = cn.nextSibling;
            }
            cands.sort(function(a, b) { return nodePool[b].visits - nodePool[a].visits; });
            for (var ci = 0; ci < cands.length && ci < 10; ci++) {
                var cand = nodePool[cands[ci]];
                if (!putsSelfInAtari(gBoard, gKoBoard, gKoActive,
                                     currentPlayer, cand.moveRow, cand.moveCol) &&
                    !fillsOwnEye(gBoard, cand.moveRow, cand.moveCol,
                                 currentPlayer)) {
                    console.log('pkjs: veto -> safe (' + cand.moveRow + ',' + cand.moveCol + ') visits=' + cand.visits);
                    best = cands[ci];
                    break;
                }
            }
        }
    }

    var moveRow, moveCol, isPass;
    if (best === MCTS_NO_NODE) {
        console.log('pkjs: no best move, replying error');
        isPass = 2;
        moveRow = 0;
        moveCol = 0;
    } else {
        var node = nodePool[best];
        moveRow = node.moveRow;
        moveCol = node.moveCol;
        isPass = (moveRow === MCTS_PASS_ROW && moveCol === MCTS_PASS_COL) ? 1 : 0;
        if (isPass === 1 && movesMade < PKJS_PASS_MIN_MOVES) {
            // Early passes are prohibited: report instead of playing one.
            console.log('pkjs: search wants early pass (moves=' + movesMade + '), replying error');
            isPass = 2;
            moveRow = 0;
            moveCol = 0;
        } else {
            console.log('pkjs: best move=(' + moveRow + ',' + moveCol + ') visits=' + node.visits + ' wins=' + node.wins + ' pass=' + isPass);
        }
    }

    sendMoveReply(moveRow, moveCol, isPass);
}
