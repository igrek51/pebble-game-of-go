var BOARD_SIZE = 9;
var EMPTY = 0, BLACK = 1, WHITE = 2;

var MCTS_PASS_ROW = 9;
var MCTS_PASS_COL = 9;
var MCTS_POOL_SIZE = 10000;
var MCTS_NO_NODE = -1;
// 1000 iterations now cost ~0.5s desktop (~5s phone worst case) after the
// capped-liberties + typed-array speedup, so the full count fits the 20s
// budget with margin. Cutting to 500 measurably thins RAVE/eye statistics
// (eye-divider test regressed: noise favorites outvote knowledge).
var MCTS_ITERATIONS = 1000;
var MCTS_MAX_PLAYOUT = 120;
// Passing is strictly prohibited before this many moves have been made
// (passes possible starting with the 41st move). Mirrored in main.c
// (AI_PASS_MIN_MOVES); when the search wants to pass earlier, or finds no
// move at all, an error reply (isPass 2) is sent so the watch reports it
// instead of silently passing.
var PKJS_PASS_MIN_MOVES = 40;// Wall-clock budget for one AI move. The watch gives up on the companion
// after COMM_TIMEOUT_MS (72000ms), so the reply must leave well before that,
// including AppMessage transport time. Replies are also a UX latency: with
// priors/tactics doing the steering, some hundred iterations pick as well as
// a minute-long grind (playout noise dominates either way), so the budget is
// deliberately short — strength comes from speed (more iterations/sec via
// capped liberties + typed boards), not from thinking longer.
var MCTS_TIME_BUDGET_MS = 20000;

var nodePool = [];
var nodePoolUsed = 0;
var rootNode = MCTS_NO_NODE;

// Board buffers as Uint8Array: copies become native memcpy (.set()) instead
// of 81-iteration JS loops, and element access stays identical. This is the
// single biggest phone-speed win after capped liberties: simTryPlace alone
// used to copy 2x81 cells per attempted move. gBoard/gKoBoard stay plain
// (payload-filled); everything else below is typed.
var simBoard = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
var simKoBoard = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
var simKoActive = false;
var simPlayer = EMPTY;
var simLastRow = -1;
var simLastCol = -1;
var simPasses = 0;

var playBoard = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
var playKoBoard = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
var playKoActive = false;
var playPlayer = EMPTY;
var playLastRow = -1;
var playLastCol = -1;
var playPasses = 0;

var mctsPath = [];
var mctsPathLen = 0;
// RAVE bookkeeping per path node: playHistN at arrival (subsequent moves
// = hist entries at index >= this) and player to move at the node.
var mctsPathHist = [];
var mctsPathQ = [];

var simTempBoard = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
var probeBoard = new Uint8Array(BOARD_SIZE * BOARD_SIZE);  // scratch for tactical simulations (capture/eye/self-atari tests)
var probeKo = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
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

// Global AMAF: LONG-TERM memory across moves (ponder channel, item E).
// Decayed (halved) per request in initPools, never reset mid-game. Read in
// uct() only as a weak +/-30 pull; per-node RAVE above is the primary
// within-search signal. amafV[color][idx] counts playouts where `color`
// played idx; amafW counts those the mover eventually won.
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

function initPools(resetAmaf) {
    // NOTE: the node pool is NOT reset here (persistent tree, item 5):
    // mctsRun resets it explicitly on the fresh path only.
    simBoard.fill(0);
    simKoBoard.fill(0);
    playBoard.fill(0);
    playKoBoard.fill(0);
    simTempBoard.fill(0);
    probeBoard.fill(0);
    probeKo.fill(0);
    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (resetAmaf) {
            amafV[BLACK][i] = 0;
            amafW[BLACK][i] = 0;
            amafV[WHITE][i] = 0;
            amafW[WHITE][i] = 0;
        } else {
            // Tree knowledge reuse across moves (item E): keep AMAF with
            // halving decay so last move's lessons steer but never dominate.
            amafV[BLACK][i] = Math.floor((amafV[BLACK][i] || 0) / 2);
            amafW[BLACK][i] = Math.floor((amafW[BLACK][i] || 0) / 2);
            amafV[WHITE][i] = Math.floor((amafV[WHITE][i] || 0) / 2);
            amafW[WHITE][i] = Math.floor((amafW[WHITE][i] || 0) / 2);
        }
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
        player: player,
        // Benson alive-count prior (capped stones), set at expansion.
        // Siblings share the pre-move position, so ranking by alive-after
        // equals ranking by alive-delta. Read in uct(), zero for pass/unset.
        prior: 0,
        // Item A eye prior: 12 = divides interior into 2+ eyes, 3 =
        // solidifies. Added FLAT in uct() (not via the clamped AMAF pr):
        // on open boards playout winrates cannot resolve a 2-point eye
        // edge through 120 random moves (noise is hundreds of points),
        // so only a decisive persistent bonus steers the root choice.
        // Urgent kill/escape lines still win on real exploit (near-certain
        // wins shift exploit by 300+). Set at root + expansion, zero for
        // pass/unset.
        eye: 0,
        // 3x3 pattern prior (net weight, may be negative for triangles).
        // Flat in uct() like eye but smaller (+/-25 per weight).
        pat: 0,
        // Escape urgency: sound rescue of an own 1-lib group (ladder +
        // sacrifice verdict passed). Answering atari beats tenuki ~90% of
        // the time, so this outranks shape/pattern noise but not decisive
        // tactics or eye-division. Set at root + expansion.
        urg: 0,
        // Atari threat: the move leaves an enemy group with one liberty
        // (Fuego-style global threat bonus). Contact-gated, set at root +
        // expansion. Kills need none of it (forced outright).
        thr: 0,
        // Connection: joins 2+ own groups (cut shapes die in pieces).
        // Flat in uct() like patterns (+25). Set at root + expansion.
        con: 0,
        // Contested connection: joins groups next to enemy stones (someone
        // wants to cut here) and lives. Rescue-class urgency below escapes:
        // answer the cut before tenuki. Set at root + expansion.
        cut: 0,
        // Per-node RAVE (Aya-style): outcomes of playouts passing through
        // the PARENT where this move was played later by the side to move.
        raveV: 0,
        raveW: 0
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

// ---- 3x3 shape patterns (Aya/MoGo-style) ----
// Aya learned these from 10,000 pro games; same mechanism here with a
// hand-written seed set (extendable without retraining). Alphabet:
// 'X' own, 'O' opponent, '.' empty, '#' off-board, ' ' don't-care.
// Center (index 4) is always our move point, hence '.'. All 8 symmetries
// are precomputed at load. Matched ONLY near the last move (Fuego/MoGo:
// patterns are local tactics), which also bounds the cost.
var PATTERNS_BASE = [
    { w: 1, g: ["X.X", "...", "..."] }, // straight 1-gap connection
    { w: 1, g: [" X ", "X X", "..."] }, // tiger mouth (cutting-point defense)
    { w: 1, g: [" O ", "X. ", "..."] }, // hane around enemy stone
    { w: 1, g: [" X ", " . ", " O "] }, // contact peep
    { w: 1, g: ["X..", " . ", "..X"] }, // diagonal solidify
    { w: 1, g: [" X ", " . ", " X "] }, // bamboo joint
    { w: 1, g: [" X ", "O.O", " X "] }, // cut-fill between own stones
    { w: 1, g: [" O ", "X.X", " X "] }, // tiger-mouth close
    { w: 1, g: ["X  ", " .X", "..."] }, // keima (knight) shape
    { w: 1, g: ["  O", "X. ", "..."] }, // shoulder-hit attachment
    { w: -1, g: ["XX ", "X. ", "..."] } // EMPTY TRIANGLE (universally bad)
];

var PATS = [];

(function initPats() {
    var seen = {};
    function xf(t, x, y) {
        if (t === 0) return [x, y];
        if (t === 1) return [2 - y, x];
        if (t === 2) return [2 - x, 2 - y];
        if (t === 3) return [y, 2 - x];
        if (t === 4) return [2 - x, y];
        if (t === 5) return [x, 2 - y];
        if (t === 6) return [y, x];
        return [2 - y, 2 - x];
    }
    for (var p = 0; p < PATTERNS_BASE.length; p++) {
        var base = PATTERNS_BASE[p];
        for (var t = 0; t < 8; t++) {
            var cells = [0, 0, 0, 0, 0, 0, 0, 0, 0];
            for (var y = 0; y < 3; y++) {
                for (var x = 0; x < 3; x++) {
                    var q = xf(t, x, y);
                    var ch = base.g[q[1]][q[0]];
                    var v = 0;
                    if (ch === 'X') v = 1;
                    else if (ch === 'O') v = 2;
                    else if (ch === '.') v = 3;
                    else if (ch === '#') v = 4;
                    cells[y * 3 + x] = v;
                }
            }
            var key = cells.join('') + ':' + base.w;
            if (!seen[key]) {
                seen[key] = true;
                PATS.push({ cells: cells, w: base.w });
            }
        }
    }
})();

// Net pattern weight at (r,c) for `player` on pre-move (b): +N good hits,
// -N triangle hits, 0 none. Caller gates to near-last-move + contender caps.
function patBonus(b, r, c, player) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    var v = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < 9; i++) {
        var nr = r + Math.floor(i / 3) - 1, nc = c + (i % 3) - 1;
        var nidx = boardIndex(nr, nc);
        if (nidx < 0)
            v[i] = -1;
        else
            v[i] = b[nidx];
    }
    if (v[4] !== EMPTY)
        return 0;
    var net = 0;
    for (var p = 0; p < PATS.length; p++) {
        var cells = PATS[p].cells, ok = true;
        for (var k = 0; k < 9; k++) {
            var e = cells[k];
            if (e === 0)
                continue;
            if (e === 1 && v[k] !== player) { ok = false; break; }
            if (e === 2 && v[k] !== opp) { ok = false; break; }
            if (e === 3 && v[k] !== EMPTY) { ok = false; break; }
            if (e === 4 && v[k] !== -1) { ok = false; break; }
        }
        if (ok)
            net += PATS[p].w;
    }
    return net;
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

    // Per-node RAVE (Aya-style) with heuristic initialization.
    // Prior rate pr blends shape + Benson alive gradient; RAVE_PRIOR_W
    // pseudo-observations guide before real data exists. Yamashita beta
    // sqrt(100/(3v+100)) fades toward pure UCT fast (10% weight by ~300
    // visits), unlike the old K=500 global blend that stayed
    // prior-dominated for hundreds of visits.
    var RAVE_PRIOR_W = 20;
    var pr = passPrior;
    if (node.moveRow !== MCTS_PASS_ROW) {
        pr = 0.5 + shapeScore(node.moveRow, node.moveCol) / 2000;
        // Benson alive gradient (item C): prefer lines that leave the mover
        // with more unconditionally-alive stones. Cached at expansion;
        // capped at 8 stones * 0.04 = +0.32 so it steers without drowning
        // shape or real statistics. Fades with visits via beta like shape.
        if (node.prior > 0) {
            pr += Math.min(node.prior, 8) * 0.04;
        }
        if (pr < 0)
            pr = 0;
        if (pr > 1)
            pr = 1;
    }
    var beta = Math.sqrt(100 / (3 * v + 100));
    var rV = node.raveV || 0, rW = node.raveW || 0;
    var raveRate = (rW + RAVE_PRIOR_W * pr) / (rV + RAVE_PRIOR_W);
    value = Math.floor((1 - beta) * value + beta * raveRate * 1000);

    // Long-term memory (ponder channel): global AMAF persists across moves
    // with halving decay; weak +/-30 pull so fresh per-node RAVE dominates.
    if (node.moveRow !== MCTS_PASS_ROW && node.player !== EMPTY) {
        var gidx = node.moveRow * BOARD_SIZE + node.moveCol;
        var gV = amafV[node.player][gidx] || 0;
        if (gV > 0) {
            var gR = (amafW[node.player][gidx] || 0) / gV;
            value += Math.floor(60 * (gR - 0.5));
        }
    }

    // Item A: flat eye bonus (divider +300, solidify +75). Deliberately
    // outside the RAVE blend: playout noise drowns small eye edges, so the
    // bonus must be decisive to steer root choice.
    if (node.eye > 0)
        value += Math.floor(node.eye * 25);
    // 3x3 pattern flat: good shapes +, empty triangles -.
    if (node.pat !== 0)
        value += node.pat * 25;
    // Escape urgency: sound rescues outrank tenuki noise. Broken escapes
    // never carry it (verdict gate at set time), so this cannot force a
    // ladder march or a dead rescue.
    if (node.urg)
        value += 250;
    // Atari threat: forceful moves that demand an answer outrank quiet
    // tenuki. Below escape urgency (rescue first, threaten second).
    if (node.thr)
        value += 75;
    // Connection: whole groups survive together.
    if (node.con)
        value += 25;
    // Contested connection: defend the cut now, tenuki later.
    if (node.cut)
        value += 150;

    return value;
}

function copyBoard(dst, src) {
    if (dst.set)
        dst.set(src);
    else {
        for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
            dst[i] = src[i];
    }
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

// Capped liberty count: returns min(actual, cap). Atari/2-lib scans only
// need ==1 / ==2 verdicts; stopping early avoids flooding big groups and
// is 5-20x faster than a full count on open boards. Pure function of (b)
// via the shared dfsSeen generations (sequential use only).
// Reuses module scratch stacks (no per-call allocation in the hot loop).
// Group memo: recounts of the same group are skipped via (mark,cap,boardGen).
// boardGen bumps on every successful placement/removal, so entries are only
// reused while the position is unchanged (i.e. within one scan) — a capture
// freeing a neighbor's liberty can never read stale. All verdicts are exact:
// same group + same cap + same position => same count.
var libStackR = [];
var libStackC = [];
var libMemoMark = -1;
var libMemoCap = 0;
var libMemoVal = 0;
var libMemoGen = -1;
var boardGen = 0;

function countLibertiesCapped(b, startRow, startCol, color, cap) {
    var startIdx = boardIndex(startRow, startCol);
    if (startIdx < 0 || b[startIdx] !== color)
        return 0;
    if (libMemoGen === boardGen && libMemoCap === cap &&
        dfsSeen[startIdx] === libMemoMark)
        return libMemoVal;

    dfsGen++;
    var mark = dfsGen;

    var libs = 0;

    var top = 0;
    libStackR[top] = startRow;
    libStackC[top] = startCol;
    top++;
    dfsSeen[startIdx] = mark;

    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];

    while (top > 0) {
        top--;
        var r = libStackR[top], c = libStackC[top];
        for (var d = 0; d < 4; d++) {
            var nr = r + dr[d];
            var nc = c + dc[d];
            var nidx = boardIndex(nr, nc);
            if (nidx < 0 || dfsSeen[nidx] === mark)
                continue;
            var ns = b[nidx];
            if (ns === EMPTY) {
                libs++;
                if (libs >= cap) {
                    libMemoMark = mark;
                    libMemoCap = cap;
                    libMemoVal = libs;
                    libMemoGen = boardGen;
                    return libs;
                }
                dfsSeen[nidx] = mark;
            } else if (ns === color) {
                dfsSeen[nidx] = mark;
                libStackR[top] = nr;
                libStackC[top] = nc;
                top++;
            }
        }
    }
    libMemoMark = mark;
    libMemoCap = cap;
    libMemoVal = libs;
    libMemoGen = boardGen;
    return libs;
}

function removeGroupOn(b, startRow, startCol, color) {
    boardGen++;
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
            // Exact mode (tree/root): legality simulation below, plus full
            // ko verification when a ko is active (ko recaptures that also
            // capture slip past the approximation — the match harness caught
            // these as illegal replies in ko fights).
            if (fast) {
                moves.push({r: row, c: col});
                continue;
            }

            // Ko-active positions need exact verification: simulate on
            // scratch (probe is free during move generation; tactics run
            // after the list is built). Rare path (ko fights only).
            if (koActive) {
                copyBoard(probeBoard, b);
                copyBoard(probeKo, koB);
                if (simTryPlace(probeBoard, probeKo, koActive, player,
                                row, col).success)
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
                    if (countLibertiesCapped(b, nr, nc, opp, 1) === 0) {
                        anyCaptured = true;
                    }
                }
            }

            if (!anyCaptured && countLibertiesCapped(b, row, col, player, 1) === 0) {
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

    copyBoard(simTempBoard, b);

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
            countLibertiesCapped(b, nr, nc, opponent, 1) === 0) {
            removeGroupOn(b, nr, nc, opponent);
            anyCaptured = true;
        }
    }

    if (countLibertiesCapped(b, row, col, player, 1) === 0) {
        copyBoard(b, simTempBoard);
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
            copyBoard(b, simTempBoard);
            return {success: false, koActive: koActiveFlag};
        }
    }

    copyBoard(koB, simTempBoard);
    koActiveFlag = anyCaptured;

    boardGen++;
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
    return countLibertiesCapped(probeBoard, r, c, player, 2) === 1;
}

// Stones in the `color` group containing (sr,sc), capped at `cap`
// (early exit). Defenses of substantial groups are forced; 1-stone
// sidesteps fall through to the scored fallback instead of marching.
function groupSizeCapped(b, sr, sc, color, cap) {
    dfsGen++;
    var mark = dfsGen;
    var startIdx = boardIndex(sr, sc);
    if (startIdx < 0 || b[startIdx] !== color)
        return 0;
    var stackR = [sr], stackC = [sc], top = 1, n = 0;
    dfsSeen[startIdx] = mark;
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    while (top > 0) {
        top--;
        var r = stackR[top], c = stackC[top];
        n++;
        if (n >= cap)
            return n;
        for (var d = 0; d < 4; d++) {
            var nidx = boardIndex(r + dr[d], c + dc[d]);
            if (nidx < 0 || dfsSeen[nidx] === mark || b[nidx] !== color)
                continue;
            dfsSeen[nidx] = mark;
            stackR[top] = r + dr[d];
            stackC[top] = c + dc[d];
            top++;
        }
    }
    return n;
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

// ---- eye creation (item A) ----
// Count interior empty regions adjacent to the new stone at (r,c) on the
// POST-move board: flood each adjacent empty (cap 13 cells); a region is
// interior when the flood never reaches the edge and never touches an
// opponent stone. Returns 0-2 (early exit at 2). Uses its own generations
// on the shared dfsSeen buffer (sequential use only).
function eyeInteriorRegions(pb, r, c, player) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    dfsGen++;
    var doneMark = dfsGen;
    var found = 0;
    for (var d = 0; d < 4; d++) {
        var sr = r + dr[d], sc = c + dc[d];
        var sidx = boardIndex(sr, sc);
        if (sidx < 0 || pb[sidx] !== EMPTY || dfsSeen[sidx] === doneMark)
            continue;
        dfsGen++;
        var floodMark = dfsGen;
        var stackR = [sr], stackC = [sc], top = 1, cells = [sidx];
        dfsSeen[sidx] = floodMark;
        var open = false, contested = false, n = 0;
        while (top > 0 && n < 13) {
            top--;
            var cr = stackR[top], cc = stackC[top];
            n++;
            for (var e = 0; e < 4; e++) {
                var nr = cr + dr[e], nc = cc + dc[e];
                var nidx = boardIndex(nr, nc);
                if (nidx < 0) {
                    open = true;
                    continue;
                }
                if (pb[nidx] === opp) {
                    contested = true;
                    continue;
                }
                if (pb[nidx] !== EMPTY || dfsSeen[nidx] === floodMark)
                    continue;
                dfsSeen[nidx] = floodMark;
                stackR[top] = nr;
                stackC[top] = nc;
                top++;
                cells.push(nidx);
            }
        }
        for (var k = 0; k < cells.length; k++)
            dfsSeen[cells[k]] = doneMark;
        if (!open && !contested) {
            found++;
            if (found >= 2)
                return found;
        }
    }
    return found;
}

// Prefilter for eye candidates on pre-move (b): true when the point is
// attached to our shape (2+ own orthogonal neighbors) or sits in a small
// enclosed region (flood from the point stays <=14 cells with no opponent
// border and no edge reach). Open-board and fighting points fail fast.
function eyeCandidate(b, player, r, c) {
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    var own = 0, oppAdj = false;
    for (var d = 0; d < 4; d++) {
        var nidx = boardIndex(r + dr[d], c + dc[d]);
        if (nidx >= 0 && b[nidx] === player)
            own++;
    }
    if (own >= 2)
        return true;
    var opp = (player === BLACK) ? WHITE : BLACK;
    dfsGen++;
    var mark = dfsGen;
    var stackR = [r], stackC = [c], top = 1, n = 0;
    dfsSeen[boardIndex(r, c)] = mark;
    while (top > 0 && n <= 14) {
        top--;
        var cr = stackR[top], cc = stackC[top];
        n++;
        for (var e = 0; e < 4; e++) {
            var nr = cr + dr[e], nc = cc + dc[e];
            var nidx2 = boardIndex(nr, nc);
            if (nidx2 < 0)
                return false;
            if (b[nidx2] === opp)
                return false;
            if (b[nidx2] !== EMPTY || dfsSeen[nidx2] === mark)
                continue;
            dfsSeen[nidx2] = mark;
            stackR[top] = nr;
            stackC[top] = nc;
            top++;
        }
    }
    return n <= 14;
}

// Eye-making value of the candidate (r,c) for `player` on pre-move (b):
// 2 = divides interior into 2+ eye-spaces (play it!), 1 = solidifies
// (attached with 3+ own neighbors, or a point inside an enclosure that
// leaves one interior space with liberties), 0 = not eye related.
// Finished-eye fills return 0 (vetoed elsewhere).
function eyeMakeScore(b, koB, koActive, player, r, c) {
    if (!eyeCandidate(b, player, r, c) || fillsOwnEye(b, r, c, player))
        return 0;
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1], own = 0;
    for (var d = 0; d < 4; d++) {
        var nidx = boardIndex(r + dr[d], c + dc[d]);
        if (nidx >= 0 && b[nidx] === player)
            own++;
    }
    copyBoard(probeBoard, b);
    copyBoard(probeKo, koB);
    var res = simTryPlace(probeBoard, probeKo, koActive, player, r, c);
    if (!res.success)
        return 0;
    if (countLibertiesCapped(probeBoard, r, c, player, 2) < 2)
        return 0;
    var regions = eyeInteriorRegions(probeBoard, r, c, player);
    if (regions >= 2)
        return 2;
    if (own >= 3 || regions === 1)
        return 1;
    return 0;
}

// Global eye scan for expansion/root only (never in playout steps):
// returns the moves-index of an eye-dividing point (score 2), or -1.
// Prefilter is O(1) per point; simulations capped at 6.
function findEyeMove(b, koB, koActive, player, moves) {
    var checks = 0;
    for (var r = 0; r < BOARD_SIZE; r++) {
        for (var c = 0; c < BOARD_SIZE; c++) {
            var idx = boardIndex(r, c);
            if (b[idx] !== EMPTY)
                continue;
            var m = findMoveIndex(moves, r, c);
            if (m < 0)
                continue;
            if (!eyeCandidate(b, player, r, c) || fillsOwnEye(b, r, c, player))
                continue;
            if (checks >= 6)
                continue;
            checks++;
            if (eyeMakeScore(b, koB, koActive, player, r, c) >= 2)
                return m;
        }
    }
    return -1;
}

// ---- tree breadth pruning (item E) ----
// Keep pass + stones within distance 2 of any stone + star points; below
// 6 stones on the board (opening) or fewer than 12 kept stones, return the
// list unpruned so tenuki and book exits keep full breadth.
var PRUNE_STARS = [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4], [3, 3], [3, 5],
                   [5, 3], [5, 5], [2, 4], [4, 2], [4, 6], [6, 4]];

function pruneTreeMoves(moves, b) {
    var stones = 0, i;
    for (i = 0; i < 81; i++) {
        if (b[i] !== EMPTY)
            stones++;
    }
    if (stones < 6)
        return moves;
    var keep = [];
    var keptStones = 0;
    for (i = 0; i < moves.length; i++) {
        var mr = moves[i].r, mc = moves[i].c;
        if (mr === MCTS_PASS_ROW) {
            keep[i] = true;
            continue;
        }
        var near = false;
        for (var dr = -2; dr <= 2 && !near; dr++) {
            for (var dc = -2; dc <= 2 && !near; dc++) {
                if (Math.abs(dr) + Math.abs(dc) > 3)
                    continue;
                var nidx = boardIndex(mr + dr, mc + dc);
                if (nidx >= 0 && b[nidx] !== EMPTY)
                    near = true;
            }
        }
        if (!near) {
            for (var s = 0; s < PRUNE_STARS.length; s++) {
                if (PRUNE_STARS[s][0] === mr && PRUNE_STARS[s][1] === mc) {
                    near = true;
                    break;
                }
            }
        }
        keep[i] = near;
        if (near)
            keptStones++;
    }
    if (keptStones < 12)
        return moves;
    var out = [];
    for (i = 0; i < moves.length; i++) {
        if (keep[i])
            out.push(moves[i]);
    }
    return out;
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
    if (countLibertiesCapped(probeBoard, r, c, player, 2) > 1)
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

// ---- ladder reader (item A) ----
// Reads a ladder chase for an escape point (er,ec): returns true when the
// ESCAPE SUCCEEDS (defender gets out). Both sides play greedy-forced moves:
// attacker ataris (the liberty minimizing defender liberties after), the
// defender extends (the liberty maximizing its own liberties after).
// Defender reaching 3+ liberties, an illegal attacker atari, or a chase
// outrunning the board (edge/supporter breaks it) all mean success; a
// capture, or no legal extension, means the ladder holds (escape fails).
// Called ONLY at expansion (untried escape) and in the root veto — never
// inside per-step playout tactics (cost). Uses probeBoard as the chase
// board and playBoard/playKoBoard as sim scratch: safe at expansion/veto
// time (no active playout); never call mid-playout.
var ladderScratch = [];

function ladderEscapeWorks(b, koB, koActive, player, er, ec) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    copyBoard(probeBoard, b);
    copyBoard(probeKo, koB);
    var r0 = simTryPlace(probeBoard, probeKo, koActive, player, er, ec);
    if (!r0.success)
        return false;
    var koA = r0.koActive;
    for (var step = 0; step < 24; step++) {
        // Attacker to move: how is the running group (holds er,ec)?
        if (probeBoard[er * BOARD_SIZE + ec] !== player)
            return false;
        var dl = countLibertiesCapped(probeBoard, er, ec, player, 3);
        if (dl >= 3)
            return true;
        if (dl <= 0)
            return false;
        if (dl === 2) {
            var nlib = groupLiberties(probeBoard, er, ec, player, ladderScratch);
            var best = null, bestK = 99;
            for (var i = 0; i < nlib; i++) {
                copyBoard(playBoard, probeBoard);
                copyBoard(playKoBoard, probeKo);
                var ra = simTryPlace(playBoard, playKoBoard, koA, opp,
                                     ladderScratch[i].r, ladderScratch[i].c);
                if (!ra.success)
                    continue;
                if (playBoard[er * BOARD_SIZE + ec] !== player)
                    return false; // atari captures outright: chase over
                var k = countLibertiesCapped(playBoard, er, ec, player, 3);
                if (k < bestK) {
                    bestK = k;
                    best = ladderScratch[i];
                }
            }
            if (!best)
                return true; // no atari available: ladder broken
            var rb = simTryPlace(probeBoard, probeKo, koA, opp, best.r, best.c);
            if (!rb.success)
                return true;
            koA = rb.koActive;
        } else {
            // Single liberty: forced atari.
            var L = findLiberty(probeBoard, er, ec);
            if (L.r < 0)
                return false;
            var rc = simTryPlace(probeBoard, probeKo, koA, opp, L.r, L.c);
            if (!rc.success)
                return true; // attacker cannot atari: ladder broken
            koA = rc.koActive;
        }
        // Defender to move.
        if (probeBoard[er * BOARD_SIZE + ec] !== player)
            return false;
        var dd = countLibertiesCapped(probeBoard, er, ec, player, 3);
        if (dd >= 3)
            return true;
        if (dd === 0)
            return false;
        var n2 = groupLiberties(probeBoard, er, ec, player, ladderScratch);
        var bmv = null, bmk = -1;
        for (var j = 0; j < n2; j++) {
            copyBoard(playBoard, probeBoard);
            copyBoard(playKoBoard, probeKo);
            var rd = simTryPlace(playBoard, playKoBoard, koA, player,
                                 ladderScratch[j].r, ladderScratch[j].c);
            if (!rd.success)
                continue;
            var kk = countLibertiesCapped(playBoard, ladderScratch[j].r,
                                          ladderScratch[j].c, player, 4);
            if (kk > bmk) {
                bmk = kk;
                bmv = ladderScratch[j];
            }
        }
        if (!bmv)
            return false; // no legal extension: caught
        var re = simTryPlace(probeBoard, probeKo, koA, player, bmv.r, bmv.c);
        if (!re.success)
            return false;
        koA = re.koActive;
    }
    return true; // chase outran the board: edge/supporter breaks it
}

// Escape verdict (item B, sacrifice logic): 'ok' = play the escape,
// 'ladder' = chase is broken, don't throw stones after bad,
// 'dead' = the escaped group is dead on arrival (donate it, tenuki).
// Callers guarantee the move passed the cheap self-atari pre-filter.
function escapeVerdict(b, koB, koActive, player, er, ec) {
    var idx = boardIndex(er, ec);
    if (idx < 0 || b[idx] !== EMPTY)
        return 'dead';
    if (!ladderEscapeWorks(b, koB, koActive, player, er, ec))
        return 'ladder';
    copyBoard(probeBoard, b);
    copyBoard(probeKo, koB);
    var r = simTryPlace(probeBoard, probeKo, koActive, player, er, ec);
    if (!r.success)
        return 'dead';
    copyBoard(playBoard, probeBoard);
    lifeRemoveDead(playBoard, 6);
    if (playBoard[idx] === EMPTY)
        return 'dead';
    return 'ok';
}

// True when (r,c) touches a 1-lib group of `color`: own color means this
// move escapes (Tier-2 shape), enemy color means it captures/tactics.
// Used by the root veto (escapes face the ladder verdict) and the wall
// penalty (tactical points are exempt).
function hasAtariNeighbor(b, r, c, color) {
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    for (var d = 0; d < 4; d++) {
        var nidx = boardIndex(r + dr[d], c + dc[d]);
        if (nidx >= 0 && b[nidx] === color &&
            countLibertiesCapped(b, r + dr[d], c + dc[d], color, 2) === 1)
            return true;
    }
    return false;
}

// Distinct own groups orthogonally adjacent to (r,c): 0 isolated, 1
// extension, 2+ connection. Joining groups is the missing defensive
// signal (cut shapes die in pieces); floods are tiny, no simulation.
function connectCount(b, player, r, c) {
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    dfsGen++;
    var mark = dfsGen;
    var groups = 0;
    for (var d = 0; d < 4; d++) {
        var nr = r + dr[d], nc = c + dc[d];
        var nidx = boardIndex(nr, nc);
        if (nidx < 0 || b[nidx] !== player || dfsSeen[nidx] === mark)
            continue;
        groups++;
        if (groups >= 2)
            return groups;
        var stackR = [nr], stackC = [nc], top = 1;
        dfsSeen[nidx] = mark;
        while (top > 0) {
            top--;
            var cr = stackR[top], cc = stackC[top];
            for (var e = 0; e < 4; e++) {
                var mr = cr + dr[e], mc = cc + dc[e];
                var midx = boardIndex(mr, mc);
                if (midx < 0 || dfsSeen[midx] === mark || b[midx] !== player)
                    continue;
                dfsSeen[midx] = mark;
                stackR[top] = mr;
                stackC[top] = mc;
                top++;
            }
        }
    }
    return groups;
}

// True when (r,c) escapes an own 1-lib group (Tier-2 shape): any orthogonal
// own neighbor in atari. Used by the root veto to subject escapes to the
// ladder/sacrifice verdict.
function isEscapeMove(b, player, r, c) {
    return hasAtariNeighbor(b, r, c, player);
}

// Distinct small enclosed eye-spaces containing or adjacent to (r,c),
// capped at 3. Unlike eyeInteriorRegions (edge = open), the edge counts as
// a WALL here: edge eyes are real eyes, and the veto below must see them.
// A region counts when its bounded flood (cap 15) never touches an enemy
// stone. Big/open/contested space counts 0. Works pre-move ((r,c) empty)
// and post-move ((r,c) occupied) with the same semantics.
function eyeSpacesTotal(b, r, c, player) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    dfsGen++;
    var doneMark = dfsGen;
    var total = 0;
    var seeds = [[r, c]];
    for (var d = 0; d < 4; d++) {
        var ar = r + dr[d], ac = c + dc[d];
        if (boardIndex(ar, ac) >= 0)
            seeds.push([ar, ac]);
    }
    for (var s = 0; s < seeds.length; s++) {
        var sr = seeds[s][0], sc = seeds[s][1];
        var sidx = boardIndex(sr, sc);
        if (sidx < 0 || b[sidx] !== EMPTY || dfsSeen[sidx] === doneMark)
            continue;
        dfsGen++;
        var mark = dfsGen;
        var stackR = [sr], stackC = [sc], top = 1, n = 0;
        var contested = false;
        dfsSeen[sidx] = mark;
        while (top > 0 && n <= 15) {
            top--;
            var cr = stackR[top], cc = stackC[top];
            n++;
            for (var e = 0; e < 4; e++) {
                var nr = cr + dr[e], nc = cc + dc[e];
                var nidx = boardIndex(nr, nc);
                if (nidx < 0)
                    continue; // edge is a wall, not open space
                if (b[nidx] === opp) {
                    contested = true;
                    continue;
                }
                if (b[nidx] !== EMPTY || dfsSeen[nidx] === mark)
                    continue;
                dfsSeen[nidx] = mark;
                stackR[top] = nr;
                stackC[top] = nc;
                top++;
                if (top >= 81)
                    break;
            }
        }
        // Mark the whole flooded area done (interior or not: connected
        // space must not be recounted from another seed).
        // NOTE: cells of an over-cap flood are only partially marked; the
        // cap (15) plus done-marking keeps recounts bounded and verdicts
        // conservative (big space never counts as an eye).
        for (var m = 0; m < 81; m++) {
            if (dfsSeen[m] === mark)
                dfsSeen[m] = doneMark;
        }
        if (!contested && n <= 15) {
            total++;
            if (total >= 3)
                return total;
        }
    }
    return total;
}

// Eye-space verdict for candidate (r,c): 'kill' = the move reduces our eye
// potential below 2 (fills the last eye, or 2 -> 1). Capturing moves are
// exempt (eye-stealing kills are Tier-1's business). Dividers (1 -> 2),
// solidifies (equal), and open-board points (0 -> 0) all pass.
function eyeSpaceVerdict(b, koB, koActive, player, r, c) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    if (hasAtariNeighbor(b, r, c, opp))
        return 'ok'; // captures justify everything here
    var pre = eyeSpacesTotal(b, r, c, player);
    if (pre < 1)
        return 'ok';
    copyBoard(probeBoard, b);
    copyBoard(probeKo, koB);
    var res = simTryPlace(probeBoard, probeKo, koActive, player, r, c);
    if (!res.success)
        return 'ok'; // illegal is vetoed elsewhere
    var post = eyeSpacesTotal(probeBoard, r, c, player);
    if (post < pre && post < 2)
        return 'kill';
    return 'ok';
}

// True when (r,c) touches an enemy stone: only such points can threaten.
// Contact gate for the threat scan below.
function hasOppNeighbor(b, r, c, player) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    for (var d = 0; d < 4; d++) {
        var nidx = boardIndex(r + dr[d], c + dc[d]);
        if (nidx >= 0 && b[nidx] === opp)
            return true;
    }
    return false;
}

// True when the move puts some enemy group in atari (exactly one liberty)
// without capturing outright (kills are Tier-1's job, not mere threats).
// Callers gate on hasOppNeighbor (contact only).
function threatensAtari(b, koB, koActive, player, r, c) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    copyBoard(probeBoard, b);
    copyBoard(probeKo, koB);
    var res = simTryPlace(probeBoard, probeKo, koActive, player, r, c);
    if (!res.success)
        return false;
    var before = 0, after = 0, i;
    for (i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (b[i] === opp)
            before++;
        if (probeBoard[i] === opp)
            after++;
    }
    if (after < before)
        return false; // outright kill, not a threat
    for (var rr = 0; rr < BOARD_SIZE; rr++) {
        for (var cc = 0; cc < BOARD_SIZE; cc++) {
            if (probeBoard[rr * BOARD_SIZE + cc] === opp &&
                countLibertiesCapped(probeBoard, rr, cc, opp, 2) === 1)
                return true;
        }
    }
    return false;
}

// Raw legality (suicide/ko/occupied) on scratch. The veto's last line of
// defense: tree children can go stale mid-search as ko evolves, and exact
// generation predates... everything is re-verified here before replying.
function simLegal(b, koB, koActive, player, r, c) {
    if (boardIndex(r, c) < 0 || b[r * BOARD_SIZE + c] !== EMPTY)
        return false;
    copyBoard(probeBoard, b);
    copyBoard(probeKo, koB);
    return simTryPlace(probeBoard, probeKo, koActive, player, r, c).success;
}

// Enemy density around (r,c): opponent stones within Chebyshev distance 2
// (5x5 window minus center). High density + no tactics = walking into a
// wall: the classic pocket-march the locality bonus otherwise rewards.
function wallDensity(b, r, c, player) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    return sideDensity(b, r, c, opp);
}

// Own stones in the same window: local support. A 2-lib sidestep where
// friends >= enemies is a fight (allowed); into a bare wall it is a
// pocket-march (refused by Tier-3 defense).
function friendDensity(b, r, c, player) {
    return sideDensity(b, r, c, player);
}

function sideDensity(b, r, c, color) {
    var n = 0;
    for (var dr = -2; dr <= 2; dr++) {
        for (var dc = -2; dc <= 2; dc++) {
            if (dr === 0 && dc === 0)
                continue;
            var nidx = boardIndex(r + dr, c + dc);
            if (nidx >= 0 && b[nidx] === color)
                n++;
        }
    }
    return n;
}

// Tier-1 scan factored out: index into `moves` of a killing reply to a
// 1-lib enemy group, or -1. Used by the shared tactical finder and by the
// root forced-capture override.
function findAtariKill(b, player, moves) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    for (var r = 0; r < BOARD_SIZE; r++) {
        for (var c = 0; c < BOARD_SIZE; c++) {
            var idx = boardIndex(r, c);
            if (b[idx] === opp && countLibertiesCapped(b, r, c, opp, 2) === 1) {
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
// for speed). Returns the index into `moves`, or -1. When `info` is given,
// info.tier receives the winning tier (1/2/3) so expansion can rank the
// eye tier (item A) between urgent 1-lib tactics and Tier 3.
function findTacticalMove(b, koB, koActive, player, moves, lastR, lastC, info) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    var r, c, m;
    // Tiers 1+2 in ONE board pass: first 1-lib enemy liberty (kill) and
    // first safe 1-lib own escape, row-major order. Kill wins. This replaces
    // two full-board flood sweeps per step (the common no-atari case did
    // ~160 full group floods); capped counts + group memo make it one cheap
    // pass with identical verdicts.
    var killM = -1, escM = -1;
    for (r = 0; r < BOARD_SIZE && (killM < 0 || escM < 0); r++) {
        for (c = 0; c < BOARD_SIZE && (killM < 0 || escM < 0); c++) {
            var idx = boardIndex(r, c);
            var stone = b[idx];
            if (stone === EMPTY)
                continue;
            if (countLibertiesCapped(b, r, c, stone, 2) !== 1)
                continue;
            var lib = findLiberty(b, r, c);
            if (lib.r < 0)
                continue;
            var mi = findMoveIndex(moves, lib.r, lib.c);
            if (mi < 0)
                continue;
            if (stone === opp && killM < 0) {
                killM = mi;
            } else if (stone === player && escM < 0 &&
                       !putsSelfInAtari(b, koB, koActive, player,
                                        moves[mi].r, moves[mi].c) &&
                       // No eye-filling rescues (capturing eye-steals pass
                       // through: they take stones, Tier-1's business).
                       (!fillsOwnEye(b, moves[mi].r, moves[mi].c, player) ||
                        hasAtariNeighbor(b, moves[mi].r, moves[mi].c, opp)) &&
                       (!info || escapeVerdict(b, koB, koActive, player,
                                               moves[mi].r,
                                               moves[mi].c) === 'ok')) {
                // At expansion (info given), escapes face the ladder and
                // sacrifice verdicts: broken chases and dead rescues are
                // tenuki, never forced. In playouts (no info) keep the cheap
                // escape — the chase resolves by capture there, correctly
                // punishing ladder-following lines.
                escM = mi;
            }
        }
    }
    // Tier 1: immediate atari kill, but never a suicide throw-in: the
    // killing point itself must not end in atari (snapback/eye-steal).
    // Capturing kills that live on are still returned.
    if (killM >= 0) {
        copyBoard(probeBoard, b);
        copyBoard(probeKo, koB);
        var ktest = simTryPlace(probeBoard, probeKo, koActive, player,
                                moves[killM].r, moves[killM].c);
        if (ktest.success &&
            countLibertiesCapped(probeBoard, moves[killM].r, moves[killM].c,
                                 player, 2) > 1) {
            if (info)
                info.tier = 1;
            return killM;
        }
        // Suspicious kill (ends in atari): fall through to the escape found
        // above (if any), else Tier 3 and the scored fallback.
    }
    // Tier 2: escape our 1-lib group (found in the same pass).
    if (escM >= 0) {
        if (info)
            info.tier = 2;
        return escM;
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
                if (countLibertiesCapped(b, wr, wc, col, 3) !== 2)
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
                                if (countLibertiesCapped(probeBoard, nr, nc, opp, 2) === 1)
                                    inAtari = true;
                            }
                        }
                        var ol = countLibertiesCapped(probeBoard, libs[li].r,
                                                  libs[li].c, player, 2);
                        if ((captured || inAtari) && ol >= 1) {
                            if (info)
                                info.tier = 3;
                            return m;
                        }
                    } else {
                        // Defense of a 2-lib group: forced only when it
                        // matters (breakouts, captures, supported dragons —
                        // see below). Small-group sidesteps fall through to
                        // the scored fallback, so playouts stop
                        // force-marching 1-stone sacrifices into pockets.
                        // Finished-eye fills are refused outright (captures
                        // excepted, like rescues above).
                        var dlr = libs[li].r, dlc = libs[li].c;
                        var opp3 = (player === BLACK) ? WHITE : BLACK;
                        if (fillsOwnEye(b, dlr, dlc, player) &&
                            !hasAtariNeighbor(b, dlr, dlc, opp3))
                            continue;
                        copyBoard(probeBoard, b);
                        copyBoard(probeKo, koB);
                        var ds = simTryPlace(probeBoard, probeKo, koActive,
                                             player, libs[li].r, libs[li].c);
                        if (ds.success) {
                            var dd = countLibertiesCapped(probeBoard, libs[li].r,
                                                          libs[li].c, player, 3);
                            var okDef = false;
                            if (dd >= 3) {
                                okDef = true;
                            } else if (dd >= 1) {
                                var bo = 0, ao = 0;
                                var opp2 = (player === BLACK) ? WHITE : BLACK;
                                for (var bi = 0; bi < 81; bi++) {
                                    if (b[bi] === opp2)
                                        bo++;
                                    if (probeBoard[bi] === opp2)
                                        ao++;
                                }
                                if (ao < bo) {
                                    okDef = true; // capturing defense
                                } else if (dd === 2 &&
                                           groupSizeCapped(b, wr, wc, col, 4) >= 4 &&
                                           wallDensity(b, libs[li].r, libs[li].c,
                                                       player) <=
                                           2 + friendDensity(b, libs[li].r,
                                                             libs[li].c,
                                                             player)) {
                                    // Supported sidestep of a substantial
                                    // group (4+ stones): a fight, not a
                                    // pocket. Small groups fall through to
                                    // the scored fallback instead of
                                    // force-marching sacrifices into walls.
                                    okDef = true;
                                }
                            }
                            if (okDef) {
                                if (info)
                                    info.tier = 3;
                                return m;
                            }
                        }
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
// Score buffers are module scratch (no per-call allocation in the hot loop;
// no reentrancy: callees never reach here).
var scoredScratch = [];
var triedScratch = [];

function chooseScoredMove(b, koB, koActiveObj, player, moves, lastR, lastC) {
    var n = moves.length;
    var scores = scoredScratch;
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
    var eyeChecks = 0, patChecks = 0, dgrChecks = 0;
    for (i = 0; i < n; i++) {
        if (moves[i].r === MCTS_PASS_ROW || scores[i] < best - 40)
            continue;
        if (!doPen)
            continue;
        if (fillsOwnEye(b, moves[i].r, moves[i].c, player))
            scores[i] -= 100;
        else if (putsSelfInAtari(b, koB, koActiveObj.flag, player, moves[i].r, moves[i].c))
            scores[i] -= 60;
        else if (dgrChecks < 4 &&
                 wallDensity(b, moves[i].r, moves[i].c, player) >= 3 &&
                 !hasAtariNeighbor(b, moves[i].r, moves[i].c, player) &&
                 !hasAtariNeighbor(b, moves[i].r, moves[i].c,
                                   (player === BLACK) ? WHITE : BLACK)) {
            // Don't walk into walls: dense enemy zone with no tactics
            // (no rescue, no adjacent atari to capture). Escapes and kills
            // are exempt via the neighbor checks; eye/solidify points inside
            // OUR framework have own-density, not enemy, so they keep bonus.
            dgrChecks++;
            scores[i] -= 40;
        }
        else if (eyeChecks < 4) {
            // Item A: positive eye incentive (dividing point +40,
            // solidify +15). Contender-only and capped so playouts stay fast.
            eyeChecks++;
            var es = eyeMakeScore(b, koB, koActiveObj.flag, player,
                                  moves[i].r, moves[i].c);
            if (es >= 2)
                scores[i] += 40;
            else if (es === 1)
                scores[i] += 15;
        }
        // 3x3 patterns (Aya/MoGo): local shape only (near last move),
        // contender-only and capped. Triangle hits penalize bad shape.
        if (patChecks < 6 &&
            Math.abs(moves[i].r - lastR) + Math.abs(moves[i].c - lastC) <= 2) {
            patChecks++;
            var pb = patBonus(b, moves[i].r, moves[i].c, player);
            if (pb > 0)
                scores[i] += pb * 25;
            else if (pb < 0)
                scores[i] += pb * 30;
        }
        // Connection: joining 2+ own groups (+20). Extensions (1 group)
        // already score via locality; isolation needs nothing.
        if (connectCount(b, player, moves[i].r, moves[i].c) >= 2)
            scores[i] += 20;
    }
    // Try in score order until a placement succeeds (ko can still reject).
    var tried = triedScratch;
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

// ---- static life/death (JS port of src/c/logic/life.c) ----
// Same semantics as the estimate overlay: Benson unconditional life +
// confined-region dead removal. Used for root dead-on-arrival veto and
// terminal scoring so the search agrees with what the watch displays.
var LIFE_DEAD_REGION_MAX = 8;

function lifeBfsLabel(b, sr, sc, labels, id, emptyTarget) {
    var stackR = [sr], stackC = [sc], top = 1;
    labels[boardIndex(sr, sc)] = id;
    var match = b[boardIndex(sr, sc)];
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    while (top > 0) {
        top--;
        var r = stackR[top], c = stackC[top];
        for (var d = 0; d < 4; d++) {
            var nr = r + dr[d], nc = c + dc[d];
            var nidx = boardIndex(nr, nc);
            if (nidx < 0 || labels[nidx] >= 0)
                continue;
            var isEmpty = (b[nidx] === EMPTY);
            if (isEmpty !== emptyTarget)
                continue;
            if (!emptyTarget && b[nidx] !== match)
                continue;
            labels[nidx] = id;
            stackR[top] = nr;
            stackC[top] = nc;
            top++;
        }
    }
}

function lifeLabelAll(b, out) {
    var block = out.block, region = out.region;
    for (var i = 0; i < 81; i++) {
        block[i] = -1;
        region[i] = -1;
    }
    out.nblocks = 0;
    out.nregions = 0;
    out.blockColor = out.blockColor || [];
    for (var r = 0; r < BOARD_SIZE; r++) {
        for (var c = 0; c < BOARD_SIZE; c++) {
            var idx = boardIndex(r, c);
            if (b[idx] !== EMPTY) {
                if (block[idx] < 0) {
                    lifeBfsLabel(b, r, c, block, out.nblocks, false);
                    out.blockColor[out.nblocks] = b[idx];
                    out.nblocks++;
                }
            } else if (region[idx] < 0) {
                lifeBfsLabel(b, r, c, region, out.nregions, true);
                out.nregions++;
            }
        }
    }
}

function lifeRegionEnclosedBy(b, lab, r, color) {
    var found = false;
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    for (var i = 0; i < 81; i++) {
        if (lab.region[i] !== r)
            continue;
        var row = Math.floor(i / BOARD_SIZE), col = i % BOARD_SIZE;
        for (var d = 0; d < 4; d++) {
            var nidx = boardIndex(row + dr[d], col + dc[d]);
            if (nidx < 0 || b[nidx] === EMPTY)
                continue;
            if (b[nidx] !== color)
                return false;
            found = true;
        }
    }
    return found;
}

function lifeRegionSupported(b, lab, r, X) {
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    for (var i = 0; i < 81; i++) {
        if (lab.region[i] !== r)
            continue;
        var row = Math.floor(i / BOARD_SIZE), col = i % BOARD_SIZE;
        for (var d = 0; d < 4; d++) {
            var nidx = boardIndex(row + dr[d], col + dc[d]);
            if (nidx < 0 || b[nidx] === EMPTY)
                continue;
            if (!X[lab.block[nidx]])
                return false;
        }
    }
    return true;
}

function lifeRegionVitalFor(b, lab, r, blk) {
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    for (var i = 0; i < 81; i++) {
        if (lab.region[i] !== r)
            continue;
        var row = Math.floor(i / BOARD_SIZE), col = i % BOARD_SIZE;
        var touches = false;
        for (var d = 0; d < 4; d++) {
            var nidx = boardIndex(row + dr[d], col + dc[d]);
            if (nidx >= 0 && lab.block[nidx] === blk) {
                touches = true;
                break;
            }
        }
        if (!touches)
            return false;
    }
    return true;
}

function lifeBensonForColor(b, lab, color, aliveOut) {
    var X = [], R = [], i, blk, r;
    for (i = 0; i < lab.nblocks; i++)
        X[i] = (lab.blockColor[i] === color);
    for (i = 0; i < lab.nregions; i++)
        R[i] = lifeRegionEnclosedBy(b, lab, i, color);
    var changed = true;
    while (changed) {
        changed = false;
        for (blk = 0; blk < lab.nblocks; blk++) {
            if (!X[blk])
                continue;
            var vital = 0;
            for (r = 0; r < lab.nregions; r++) {
                if (R[r] && lifeRegionVitalFor(b, lab, r, blk)) {
                    vital++;
                    if (vital >= 2)
                        break;
                }
            }
            if (vital < 2) {
                X[blk] = false;
                changed = true;
            }
        }
        for (r = 0; r < lab.nregions; r++) {
            if (R[r] && !lifeRegionSupported(b, lab, r, X)) {
                R[r] = false;
                changed = true;
            }
        }
    }
    for (i = 0; i < 81; i++) {
        if (lab.block[i] >= 0 && X[lab.block[i]])
            aliveOut[i] = true;
    }
}

function lifeRegionSize(lab, r) {
    var n = 0;
    for (var i = 0; i < 81; i++) {
        if (lab.region[i] === r)
            n++;
    }
    return n;
}

function lifeBlockConfinedDead(b, lab, blk, opp) {
    var seen = {};
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    for (var i = 0; i < 81; i++) {
        if (lab.block[i] !== blk)
            continue;
        var row = Math.floor(i / BOARD_SIZE), col = i % BOARD_SIZE;
        for (var d = 0; d < 4; d++) {
            var nidx = boardIndex(row + dr[d], col + dc[d]);
            if (nidx < 0 || b[nidx] !== EMPTY)
                continue;
            var r = lab.region[nidx];
            if (seen[r])
                continue;
            seen[r] = true;
            if (lifeRegionSize(lab, r) > LIFE_DEAD_REGION_MAX)
                return false;
            var oppFound = false;
            for (var j = 0; j < 81; j++) {
                if (lab.region[j] !== r)
                    continue;
                var jr = Math.floor(j / BOARD_SIZE), jc = j % BOARD_SIZE;
                for (var e = 0; e < 4; e++) {
                    var kidx = boardIndex(jr + dr[e], jc + dc[e]);
                    if (kidx < 0 || b[kidx] === EMPTY)
                        continue;
                    if (lab.block[kidx] === blk)
                        continue;
                    if (b[kidx] !== opp)
                        return false;
                    oppFound = true;
                }
            }
            if (!oppFound)
                return false;
        }
    }
    return true;
}

// In-place dead removal on `w` (81-array), up to maxRounds. Returns count.
function lifeRemoveDead(w, maxRounds) {
    var total = 0;
    var lab = {block: [], region: [], blockColor: [], nblocks: 0, nregions: 0};
    for (var round = 0; round < maxRounds; round++) {
        lifeLabelAll(w, lab);
        var alive = [];
        for (var i = 0; i < 81; i++)
            alive[i] = false;
        lifeBensonForColor(w, lab, BLACK, alive);
        lifeBensonForColor(w, lab, WHITE, alive);
        var kill = [], nkill = 0, blk;
        for (blk = 0; blk < lab.nblocks; blk++) {
            var isAlive = false;
            for (var k = 0; k < 81; k++) {
                if (lab.block[k] === blk && alive[k]) {
                    isAlive = true;
                    break;
                }
            }
            if (isAlive)
                continue;
            var opp = (lab.blockColor[blk] === BLACK) ? WHITE : BLACK;
            if (lifeBlockConfinedDead(w, lab, blk, opp)) {
                kill[blk] = true;
                nkill++;
            }
        }
        if (nkill === 0)
            break;
        for (var m = 0; m < 81; m++) {
            if (lab.block[m] >= 0 && kill[lab.block[m]]) {
                w[m] = EMPTY;
                total++;
            }
        }
        boardGen++;
    }
    return total;
}

// Benson alive-stone count for `color` on `b` (read-only): label once,
// run Benson for the color, count alive cells. Single-color pass keeps
// expansion-time cost to one labeling instead of two.
function lifeAliveCount(b, color) {
    var lab = {block: [], region: [], blockColor: [], nblocks: 0, nregions: 0};
    lifeLabelAll(b, lab);
    var alive = [];
    for (var i = 0; i < 81; i++)
        alive[i] = false;
    lifeBensonForColor(b, lab, color, alive);
    var n = 0;
    for (var k = 0; k < 81; k++) {
        if (alive[k])
            n++;
    }
    return n;
}

// True when the candidate stone is dead on arrival under overlay semantics:
// simulate (with captures) on probeBoard, run full dead removal on a copy,
// and see if the new stone is gone. Illegal moves return false.
function lifeStoneDeadOnArrival(b, koB, koActive, player, r, c) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    var idx = boardIndex(r, c);
    if (idx < 0 || b[idx] !== EMPTY)
        return false;
    copyBoard(probeBoard, b);
    copyBoard(probeKo, koB);
    var res = simTryPlace(probeBoard, probeKo, koActive, player, r, c);
    if (!res.success)
        return false;
    copyBoard(playBoard, probeBoard);
    // 6 rounds here (C uses 10): the watch re-verdicts every AI move with
    // the full 10-round analysis as backstop, so the phone need only catch
    // the clear cases fast.
    lifeRemoveDead(playBoard, 6);
    return playBoard[idx] === EMPTY;
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
            if (countLibertiesCapped(probeBoard, r, c, col, 2) <= 1)
                removeGroupOn(probeBoard, r, c, col);
        }
    }
    // Settled terminals: full overlay-equivalent dead removal so 2+-lib
    // dead invaders don't score. Gated on empties (open playout ends are
    // noisy and the analysis costs) and capped at 2 rounds (C uses 10;
    // the watch re-verdicts with 10 as backstop, and the cheap 1-lib strip
    // above already catches the common case).
    var empties = 0, e;
    for (e = 0; e < 81; e++) {
        if (probeBoard[e] === EMPTY)
            empties++;
    }
    if (empties <= 32)
        lifeRemoveDead(probeBoard, 2);
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
    // Empties first: gates AMAF reuse (item E), pass prior and Benson prior.
    var empties0 = 0;
    for (var e0 = 0; e0 < BOARD_SIZE * BOARD_SIZE; e0++) {
        if (gBoard[e0] === EMPTY)
            empties0++;
    }
    initPools(empties0 >= 81);

    rngState = (12345 + requestSeq * 7919) | 0;
    requestSeq++;

    // Fullness gate for the pass prior (see above).
    var empties = 0;
    for (var ei = 0; ei < BOARD_SIZE * BOARD_SIZE; ei++) {
        if (gBoard[ei] === EMPTY)
            empties++;
    }
    passPrior = (empties <= ENDGAME_EMPTIES) ? 0.5 : PASS_OPEN_PRIOR;

    // Benson gate is position-dependent: compute for both paths (fresh and
    // reused expansion use it below).
    var bensonPriorOn = (empties <= 50);

    // Persistent tree (item 5): continue the saved line when the new
    // position matches saved reply + one opponent action. Otherwise reset
    // the pool and expand fresh below.
    var reuseRoot = tryReuseTree(currentPlayer);
    if (reuseRoot === MCTS_NO_NODE) {
        nodePool = [];
        nodePoolUsed = 0;
        rootNode = allocNode(MCTS_PASS_ROW, MCTS_PASS_COL, EMPTY);
    } else {
        rootNode = reuseRoot;
        console.log('pkjs: tree reused, pool=' + nodePoolUsed);
    }

    // Expand ALL root children up front (fresh trees only; a reused tree
    // already has its children with carried statistics). Without this the
    // selection loop only ever descends through the single first-expanded
    // child, so the tree grows as one degenerate line and the reply is just
    // the first shuffled move (usually an edge point) instead of a searched
    // choice. With real siblings at the root, UCT + progressive shape bias
    // actually compare all opening moves by visits.
    if (reuseRoot === MCTS_NO_NODE) {
    copyBoard(simBoard, gBoard);
    copyBoard(simKoBoard, gKoBoard);
    simKoActive = gKoActive;
    var openingMoves = getLegalMovesOn(simBoard, simKoBoard, simKoActive, currentPlayer);
    // Item E: prune tree breadth to local stones + star points (playouts
    // stay unpruned). Opening (<6 stones) keeps full breadth for tenuki.
    openingMoves = pruneTreeMoves(openingMoves, simBoard);
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

    // Benson alive prior (item C) + eye prior (item A): rank root children
    // by post-move alive count for the mover, plus a bonus for eye-dividing
    // points. Benson gated on empties (open boards have nothing alive) and
    // capped at 40 children (each run is a full static analysis; the eye
    // check below is one simulation and always runs for every child).
    // Siblings share the pre-move position, so alive-after ordering equals
    // alive-delta.
    var bensonRuns = 0;
    {
        var rc = root.firstChild;
        while (rc !== MCTS_NO_NODE && rc < MCTS_POOL_SIZE) {
            var rcn = nodePool[rc];
            if (rcn.moveRow !== MCTS_PASS_ROW) {
                copyBoard(probeBoard, gBoard);
                copyBoard(probeKo, gKoBoard);
                var rres = simTryPlace(probeBoard, probeKo, gKoActive,
                                        currentPlayer, rcn.moveRow, rcn.moveCol);
                if (rres.success) {
                    if (bensonPriorOn && bensonRuns < 40) {
                        bensonRuns++;
                        rcn.prior = lifeAliveCount(probeBoard, currentPlayer);
                    }
                    var res_ = eyeMakeScore(gBoard, gKoBoard, gKoActive,
                                            currentPlayer, rcn.moveRow,
                                            rcn.moveCol);
                    if (res_ >= 2)
                        rcn.eye = 12;
                    else if (res_ === 1)
                        rcn.eye = 3;
                    // 3x3 patterns: local shape only (near last move).
                    if (Math.abs(rcn.moveRow - lastRow) +
                        Math.abs(rcn.moveCol - lastCol) <= 2)
                        rcn.pat = patBonus(gBoard, rcn.moveRow, rcn.moveCol,
                                           currentPlayer);
                    // Escape urgency, verdict-gated (broken/dead rescues
                    // must not outrank tenuki).
                    if (isEscapeMove(gBoard, currentPlayer, rcn.moveRow,
                                     rcn.moveCol) &&
                        escapeVerdict(gBoard, gKoBoard, gKoActive,
                                      currentPlayer, rcn.moveRow,
                                      rcn.moveCol) === 'ok') {
                        rcn.urg = 1;
                    }
                    // Atari threat, contact-gated (open-board shape moves
                    // never threaten).
                    if (hasOppNeighbor(gBoard, rcn.moveRow, rcn.moveCol,
                                       currentPlayer) &&
                        threatensAtari(gBoard, gKoBoard, gKoActive,
                                       currentPlayer, rcn.moveRow,
                                       rcn.moveCol))
                        rcn.thr = 1;
                    // Connection (cheap floods, no simulation: always).
                    if (connectCount(gBoard, currentPlayer, rcn.moveRow,
                                     rcn.moveCol) >= 2)
                        rcn.con = 1;
                    // Contested connection: joining next to enemy stones,
                    // and the joint lives (else it is gluing corpses).
                    if (rcn.con === 1 &&
                        wallDensity(gBoard, rcn.moveRow, rcn.moveCol,
                                    currentPlayer) >= 1 &&
                        !lifeStoneDeadOnArrival(gBoard, gKoBoard, gKoActive,
                                                currentPlayer, rcn.moveRow,
                                                rcn.moveCol))
                        rcn.cut = 1;
                }
            }
            rc = rcn.nextSibling;
        }
    }
    } // end fresh-only root expansion + priors

    var startTime = Date.now();
    var iter = 0;
    for (iter = 0; iter < iterations; iter++) {
        // Time-boxed: stop early so the reply beats the watch-side timeout.
        // Checked every 8 iterations: single iterations got expensive (Benson
        // priors, RAVE scans), so a 16-cadence could overshoot the budget.
        if ((iter & 7) === 0 && iter > 0) {
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
        mctsPathQ[mctsPathLen] = simPlayer;
        mctsPathHist[mctsPathLen] = playHistN;
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

            // Apply the chosen child. A stale-illegal child (ko ban that
            // materialized mid-descent as ko state evolved — rare, since
            // move generation already filters ko) must NEVER flip the turn
            // without moving: stop the descent here and play out from the
            // current position instead. No bans are recorded (ko lifts),
            // so future iterations re-evaluate the child normally.
            var bc = nodePool[bestChild];
            var bcApplied = false;
            if (bc.moveRow === MCTS_PASS_ROW) {
                simPasses++;
                bcApplied = true;
            } else {
                simPasses = 0;
                var mover = simPlayer;
                var result = simTryPlace(simBoard, simKoBoard, simKoActive,
                                         simPlayer, bc.moveRow, bc.moveCol);
                simKoActive = result.koActive;
                if (result.success) {
                    recordHistMove(bc.moveRow, bc.moveCol, mover);
                    bcApplied = true;
                }
            }
            if (!bcApplied)
                break;
            simLastRow = bc.moveRow;
            simLastCol = bc.moveCol;
            simPlayer = (simPlayer === BLACK) ? WHITE : BLACK;

            mctsPath[mctsPathLen] = bestChild;
            mctsPathQ[mctsPathLen] = simPlayer;
            mctsPathHist[mctsPathLen] = playHistN;
            mctsPathLen++;
            nodeIdx = bestChild;
        }

        var leaf = nodePool[nodeIdx];
        var moves = getLegalMovesOn(simBoard, simKoBoard, simKoActive, simPlayer);
        // Item E: prune expansion breadth to the fight zone (playouts and
        // the root forced-capture check keep full breadth).
        moves = pruneTreeMoves(moves, simBoard);

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
        // Item A sits between: urgent 1-lib tactics (tiers 1-2) win, an
        // eye-dividing point beats Tier 3 and the default.
        var tactInfo = {};
        var tactIdx = findTacticalMove(simBoard, simKoBoard, simKoActive,
                                       simPlayer, moves, simLastRow,
                                       simLastCol, tactInfo);
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
        if (!tactInfo.tier || tactInfo.tier >= 3) {
            var eyeIdx = findEyeMove(simBoard, simKoBoard, simKoActive,
                                     simPlayer, moves);
            if (eyeIdx >= 0) {
                var eyeAlready = false;
                var ech = leaf.firstChild;
                while (ech !== MCTS_NO_NODE && ech < MCTS_POOL_SIZE) {
                    var ecn = nodePool[ech];
                    if (ecn.moveRow === moves[eyeIdx].r &&
                        ecn.moveCol === moves[eyeIdx].c) {
                        eyeAlready = true;
                        break;
                    }
                    ech = ecn.nextSibling;
                }
                if (!eyeAlready)
                    unexpandedIdx = eyeIdx;
            }
        }

        if (unexpandedIdx >= 0) {
            // Verify BEFORE allocating: an illegal child (ko ban evolved
            // mid-search) must never enter the tree. Pass verifies trivially.
            var expRow = moves[unexpandedIdx].r, expCol = moves[unexpandedIdx].c;
            var expMover = simPlayer;
            // Priors need the PRE-move board: compute before simulating.
            var ees = 0, eps = 0, eurg = 0, ethr = 0, ecn = 0, ecut = 0;
            var expRes = null, expOk = (expRow === MCTS_PASS_ROW);
            if (!expOk) {
                ees = eyeMakeScore(simBoard, simKoBoard,
                                   simKoActive, expMover, expRow, expCol);
                // 3x3 pattern prior, same PRE-move board, near the
                // previous last move only (local shape language).
                if (Math.abs(expRow - simLastRow) +
                    Math.abs(expCol - simLastCol) <= 2)
                    eps = patBonus(simBoard, expRow, expCol, expMover);
                // Escape urgency on the PRE-move board (verdict sims
                // internally; must run before simTryPlace).
                if (isEscapeMove(simBoard, expMover, expRow, expCol) &&
                    escapeVerdict(simBoard, simKoBoard, simKoActive,
                                  expMover, expRow, expCol) === 'ok')
                    eurg = 1;
                // Atari threat, contact-gated.
                if (hasOppNeighbor(simBoard, expRow, expCol, expMover) &&
                    threatensAtari(simBoard, simKoBoard, simKoActive,
                                   expMover, expRow, expCol))
                    ethr = 1;
                if (connectCount(simBoard, expMover, expRow, expCol) >= 2) {
                    ecn = 1;
                    if (wallDensity(simBoard, expRow, expCol, expMover) >= 1 &&
                        !lifeStoneDeadOnArrival(simBoard, simKoBoard, simKoActive,
                                                expMover, expRow, expCol))
                        ecut = 1;
                }
                expRes = simTryPlace(simBoard, simKoBoard, simKoActive,
                                      simPlayer, expRow, expCol);
                expOk = expRes.success;
            }
            var newChild = expOk ? allocNode(expRow, expCol, simPlayer)
                                 : MCTS_NO_NODE;
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

                if (expRow === MCTS_PASS_ROW) {
                    simPasses++;
                } else {
                    simPasses = 0;
                    simKoActive = expRes.koActive;
                    recordHistMove(expRow, expCol, expMover);
                    // Benson gradient: cache post-move alive count for
                    // the mover; uct() reads it as prior. Expansion-only
                    // so the hot selection loop stays cheap.
                    if (bensonPriorOn)
                        nodePool[newChild].prior =
                            lifeAliveCount(simBoard, expMover);
                    if (ees >= 2)
                        nodePool[newChild].eye = 12;
                    else if (ees === 1)
                        nodePool[newChild].eye = 3;
                    nodePool[newChild].pat = eps;
                    nodePool[newChild].urg = eurg;
                    nodePool[newChild].thr = ethr;
                    nodePool[newChild].con = ecn;
                    nodePool[newChild].cut = ecut;
                    simLastRow = expRow;
                    simLastCol = expCol;
                }
                simPlayer = (simPlayer === BLACK) ? WHITE : BLACK;

                if (mctsPathLen < 199) {
                    mctsPath[mctsPathLen] = newChild;
                    mctsPathQ[mctsPathLen] = simPlayer;
                    mctsPathHist[mctsPathLen] = playHistN;
                    mctsPathLen++;
                    nodeIdx = newChild;
                }
            }
        }

        var resultVal = mctsPlayout(simPlayer);
        updateAmaf(resultVal);
        var blackWon = (resultVal === 1);
        // Precompute history keys once per backprop for the RAVE scan.
        var histKey = [];
        for (var hk = 0; hk < playHistN; hk++)
            histKey[hk] = playHistR[hk] * 9 + playHistC[hk];
        for (var i = mctsPathLen - 1; i >= 0; i--) {
            var n = nodePool[mctsPath[i]];
            n.visits++;
            if (n.player === BLACK && blackWon) {
                n.wins++;
            } else if (n.player === WHITE && !blackWon) {
                n.wins++;
            }
            // Per-node RAVE (Aya-style): stone children played later by the
            // side to move here share this outcome. History tail capped at
            // 48 entries for phone speed.
            var Q = mctsPathQ[i];
            var qw = (Q === BLACK) === blackWon;
            var tailFrom = mctsPathHist[i];
            if (tailFrom < playHistN - 48)
                tailFrom = playHistN - 48;
            var chR = n.firstChild;
            while (chR !== MCTS_NO_NODE && chR < MCTS_POOL_SIZE) {
                var cnR = nodePool[chR];
                if (cnR.moveRow !== MCTS_PASS_ROW) {
                    var want = cnR.moveRow * 9 + cnR.moveCol;
                    for (var hh = tailFrom; hh < playHistN; hh++) {
                        if (playHistP[hh] === Q && histKey[hh] === want) {
                            cnR.raveV++;
                            if (qw)
                                cnR.raveW++;
                            break;
                        }
                    }
                }
                chR = cnR.nextSibling;
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
// Eye-dividers outrank plain shape here (a starving engine should at
// least save its groups); node.eye is already cached from the root loop.
// Occupied points are skipped: on a reused tree, children can go stale as
// stones land (the veto re-verifies legality on top of this).
function bestPriorStone() {
    var root = nodePool[rootNode];
    var best = MCTS_NO_NODE;
    var bestShape = -99999;
    var child = root.firstChild;
    while (child !== MCTS_NO_NODE && child < MCTS_POOL_SIZE) {
        var c = nodePool[child];
        if (c.moveRow !== MCTS_PASS_ROW &&
            gBoard[c.moveRow * BOARD_SIZE + c.moveCol] === EMPTY) {
            var s = shapeScore(c.moveRow, c.moveCol) + (c.eye || 0) * 500 +
                (c.pat || 0) * 200 + (c.urg ? 1000 : 0) + (c.thr ? 400 : 0) +
                (c.con ? 200 : 0) + (c.cut ? 800 : 0);
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

// ---- fuseki book, moves 2-9 (item C) ----
// After the 2-move canonical opening, play pro-style 9x9 fuseki instead of
// improvising with center-seeking noise: enclose approached 4-4 corners,
// otherwise take the emptiest quadrant's star point. Strict gates: exact
// stone count (a capture means fighting started), no orthogonal B-W contact
// anywhere (contact means fighting started), replies verified empty+legal.
// Returns [r, c] or null (→ full search).
var FUSEKI_CORNERS44 = [[3, 3], [3, 5], [5, 3], [5, 5]];
var FUSEKI_PTS = [[2, 2], [2, 6], [6, 2], [6, 6],
                  [2, 3], [2, 5], [3, 2], [3, 6],
                  [5, 2], [5, 6], [6, 3], [6, 5],
                  [2, 4], [4, 2], [4, 6], [6, 4], [4, 4]];

function fusekiContact(b) {
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        var col = b[i];
        if (col !== BLACK && col !== WHITE)
            continue;
        var r = Math.floor(i / BOARD_SIZE), c = i % BOARD_SIZE;
        for (var d = 0; d < 4; d++) {
            var nidx = boardIndex(r + dr[d], c + dc[d]);
            if (nidx >= 0 && b[nidx] !== EMPTY && b[nidx] !== col)
                return true;
        }
    }
    return false;
}

function fusekiLegal(b, koB, koActive, player, r, c) {
    if (boardIndex(r, c) < 0 || b[r * BOARD_SIZE + c] !== EMPTY)
        return false;
    copyBoard(probeBoard, b);
    copyBoard(probeKo, koB);
    return simTryPlace(probeBoard, probeKo, koActive, player, r, c).success;
}

// Standard 4-4 enclosure vs a cardinal 3-space approach: the approach along
// one axis is answered by extending two points along the other (take the
// other side, no contact). E.g. ours (3,3) + approach (3,5) → (5,3).
function fusekiEnclosure(b, koB, koActive, player, lastR, lastC) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    if (boardIndex(lastR, lastC) < 0 || b[lastR * BOARD_SIZE + lastC] !== opp)
        return null;
    for (var s = 0; s < FUSEKI_CORNERS44.length; s++) {
        var sr = FUSEKI_CORNERS44[s][0], sc = FUSEKI_CORNERS44[s][1];
        if (b[sr * BOARD_SIZE + sc] !== player)
            continue;
        var rr = -1, cc = -1;
        if (lastR === sr && Math.abs(lastC - sc) === 2) {
            rr = sr + 2;
            cc = sc; // east/west approach → extend south
        } else if (lastC === sc && Math.abs(lastR - sr) === 2) {
            rr = sr;
            cc = sc + 2; // north/south approach → extend east
        } else {
            continue;
        }
        if (fusekiLegal(b, koB, koActive, player, rr, cc))
            return [rr, cc];
        return null;
    }
    return null;
}

function openingFusekiMove(b, koB, koActive, movesMade, lastR, lastC, player) {
    if (movesMade < 2 || movesMade > 9)
        return null;
    var stones = 0, i;
    for (i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (b[i] !== EMPTY)
            stones++;
    }
    if (stones !== movesMade)
        return null; // a capture happened: fighting, not fuseki
    if (fusekiContact(b))
        return null; // contact happened: fighting, not fuseki
    var enc = fusekiEnclosure(b, koB, koActive, player, lastR, lastC);
    if (enc)
        return enc;
    // Emptiest quadrant: star point maximizing min Manhattan distance to
    // any stone; list order breaks ties deterministically.
    var best = null, bestD = -1;
    for (var p = 0; p < FUSEKI_PTS.length; p++) {
        var pr = FUSEKI_PTS[p][0], pc = FUSEKI_PTS[p][1];
        if (b[pr * BOARD_SIZE + pc] !== EMPTY)
            continue;
        var mind = 99;
        for (i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
            if (b[i] === EMPTY)
                continue;
            var d = Math.abs(Math.floor(i / BOARD_SIZE) - pr) +
                    Math.abs((i % BOARD_SIZE) - pc);
            if (d < mind)
                mind = d;
        }
        if (mind > bestD) {
            bestD = mind;
            best = [pr, pc];
        }
    }
    if (best && fusekiLegal(b, koB, koActive, player, best[0], best[1]))
        return best;
    return null;
}
// ---- pondering (think on the human's time) ----
// After replying, the phone would idle for the human's whole think.
// Instead run background playouts from the post-move position: no tree is
// kept, but every playout feeds the persistent global AMAF, which the next
// real search reads as its weak long-term memory. Sliced via setTimeout
// so the event loop stays responsive; any new request aborts instantly.
// Disabled under PEBBLE_NO_PONDER=1 (unit tests: keeps them hermetic).
var PONDER_OFF = (typeof process !== 'undefined' && process.env &&
                  process.env.PEBBLE_NO_PONDER === '1');
var PONDER_MAX_SLICES = 12;
var PONDER_PER_SLICE = 5;
var ponderOn = false;
var ponderSlices = 0;
var ponderBoard = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
var ponderKo = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
var ponderKoActive = false;
var ponderPlayer = EMPTY;

function ponderSlice() {
    if (!ponderOn)
        return;
    copyBoard(simBoard, ponderBoard);
    copyBoard(simKoBoard, ponderKo);
    simKoActive = ponderKoActive;
    for (var k = 0; k < PONDER_PER_SLICE; k++) {
        playHistN = 0;
        var res = mctsPlayout(ponderPlayer);
        updateAmaf(res);
    }
    ponderSlices++;
    if (ponderSlices < PONDER_MAX_SLICES && ponderOn) {
        try {
            setTimeout(ponderSlice, 0);
        } catch (e) {
            ponderOn = false;
        }
    } else {
        ponderOn = false;
    }
}

// Snapshot the post-move position and start background pondering. Only for
// real replies (stone/pass); error paths skip. Never throws: pondering is
// best-effort and must not endanger the reply guarantee.
function ponderStart(moveRow, moveCol, isPass, player) {
    if (PONDER_OFF || typeof setTimeout !== 'function')
        return;
    try {
        ponderOn = false;
        copyBoard(simBoard, gBoard);
        copyBoard(simKoBoard, gKoBoard);
        simKoActive = gKoActive;
        if (isPass === 0) {
            var res = simTryPlace(simBoard, simKoBoard, simKoActive, player,
                                  moveRow, moveCol);
            if (!res.success)
                return;
            simKoActive = res.koActive;
        }
        copyBoard(ponderBoard, simBoard);
        copyBoard(ponderKo, simKoBoard);
        ponderKoActive = simKoActive;
        ponderPlayer = (player === BLACK) ? WHITE : BLACK;
        ponderSlices = 0;
        ponderOn = true;
        setTimeout(ponderSlice, 0);
    } catch (e) {
        ponderOn = false;
    }
}

// ---- persistent tree across moves (item 5) ----
// The search tree (visits/wins/RAVE) survives between requests when the new
// position continues the old line: our saved reply M applied to the saved
// position must differ from the new position by exactly the opponent's
// single action H (stone or pass). Anything else (new game, unexpected
// board) falls back to a fresh tree. Pool pressure (>8000 nodes) also
// forces fresh. Reused subtrees get visits/wins halved (like AMAF decay)
// so old plans guide without starving new replies; position-dependent
// priors (Benson/eye/pattern/urgency/threat/connection) are zeroed and
// recomputed, since they belong to the old position.
var savedValid = false;
var savedRoot = MCTS_NO_NODE;
var savedBoardBefore = [];
var savedKoBefore = [];
var savedKoActive = false;
var savedReplyR = -1, savedReplyC = -1, savedReplyPass = false;
var savedPlayer = EMPTY;
var reqPlayer = EMPTY;

function saveReplyState(moveRow, moveCol, isPass) {
    if (isPass === 2) {
        savedValid = false; // error: no move to continue from
        return;
    }
    savedBoardBefore = gBoard.slice();
    savedKoBefore = gKoBoard.slice();
    savedKoActive = gKoActive;
    savedReplyR = moveRow;
    savedReplyC = moveCol;
    savedReplyPass = (moveRow === MCTS_PASS_ROW && moveCol === MCTS_PASS_COL) || isPass === 1;
    savedPlayer = reqPlayer;
    savedRoot = rootNode;
    savedValid = (rootNode !== MCTS_NO_NODE);
}

// Halve visits/wins/RAVE over the kept subtree (fresh exploration room)
// and zero position-dependent priors (recomputed for the new position).
// Iterative stack walk from newRoot; dead (unreachable) nodes are simply
// abandoned (pool pressure triggers a full reset instead of GC).
function decaySubtree(newRoot) {
    var stack = [newRoot];
    var seenMark = ++dfsGen;
    // NOTE: reuses dfsSeen with its own generation; sequential use only,
    // called between searches (no active floods).
    dfsSeen[newRoot] = seenMark;
    while (stack.length > 0) {
        var idx = stack.pop();
        var nd = nodePool[idx];
        nd.visits = Math.floor(nd.visits / 2);
        nd.wins = Math.floor(nd.wins / 2);
        nd.raveV = Math.floor((nd.raveV || 0) / 2);
        nd.raveW = Math.floor((nd.raveW || 0) / 2);
        nd.prior = 0;
        nd.eye = 0;
        nd.pat = 0;
        nd.urg = 0;
        nd.thr = 0;
        nd.con = 0;
        var ch = nd.firstChild;
        while (ch !== MCTS_NO_NODE && ch < MCTS_POOL_SIZE) {
            if (dfsSeen[ch] !== seenMark) {
                dfsSeen[ch] = seenMark;
                stack.push(ch);
            }
            ch = nodePool[ch].nextSibling;
        }
    }
}

// Returns the reused root node, or MCTS_NO_NODE for a fresh tree.
// Two rhythms share this matcher:
//  single-color (engine = one side): our reply M, then their action H,
//    then OUR turn again  -> root at H (our turn).
//  both-colors (AI-vs-AI / match tool): our reply M, then THEIR turn on
//    the unchanged board -> root at M (their turn).
// Anything else (new game, mismatch, pool pressure) goes fresh.
function tryReuseTree(currentPlayer) {
    if (!savedValid || savedRoot === MCTS_NO_NODE || savedRoot >= nodePoolUsed)
        return MCTS_NO_NODE;
    if (savedPlayer !== BLACK && savedPlayer !== WHITE)
        return MCTS_NO_NODE;
    if (nodePoolUsed > 8000)
        return MCTS_NO_NODE;
    var oppSP = (savedPlayer === BLACK) ? WHITE : BLACK;
    // Reconstruct P1 = saved position + our reply applied.
    copyBoard(probeBoard, savedBoardBefore);
    copyBoard(probeKo, savedKoBefore);
    if (!savedReplyPass) {
        var pr = simTryPlace(probeBoard, probeKo, savedKoActive, savedPlayer,
                             savedReplyR, savedReplyC);
        if (!pr.success)
            return MCTS_NO_NODE;
    }
    // Diff P1 vs the new position: added stones must be the side that moved
    // since our reply (oppSP); removals only our stones (their captures).
    var hR = -1, hC = -1, hPass = true, bad = false, removed = 0;
    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (probeBoard[i] === gBoard[i])
            continue;
        var r = Math.floor(i / BOARD_SIZE), c = i % BOARD_SIZE;
        if (probeBoard[i] === EMPTY && gBoard[i] === oppSP) {
            if (!hPass) {
                bad = true;
                break;
            }
            hPass = false;
            hR = r;
            hC = c;
        } else if (probeBoard[i] === savedPlayer && gBoard[i] === EMPTY) {
            removed++;
            continue; // our stone captured by their move
        } else {
            bad = true;
            break;
        }
    }
    if (bad)
        return MCTS_NO_NODE;
    // Walk savedRoot -> M (our reply, by savedPlayer).
    var mNode = MCTS_NO_NODE;
    var ch = nodePool[savedRoot].firstChild;
    while (ch !== MCTS_NO_NODE && ch < MCTS_POOL_SIZE) {
        var cn = nodePool[ch];
        var cmPass = (cn.moveRow === MCTS_PASS_ROW);
        if (cmPass === savedReplyPass &&
            (cmPass || (cn.moveRow === savedReplyR && cn.moveCol === savedReplyC)) &&
            cn.player === savedPlayer) {
            mNode = ch;
            break;
        }
        ch = cn.nextSibling;
    }
    if (mNode === MCTS_NO_NODE)
        return MCTS_NO_NODE;
    if (hPass && removed === 0) {
        // No action since our reply (P1 == current board).
        if (currentPlayer === oppSP) {
            // Both-colors rhythm: their turn on P1 -> root at M itself.
            decaySubtree(mNode);
            return mNode;
        }
        // Single-color rhythm: our turn again means they passed.
        // Need the pass child (by the passer, oppSP) under M.
        if (currentPlayer === savedPlayer) {
            var hpNode = MCTS_NO_NODE;
            var hch = nodePool[mNode].firstChild;
            while (hch !== MCTS_NO_NODE && hch < MCTS_POOL_SIZE) {
                var hcn = nodePool[hch];
                if (hcn.moveRow === MCTS_PASS_ROW && hcn.player === oppSP) {
                    hpNode = hch;
                    break;
                }
                hch = hcn.nextSibling;
            }
            if (hpNode !== MCTS_NO_NODE) {
                decaySubtree(hpNode);
                return hpNode;
            }
        }
        return MCTS_NO_NODE;
    }
    if (hPass)
        return MCTS_NO_NODE; // our stone missing with no move: not a capture
    // Their stone is on the board: single-color rhythm (our turn again).
    if (currentPlayer !== savedPlayer)
        return MCTS_NO_NODE;
    var hNode = MCTS_NO_NODE;
    var ch2 = nodePool[mNode].firstChild;
    while (ch2 !== MCTS_NO_NODE && ch2 < MCTS_POOL_SIZE) {
        var cn2 = nodePool[ch2];
        if (cn2.moveRow === hR && cn2.moveCol === hC &&
            cn2.player === oppSP) {
            hNode = ch2;
            break;
        }
        ch2 = cn2.nextSibling;
    }
    if (hNode === MCTS_NO_NODE)
        return MCTS_NO_NODE;
    decaySubtree(hNode);
    return hNode;
}

// Send a move reply back to the watch. This is the ONLY way the watch
// leaves AI_THINKING (besides its own timeout), so every code path below
// must end here — never throw without replying, or the game appears hung
// with dead buttons until the watch-side timeout fires. Also snapshots
// the reply for next move's tree reuse (item 5).
function sendMoveReply(moveRow, moveCol, isPass) {
    saveReplyState(moveRow, moveCol, isPass);
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
    // A new request aborts any background pondering instantly (single
    // thread: this runs between ponder slices, so the check is race-free).
    ponderOn = false;
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
    reqPlayer = currentPlayer;

    // Opening book first (moves 1-2): deterministic, no search needed.
    var bookMove = openingBookMove(gBoard, movesMade, currentPlayer);
    if (bookMove) {
        console.log('pkjs: opening book plays (' + bookMove[0] + ',' + bookMove[1] + ')');
        sendMoveReply(bookMove[0], bookMove[1], 0);
        ponderStart(bookMove[0], bookMove[1], 0, currentPlayer);
        return;
    }

    // Fuseki book (moves 2-9): calm positions only (no captures, no contact
    // — those mean fighting, which needs search). Deterministic pro-style
    // points instead of center-seeking noise, so every fight starts from a
    // living shape.
    var fusekiMove = openingFusekiMove(gBoard, gKoBoard, gKoActive, movesMade,
                                       lastRow, lastCol, currentPlayer);
    if (fusekiMove) {
        console.log('pkjs: fuseki plays (' + fusekiMove[0] + ',' + fusekiMove[1] + ')');
        sendMoveReply(fusekiMove[0], fusekiMove[1], 0);
        ponderStart(fusekiMove[0], fusekiMove[1], 0, currentPlayer);
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
            ponderStart(rootMoves[killIdx].r, rootMoves[killIdx].c, 0,
                        currentPlayer);
            return;
        } else {
            console.log('pkjs: atari kill looks unsafe (snapback?), searching instead');
        }
    }

    // Time management (item 4): static position complexity sets the
    // iteration budget, not a flat count. Fights (tense stones with <=2
    // liberties) and active ko get more search; nearly-full settled boards
    // get less (cleanup needs no search). The 20s wall clock stays the hard
    // guard either way, and the in-search adaptive cut still applies.
    var planEmpties = 0, planTense = 0;
    for (var pe = 0; pe < BOARD_SIZE * BOARD_SIZE; pe++) {
        if (gBoard[pe] === EMPTY) {
            planEmpties++;
            continue;
        }
        var pr2 = Math.floor(pe / BOARD_SIZE), pc2 = pe % BOARD_SIZE;
        if (countLibertiesCapped(gBoard, pr2, pc2, gBoard[pe], 3) <= 2)
            planTense++;
    }
    var planIters = MCTS_ITERATIONS;
    if (planEmpties <= 12)
        planIters = 250;
    else if (gKoActive)
        planIters = 1400;
    else if (planTense >= 6)
        planIters = 1300;
    if (planIters > 1500)
        planIters = 1500;
    console.log('pkjs: running MCTS with up to ' + planIters + ' iterations (empties=' + planEmpties + ' tense=' + planTense + ')...');
    var startTime = Date.now();
    mctsRun(planIters, currentPlayer, lastRow, lastCol, consecutivePasses);
    var elapsed = Date.now() - startTime;
    console.log('pkjs: MCTS finished in ' + elapsed + 'ms');

    var best = mctsGetBestMove();
    console.log('pkjs: best node index=' + best);

    // Root safety veto: never play an immediately-dead move when a tried
    // alternative exists. Unsafe = pure self-atari, own-eye fill, dead on
    // arrival (Benson + confined regions, same as the watch estimate view),
    // or a broken-ladder / dead-rescue escape (items A+B: donate nothing).
    // Captures are never vetoed.
    // NOTE: the checks use playBoard/probeBoard scratch: safe here because
    // the search is finished (no active playout).
    var vetoWhy = function(r, c) {
        if (!simLegal(gBoard, gKoBoard, gKoActive, currentPlayer, r, c))
            return 'illegal';
        if (putsSelfInAtari(gBoard, gKoBoard, gKoActive, currentPlayer, r, c))
            return 'self-atari';
        if (fillsOwnEye(gBoard, r, c, currentPlayer))
            return 'eye-fill';
        if (eyeSpaceVerdict(gBoard, gKoBoard, gKoActive,
                            currentPlayer, r, c) === 'kill')
            return 'eye-kill';
        if (lifeStoneDeadOnArrival(gBoard, gKoBoard, gKoActive,
                                   currentPlayer, r, c))
            return 'dead-arrival';
        if (isEscapeMove(gBoard, currentPlayer, r, c) &&
            escapeVerdict(gBoard, gKoBoard, gKoActive, currentPlayer, r, c) !== 'ok')
            return 'bad-escape';
        return null;
    };
    if (best !== MCTS_NO_NODE) {
        var bn = nodePool[best];
        if (bn.moveRow !== MCTS_PASS_ROW) {
            var why = vetoWhy(bn.moveRow, bn.moveCol);
            if (why) {
                console.log('pkjs: veto unsafe best (' + bn.moveRow + ',' + bn.moveCol + ')=' + why + ', seeking safe alternative');
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
                    if (!vetoWhy(cand.moveRow, cand.moveCol)) {
                        console.log('pkjs: veto -> safe (' + cand.moveRow + ',' + cand.moveCol + ') visits=' + cand.visits);
                        best = cands[ci];
                        break;
                    }
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

// Reply widening for next move's tree reuse: pre-expand up to 5 likely
// opponent replies under the chosen move, so the next request finds its H
// node even for quiet (non-tactical) replies. Static scoring only (shape +
// contact + locality, no simulation beyond exact legality which the move
// generator already verified); zeroed priors, visits shape them next time.
// Skipped on pool pressure, pass... no — pass replies widen too (opponent
// moves after our pass reuse the same way).
function widenReplies(bestNode) {
    if (bestNode === MCTS_NO_NODE || bestNode >= nodePoolUsed)
        return;
    if (nodePoolUsed > 9500)
        return;
    var bn = nodePool[bestNode];
    var mover = (bn.player === BLACK) ? WHITE : BLACK;
    if (mover !== BLACK && mover !== WHITE)
        return;
    // Base = gBoard + our reply applied.
    copyBoard(simBoard, gBoard);
    copyBoard(simKoBoard, gKoBoard);
    simKoActive = gKoActive;
    if (bn.moveRow !== MCTS_PASS_ROW) {
        var ap = simTryPlace(simBoard, simKoBoard, simKoActive, bn.player,
                             bn.moveRow, bn.moveCol);
        if (!ap.success)
            return;
        simKoActive = ap.koActive;
    }
    var moves = getLegalMovesOn(simBoard, simKoBoard, simKoActive, mover);
    var scored = [];
    for (var i = 0; i < moves.length; i++) {
        if (moves[i].r === MCTS_PASS_ROW)
            continue;
        var s = shapeScore(moves[i].r, moves[i].c);
        if (hasOppNeighbor(simBoard, moves[i].r, moves[i].c, mover))
            s += 2000;
        if (bn.moveRow !== MCTS_PASS_ROW &&
            Math.abs(moves[i].r - bn.moveRow) +
            Math.abs(moves[i].c - bn.moveCol) <= 2)
            s += 1500;
        scored.push({ i: i, s: s });
    }
    scored.sort(function(a, b) { return b.s - a.s; });
    var added = 0;
    var ensurePass = true;
    var addChild = function(mr, mc) {
        var ch = bn.firstChild;
        while (ch !== MCTS_NO_NODE && ch < MCTS_POOL_SIZE) {
            var cn = nodePool[ch];
            if (cn.moveRow === mr && cn.moveCol === mc)
                return false;
            ch = cn.nextSibling;
        }
        var nc = allocNode(mr, mc, mover);
        if (nc === MCTS_NO_NODE)
            return false;
        if (bn.firstChild === MCTS_NO_NODE) {
            bn.firstChild = nc;
        } else {
            var sib = bn.firstChild;
            while (nodePool[sib].nextSibling !== MCTS_NO_NODE)
                sib = nodePool[sib].nextSibling;
            nodePool[sib].nextSibling = nc;
        }
        return true;
    };
    // Opponent pass first: single-color pass-responses reuse through it.
    if (addChild(MCTS_PASS_ROW, MCTS_PASS_COL))
        added++;
    for (var k = 0; k < scored.length && added < 6; k++) {
        var mv = moves[scored[k].i];
        if (addChild(mv.r, mv.c))
            added++;
    }
    if (added > 0)
        console.log('pkjs: widened ' + added + ' replies under best');
}

    // Widen likely opponent replies under the final move (next move's
    // tree reuse). Skipped for error replies (nothing sound to continue).
    if (isPass !== 2)
        widenReplies(best);
    sendMoveReply(moveRow, moveCol, isPass);
    // Ponder the post-move position while the human thinks (best-effort,
    // error replies excluded: nothing to ponder from).
    if (isPass !== 2)
        ponderStart(moveRow, moveCol, isPass, currentPlayer);
}
