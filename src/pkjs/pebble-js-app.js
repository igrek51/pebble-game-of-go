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
// Playout diagnostics accumulators (per request, stderr only under
// PEBBLE_PLAYOUT_STATS=1; zero cost otherwise — single flag check).
var plStatN = 0, plStatMoves = 0, plStatEmpty = 0, plStatCap = 0, plStatPass = 0;
// Static strategy grid: big-point direction for quiet positions, computed
// once per request from gBoard (docs/eval.md: the search systematically
// picks 2%-winrate 3rd-line consolidations like D7 while KataGo plays the
// open center F6 — playouts cannot resolve influence, so strategy steers
// as a prior, tactics still force). Ring-shaped center (KataGo top-3
// distribution, tools/eval/strat_train.json: ring1 28%, ring2 53%, ring3
// 17%, never edge/tengen), fight proximity, contact press-vs-throw-in,
// cut defense. Weights fitted in tools/eval/strat_fit.js (30% top-3).
// stratGrid[i] ~ [-30, +50].
var stratGrid = new Array(BOARD_SIZE * BOARD_SIZE);
// Second grid for 1-ply tempo replies (opponent's best answer evaluation).
var stratGrid2 = new Array(BOARD_SIZE * BOARD_SIZE);
var STRAT_RING = [2, 20, 18, 6, -20];
function stratCompute(b, player, out) {
    out = out || stratGrid;
    var opp = (player === BLACK) ? WHITE : BLACK;
    for (var r = 0; r < BOARD_SIZE; r++) {
        for (var c = 0; c < BOARD_SIZE; c++) {
            var idx = r * BOARD_SIZE + c;
            if (b[idx] !== EMPTY) {
                out[idx] = -999;
                continue;
            }
            var dr0 = Math.abs(r - 4), dc0 = Math.abs(c - 4);
            var ring = dr0 > dc0 ? dr0 : dc0;
            var s = STRAT_RING[ring];
            if (r === 0 || r === 8 || c === 0 || c === 8)
                s -= 10; // first line: KataGo never plays it
            else if (r === 1 || r === 7 || c === 1 || c === 7)
                s -= 6; // second line: playable, discount (v3-fitted -8 rejected with the batch)
            // Cut defense: joining 2+ own groups next to enemy stones is
            // rescue-class (split walls die in pieces); quiet connections
            // are worth little (fit: 24 vs 2). Taking the ENEMY's
            // connection point (2+ distinct enemy groups adjacent) is the
            // same urgency from the other side — playouts never cut, so
            // strategy must.
            var conn2 = connectCount(b, player, r, c) >= 2;
            var cut = false;
            if (conn2) {
                var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
                for (var d = 0; d < 4; d++) {
                    var ni = boardIndex(r + dr[d], c + dc[d]);
                    if (ni >= 0 && b[ni] === opp) {
                        cut = true;
                        break;
                    }
                }
                s += cut ? 24 : 2;
            } else {
                // Enemy cut, thickness-aware (fitted cutSize -1): diving
                // between strong groups is suicide (big cuts negative),
                // while own-connection cuts stay rescue-class above.
                // Small peeps are carried by press/proximity instead.
                var cutSum = 0, cutGroups = 0;
                var seenCut = {};
                var cdr = [-1, 1, 0, 0], cdc = [0, 0, -1, 1];
                for (var cd = 0; cd < 4; cd++) {
                    var cnr = r + cdr[cd], cnc = c + cdc[cd];
                    var cni = boardIndex(cnr, cnc);
                    if (cni < 0 || b[cni] !== opp || seenCut[cni])
                        continue;
                    // Flood this enemy group once (mark via seenCut).
                    var cstack = [[cnr, cnc]];
                    seenCut[cni] = true;
                    var csize = 0;
                    while (cstack.length && csize < 9) {
                        var ccur = cstack.pop();
                        csize++;
                        for (var ce = 0; ce < 4; ce++) {
                            var cjr = ccur[0] + cdr[ce], cjc = ccur[1] + cdc[ce];
                            var cji = boardIndex(cjr, cjc);
                            if (cji < 0 || b[cji] !== opp || seenCut[cji])
                                continue;
                            seenCut[cji] = true;
                            cstack.push([cjr, cjc]);
                        }
                    }
                    cutGroups++;
                    cutSum += csize;
                }
                if (cutGroups >= 2)
                    s -= cutSum > 8 ? 8 : cutSum;
            }
            // Orthogonal contact: own adjacency crowds (-2 each); enemy
            // adjacency presses (+4 each) with room to fight (2+ empty
            // neighbors — KataGo peeps like D4 live thin), else it is a
            // throw-in (-4 each). Connected shape skips contact scoring.
            var adjO = 0, adjE = 0, room = 0;
            if (!conn2) {
                var er = [-1, 1, 0, 0], ec = [0, 0, -1, 1];
                for (var e = 0; e < 4; e++) {
                    var ei = boardIndex(r + er[e], c + ec[e]);
                    if (ei < 0)
                        continue;
                    if (b[ei] === EMPTY)
                        room++;
                    else if (b[ei] === player)
                        adjO++;
                    else
                        adjE++;
                }
                s += adjO * -2;
                if (adjE > 0)
                    s += room >= 2 ? adjE * 4 : adjE * -4;
            }
            // Fight proximity (Chebyshev 2-3): settled thickness attracts
            // (+3.5), unsettled stones less (+2.5) — fitted: the game is
            // decided AT frameworks, not inside scrambles.
            for (var i = 0; i < 81; i++) {
                if (b[i] === EMPTY)
                    continue;
                var ir = Math.floor(i / BOARD_SIZE), ic = i % BOARD_SIZE;
                var mdr = Math.abs(ir - r), mdc = Math.abs(ic - c);
                var cheb = mdr > mdc ? mdr : mdc;
                if (cheb >= 2 && cheb <= 3) {
                    if (countLibertiesCapped(b, ir, ic, b[i], 5) <= 4)
                        s += 2.5;
                    else
                        s += 3.5;
                }
            }
            out[idx] = s;
        }
    }
}
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

// Eval A/B flag: PEBBLE_PLAIN_SCORE=1 scores playout terminals with plain
// Tromp-Taylor (everything alive) instead of the dead-aware strip + Benson
// removal. Phone-safe: process is undefined on device, flag defaults off.
var PLAIN_SCORE = (typeof process !== 'undefined' && process.env &&
                   process.env.PEBBLE_PLAIN_SCORE === '1');
// Eval A/B flag: PEBBLE_FULL_T3=1 runs Tier-3 2-lib tactics full-board
// (not just the +-2 window) in playouts and per-node expansion, so
// simulations refute quiet far-away moves instead of chasing them.
// Slower per iteration; the adaptive budget absorbs it. Phone-safe
// (defaults off).
var FULL_T3 = (typeof process !== 'undefined' && process.env &&
               process.env.PEBBLE_FULL_T3 === '1');

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
        // Tier-3 fight move: 2-lib attack/defense around the last move
        // (findTacticalMove tier 3: capture/escape a 2-lib group, or a
        // supported sidestep). 1-lib tactics are forced outright at root;
        // 2-lib fights are judgment calls, so they get a strong prior
        // instead of a force. Set at expansion only.
        t32: 0,
        // Locality: reply in the neighborhood of the last move.
        // Flat in uct() (+40) and the prior fallback (+250): fights are
        // local, and quiet far tenuki while unsettled stones wait is the
        // classic way to hemorrhage games (see docs/eval.md #20 H4).
        loc: 0,
        // Static strategy value (stratGrid at expansion time): big-point
        // direction in quiet positions. Flat in uct() and the prior
        // fallback; tactics (urg/thr/t32/cut) outrank it by weight.
        strat: 0,
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
    { w: -1, g: ["XX ", "X. ", "..."] }, // EMPTY TRIANGLE (universally bad)
    // --- expansion batch (MoGo-style coverage; all 8 orientations auto) ---
    { w: 1, g: ["XXX", "...", "..."] }, // solid 3-extension
    { w: 1, g: ["X..", "X..", "..."] }, // 2-stone wall
    { w: 1, g: ["XX.", "X..", "..."] }, // L-turn corner
    { w: 1, g: ["XXX", "X..", "..."] }, // wall corner enclosure
    { w: 1, g: ["X.X", "X.X", "..."] }, // double-gap mouth
    { w: 1, g: ["..X", "...", "X.."] }, // diagonal line connection
    { w: 1, g: [".X.", "...", "..."] }, // extension from own stone
    { w: 1, g: [".XX", "...", "..."] }, // crawl end along a wall
    { w: 1, g: ["O..", "X..", "..."] }, // low attachment vs enemy
    { w: 1, g: ["O..", "...", "..."] }, // diagonal press on enemy corner
    { w: 1, g: ["OO.", "X..", "..."] }, // double hane vs two stones
    { w: 2, g: [".O.", "X.X", "..."] }, // peep between enemies (urgent)
    { w: 2, g: [".O.", "X.X", ".O."] }, // double cut both ways (urgent)
    { w: 1, g: ["OXO", "...", "..."] }, // hane between two enemies
    { w: 1, g: [" XO", "...", "..."] }, // contact hane from above
    { w: 1, g: [".O.", "...", ".X."] }, // wedge underneath enemy
    { w: 1, g: ["X..", "O..", "..."] }, // low contact vs enemy below
    { w: 1, g: [".O.", "...", "..."] }, // press from above
    { w: 1, g: ["OX.", "...", "..."] }, // top-row contact hane
    { w: 1, g: ["XX.", "X..", "X.."] }, // table-shape corner
    { w: 1, g: ["###", "X.X", "..."] }, // edge: 2nd-line solid extension
    { w: 1, g: ["###", "O.X", "..."] }, // edge: contact fight both colors
    { w: 1, g: ["O.O", "...", "..."] }, // 2-gap peep between enemies
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
        // Static strategy direction (big points over edge consolidation).
        // Small inside the clamped blend; the flat bonus below carries it.
        if (node.strat)
            pr += node.strat * 0.004;
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
    // Static strategy direction, flat and persistent (unlike the RAVE
    // blend above, this does not fade with visits): big central fight
    // points over edge consolidation. Halved: the raw grid range (±50)
    // must stay below tactics (thr 75+). Root argmax uses raw values.
    if (node.strat)
        value += Math.floor(node.strat * 0.5);

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
    // Tier-3 fight: 2-lib attack/defense is usually the urgent local
    // business; rank it above shape noise but below verified 1-lib
    // tactics and eye shape (non-capturing attacks must not outshout a
    // cut defense — those stay search-decided).
    if (node.t32)
        value += 200;
    if (node.loc)
        value += 40;
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
    var whiteTotal = wStones + wTerritory + 7.5;
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

// Tree breadth control (Ikeda/Coulom: at low budgets DEPTH beats breadth —
// a focused 7-candidate search resists well via deeper reading). Keep every
// tactical point (liberty of a 1-lib group = kill/escape), every live cut
// (joins 2+ own groups next to enemy), every neighbor of the last move,
// then fill by static strategy value up to PRUNE_CAP (18). Below 6 stones
// (opening) or fewer than 12 kept, keep full breadth for tenuki.
// Pass is always kept. Playouts and root forcing use unpruned moves.
var PRUNE_CAP = 18;
function pruneTreeMoves(moves, b, player, lastR, lastC) {
    var stones = 0, i;
    for (i = 0; i < 81; i++) {
        if (b[i] !== EMPTY)
            stones++;
    }
    if (stones < 6)
        return moves;
    var tagged = [];
    var must = 0;
    for (i = 0; i < moves.length; i++) {
        var mr = moves[i].r, mc = moves[i].c;
        if (mr === MCTS_PASS_ROW) {
            tagged.push({ i: i, must: true, s: 99999 });
            must++;
            continue;
        }
        // Tactical: adjacent to a 1-lib group (either color).
        var tact = false;
        var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
        for (var d = 0; d < 4 && !tact; d++) {
            var ni = boardIndex(mr + dr[d], mc + dc[d]);
            if (ni < 0 || b[ni] === EMPTY)
                continue;
            if (countLibertiesCapped(b, mr + dr[d], mc + dc[d], b[ni], 2) === 1)
                tact = true;
        }
        // Live cut answer.
        var cutA = connectCount(b, player, mr, mc) >= 2 &&
                   hasOppNeighbor(b, mr, mc, player);
        // Last-move neighborhood (reply locally).
        var local = Math.abs(mr - lastR) + Math.abs(mc - lastC) <= 2;
        if (tact || cutA || local) {
            tagged.push({ i: i, must: true, s: 99999 });
            must++;
        } else {
            tagged.push({ i: i, must: false, s: stratGrid[mr * BOARD_SIZE + mc] });
        }
    }
    if (must >= PRUNE_CAP)
        return moves;
    // Fill to cap by strategy value (stable order: score desc, index asc).
    var fill = tagged.filter(function (t) { return !t.must; });
    fill.sort(function (a, b2) { return (b2.s - a.s) || (a.i - b2.i); });
    var want = PRUNE_CAP - must;
    var keepSet = {};
    for (i = 0; i < tagged.length; i++) {
        if (tagged[i].must)
            keepSet[tagged[i].i] = true;
    }
    for (i = 0; i < fill.length && i < want; i++)
        keepSet[fill[i].i] = true;
    var kept = Object.keys(keepSet).length;
    if (kept < 12)
        return moves;
    var out = [];
    for (i = 0; i < moves.length; i++) {
        if (keepSet[i])
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

// Post-escape liberties of playing (r,c) for `player` (-1 if illegal).
// Uses probeBoard scratch; call only with a free scratch (pre/post search).
function escapeToLibs(b, koB, koActive, player, r, c) {
    copyBoard(probeBoard, b);
    copyBoard(probeKo, koB);
    var res = simTryPlace(probeBoard, probeKo, koActive, player, r, c);
    if (!res.success)
        return -1;
    return countLibertiesCapped(probeBoard, r, c, player, 4);
}

// Uniform forcing predicate for DEFENSIVE moves (1-lib escapes, 2/3-lib
// breakouts): force iff the escape works AND is worth it —
//  - substantial groups (3+ stones): force on 2+ post-move libs (still
//    fighting); 1 lib is pointless;
//  - small groups (1-2): force on 3+ libs (comfortable breakouts hold),
//    but never when a genuine peep exists elsewhere (initiative outranks
//    consolidation: D4 45% > C2 18%; lone squeezes don't suppress);
//  - never run to the first line (edge liberties fill next move);
//  - never donate already-dead groups (dead-arrival veto).
// Uses probeBoard/playBoard scratch via escapeToLibs/lifeStoneDeadOnArrival;
// call only pre/post search. Captures bypass this (concrete gain).
function forceDefenseOk(b, koB, koActive, player, r, c) {
    if (r === 0 || r === 8 || c === 0 || c === 8)
        return false;
    var libs = escapeToLibs(b, koB, koActive, player, r, c);
    if (libs < 0)
        return false;
    // Find the rescued group size: largest own ≤2-lib neighbor group.
    var size = 0;
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    for (var d = 0; d < 4; d++) {
        var ni = boardIndex(r + dr[d], c + dc[d]);
        if (ni < 0 || b[ni] !== player)
            continue;
        var gl = countLibertiesCapped(b, r + dr[d], c + dc[d], player, 3);
        if (gl <= 2) {
            var gs = groupSizeCapped(b, r + dr[d], c + dc[d], player, 4);
            if (gs > size)
                size = gs;
        }
    }
    if (size >= 3) {
        if (libs < 2)
            return false;
    } else {
        if (libs < 3)
            return false;
        // Small consolidation yields to genuine peeps elsewhere
        // (initiative outranks: D4 45% > C2 18%). Computed lazily:
        // full-board peep scan only runs for small breakouts.
        if (doubleAttackExists(b, koB, koActive, player))
            return false;
        // No edge crawls: lines 1-2 runs die (C1/C2: -28..-34pp);
        // center runs live. Big groups keep the first-line-only gate.
        if (r <= 1 || r >= 7 || c <= 1 || c >= 7)
            return false;
    }
    if (lifeStoneDeadOnArrival(b, koB, koActive, player, r, c))
        return false;
    return true;
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

// Double attack (peep initiative) EXISTENCE check: an empty point
// orthogonally adjacent to 2+ enemy stones, with room to fight (2+ empty
// neighbors), whose play leaves us alive (2+ libs) and squeezes at least
// one adjacent enemy group to 2 liberties. Used ONLY as a suppressor:
// a genuine peep (D4: 45%) outranks small-group consolidation (C2: 18%),
// but peeps are never forced directly (a corner touch like B2 matches the
// same local pattern and only reading separates them — the strategy press
// bonus carries peep judgment). Suppressor peeps must be big points
// (ring ≤ 2): edge/corner touches (B2) are not initiative worth
// abandoning defense for. Returns true/false. Root-pre-search only.
function doubleAttackExists(b, koB, koActive, player) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    for (var r = 0; r < BOARD_SIZE; r++) {
        for (var c = 0; c < BOARD_SIZE; c++) {
            if (b[r * BOARD_SIZE + c] !== EMPTY)
                continue;
            var bd = Math.abs(r - 4), bc = Math.abs(c - 4);
            if ((bd > bc ? bd : bc) > 2)
                continue; // edge peeps don't suppress defense
            var adjE = 0, room = 0;
            for (var d = 0; d < 4; d++) {
                var ni = boardIndex(r + dr[d], c + dc[d]);
                if (ni < 0)
                    continue;
                if (b[ni] === EMPTY)
                    room++;
                else if (b[ni] === opp)
                    adjE++;
            }
            if (adjE < 2 || room < 2)
                continue;
            copyBoard(probeBoard, b);
            copyBoard(probeKo, koB);
            var res = simTryPlace(probeBoard, probeKo, koActive, player, r, c);
            if (!res.success)
                continue;
            if (countLibertiesCapped(probeBoard, r, c, player, 3) < 2)
                continue;
            for (var e = 0; e < 4; e++) {
                var ei = boardIndex(r + dr[e], c + dc[e]);
                if (ei < 0 || probeBoard[ei] !== opp)
                    continue;
                if (countLibertiesCapped(probeBoard, r + dr[e], c + dc[e],
                                         opp, 3) <= 2)
                    return true;
            }
        }
    }
    return false;
}

// Capturing-race (semeai) reader, root-only. Finds eyeless opposing groups
// in contact and returns the best liberty-differential move [r, c] when
// behind or even — null when ahead comfortably (don't meddle) or no race.
// v1 limits: no-eye races only (Benson check), approach-move subtleties
// ignored, first race found row-major. Callers: pre-search force (with the
// standard tactical safety set, minus dead-arrival — eyeless is the
// premise) and (later) tree priors. Uses probeBoard/playBoard scratch:
// call only pre/post search.
function semeaiMove(b, koB, koActive, player) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    var lab = { block: [], region: [], blockColor: [] };
    for (var zi = 0; zi < 81; zi++) {
        lab.block[zi] = -1;
        lab.region[zi] = -1;
    }
    lifeLabelAll(b, lab);
    var aliveB = [], aliveW = [];
    for (var ai = 0; ai < 81; ai++) {
        aliveB[ai] = false;
        aliveW[ai] = false;
    }
    lifeBensonForColor(b, lab, BLACK, aliveB);
    lifeBensonForColor(b, lab, WHITE, aliveW);
    var alive = (player === BLACK) ? aliveB : aliveW;
    var aliveO = (player === BLACK) ? aliveW : aliveB;
    var dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    var ownL = [], oppL = [];
    // Best improving race move across all pairs (most urgent = biggest
    // deficit overturned). Scored as post-move differential minus current.
    var gBestR = -1, gBestC = -1, gBestGain = 0;
    for (var i = 0; i < 81; i++) {
        if (b[i] !== player || alive[i])
            continue;
        var r = Math.floor(i / 9), c = i % 9;
        // Own block eyeless? (no alive stone in it)
        var blk = lab.block[i];
        var blkAlive = false;
        for (var j = 0; j < 81; j++) {
            if (lab.block[j] === blk && alive[j]) {
                blkAlive = true;
                break;
            }
        }
        if (blkAlive)
            continue;
        // Adjacent eyeless enemy block?
        for (var d = 0; d < 4; d++) {
            var ni = boardIndex(r + dr[d], c + dc[d]);
            if (ni < 0 || b[ni] !== opp)
                continue;
            var oblk = lab.block[ni];
            var oblkAlive = false;
            for (var k = 0; k < 81; k++) {
                if (lab.block[k] === oblk && aliveO[k]) {
                    oblkAlive = true;
                    break;
                }
            }
            if (oblkAlive)
                continue;
            // Race pair: our block (r,c) vs enemy block at (nr,nc).
            var nr = r + dr[d], nc = c + dc[d];
            var no = groupLiberties(b, r, c, player, ownL);
            var ne = groupLiberties(b, nr, nc, opp, oppL);
            if (no === 0 || ne === 0)
                continue;
            var diff = no - ne;
            if (diff > 1)
                continue; // comfortably ahead: don't meddle here
            // Try every own liberty; maximize post-move differential.
            var preOpp = 0;
            for (var q = 0; q < 81; q++) {
                if (b[q] === opp)
                    preOpp++;
            }
            for (var li = 0; li < no && li < 24; li++) {
                var lr = ownL[li].r, lc = ownL[li].c;
                // No edge crawls (see forceDefenseOk): races are won
                // toward the center, not down the first-two-line gutter.
                if (lr <= 1 || lr >= 7 || lc <= 1 || lc >= 7)
                    continue;
                // No broken-ladder marches: 1-lib escapes face the same
                // verdict as everywhere else (ladder test regression).
                if (isEscapeMove(b, player, lr, lc) &&
                    escapeVerdict(b, koB, koActive, player, lr, lc) !== 'ok')
                    continue;
                copyBoard(probeBoard, b);
                copyBoard(probeKo, koB);
                var rs = simTryPlace(probeBoard, probeKo, koActive,
                                     player, lr, lc);
                if (!rs.success)
                    continue;
                // Captured the racing block outright: take it.
                if (probeBoard[nr * 9 + nc] !== opp) {
                    var postOpp = 0;
                    for (var q2 = 0; q2 < 81; q2++) {
                        if (probeBoard[q2] === opp)
                            postOpp++;
                    }
                    if (postOpp < preOpp)
                        return [lr, lc];
                    continue;
                }
                var ownAfter = countLibertiesCapped(probeBoard, lr, lc, player, 20);
                var oppAfter = countLibertiesCapped(probeBoard, nr, nc, opp, 20);
                // Shared liberty penalty (fill outside first), unless it
                // captures (handled above).
                var shared = false;
                for (var s2 = 0; s2 < ne; s2++) {
                    if (oppL[s2].r === lr && oppL[s2].c === lc) {
                        shared = true;
                        break;
                    }
                }
                var sc = (ownAfter - oppAfter) - (shared ? 2 : 0);
                if (sc - diff > gBestGain) {
                    gBestGain = sc - diff;
                    gBestR = lr;
                    gBestC = lc;
                }
            }
        }
    }
    if (gBestR >= 0)
        return [gBestR, gBestC];
    return null;
}

// Tiered tactical move choice shared by expansion and playouts.
// Tiers: (1) kill a 1-lib enemy group, (2) escape our 1-lib group,
// (3) local 2-lib attack/defense around the last move (gated by probability
// for speed). Returns the index into `moves`, or -1. When `info` is given,
// info.tier receives the winning tier (1/2/3) so expansion can rank the
// eye tier (item A) between urgent 1-lib tactics and Tier 3.
function findTacticalMove(b, koB, koActive, player, moves, lastR, lastC, info, full) {
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
    // Tier 3: local 2-lib tactics around the last move (bounded window for
    // speed — Pachi-style). With full=true the window covers the whole
    // board (root forcing only: playouts and per-node expansion stay
    // windowed for phone speed).
    if ((mctsRng() % 10) < TIER3_PROB10) {
        var libs = [];
        var dr2 = [-1, 1, 0, 0];
        var dc2 = [0, 0, -1, 1];
        var useFull = full || FULL_T3;
        // Window first, whole board after: the first hit keeps the old
        // local priority (a far corner atari must not outshout the live
        // fight), full coverage only extends it. Single pass when windowed.
        var t3passes = useFull ? 2 : 1;
        for (var t3pass = 0; t3pass < t3passes; t3pass++) {
        var inWin = (t3pass === 0);
        var wr0 = inWin ? lastR - 2 : 0, wr1 = inWin ? lastR + 2 : BOARD_SIZE - 1;
        var wc0 = inWin ? lastC - 2 : 0, wc1 = inWin ? lastC + 2 : BOARD_SIZE - 1;
        for (var wr = wr0; wr <= wr1; wr++) {
            for (var wc = wc0; wc <= wc1; wc++) {
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
                            if (info) {
                                info.tier = 3;
                                // Capturing attacks are root-forceable (stones
                                // off the board); mere atari-makers are
                                // prior-only (the cut/connection judgment
                                // stays with the search — see the split-walls
                                // unit test).
                                if (captured)
                                    info.cap = true;
                            }
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
                                if (info) {
                                    info.tier = 3;
                                    // Sound defenses are root-forceable
                                    // (capture, supported sidestep, breakout
                                    // of a substantial group). Breakouts of
                                    // 1-2 stone groups are prior-only: small
                                    // stones are LIGHT — force-saving them
                                    // commits to dead-end shape (C2: -32pp)
                                    // while the opponent takes the center.
                                    // KataGo abandons or peeps instead.
                                    var capDef = false;
                                    if (dd >= 1) {
                                        var bo2 = 0, ao2 = 0;
                                        for (var bj = 0; bj < 81; bj++) {
                                            if (b[bj] === opp2)
                                                bo2++;
                                            if (probeBoard[bj] === opp2)
                                                ao2++;
                                        }
                                        capDef = ao2 < bo2;
                                    }
                                    if (capDef ||
                                        (groupSizeCapped(b, wr, wc, col, 3) >= 3 &&
                                         // No forced runs to the first line:
                                         // edge liberties (D1/F1) fill next
                                         // move, so the "clean" breakout is
                                         // a donation (E1: -22pp).
                                         libs[li].r !== 0 && libs[li].r !== 8 &&
                                         libs[li].c !== 0 && libs[li].c !== 8))
                                        info.t3def = true;
                                    else
                                        // Small-group breakout (1-2 stones):
                                        // damage control, forced only with
                                        // no double attack available (C4:
                                        // 15% beats lone squeeze E3: 6%, but
                                        // loses to a real peep D4: 45%).
                                        info.t3small = true;
                                    if (capDef)
                                        info.cap = true;
                                }
                                return m;
                            }
                        }
                    }
                }
            }
        }
        } // end t3pass (window first, whole board after)
    }
    // Tier 4: 3-lib fights (one liberty deeper than Tier 3). Same shape:
    // windowed in playouts/expansion (phone speed), whole board when full
    // (root forcing). Attacks pressure to <=2 liberties (force only on
    // capture); defenses need a clean 4-lib breakout or capture to force
    // (3-lib sidesteps are prior-only judgment calls). Eye-fill rescues
    // refused like Tier 3.
    if ((mctsRng() % 10) < TIER3_PROB10) {
        var libs4 = [];
        var d42 = [-1, 1, 0, 0];
        var dc42 = [0, 0, -1, 1];
        var useFull4 = full || FULL_T3;
        var t4passes = useFull4 ? 2 : 1;
        for (var t4pass = 0; t4pass < t4passes; t4pass++) {
        var inWin4 = (t4pass === 0);
        var qr0 = inWin4 ? lastR - 2 : 0, qr1 = inWin4 ? lastR + 2 : BOARD_SIZE - 1;
        var qc0 = inWin4 ? lastC - 2 : 0, qc1 = inWin4 ? lastC + 2 : BOARD_SIZE - 1;
        for (var qr = qr0; qr <= qr1; qr++) {
            for (var qc = qc0; qc <= qc1; qc++) {
                var qidx = boardIndex(qr, qc);
                if (qidx < 0)
                    continue;
                var qcol = b[qidx];
                if (qcol !== player && qcol !== opp)
                    continue;
                if (countLibertiesCapped(b, qr, qc, qcol, 4) !== 3)
                    continue;
                var qnlib = groupLiberties(b, qr, qc, qcol, libs4);
                for (var qi = 0; qi < qnlib; qi++) {
                    m = findMoveIndex(moves, libs4[qi].r, libs4[qi].c);
                    if (m < 0)
                        continue;
                    if (qcol === opp) {
                        // Attack: squeeze to 2 (pressure) — force on capture.
                        // Flagged (t32) only vs SUBSTANTIAL targets (3+
                        // stones): squeezing single stones is usually empty
                        // pressure that outshouts real defense (E3 over C4:
                        // 6% vs 15%). Playouts (no info) squeeze regardless.
                        copyBoard(probeBoard, b);
                        copyBoard(probeKo, koB);
                        var ra4 = simTryPlace(probeBoard, probeKo, koActive,
                                              player, libs4[qi].r, libs4[qi].c);
                        if (!ra4.success)
                            continue;
                        var cap4 = (probeBoard[qr * BOARD_SIZE + qc] !== opp);
                        var elib4 = cap4 ? 0 : countLibertiesCapped(probeBoard, qr, qc, opp, 3);
                        var ol4 = countLibertiesCapped(probeBoard, libs4[qi].r,
                                                       libs4[qi].c, player, 3);
                        if ((cap4 || elib4 <= 2) && ol4 >= 2) {
                            if (info) {
                                info.tier = 4;
                                if (cap4)
                                    info.cap = true;
                                else if (groupSizeCapped(b, qr, qc, qcol, 3) >= 3)
                                    info.t4pres = true;
                            }
                            return m;
                        }
                    } else {
                        // Defense: clean 4-lib breakout or capture forces;
                        // 3-lib sidesteps are prior-only.
                        var lr4 = libs4[qi].r, lc4 = libs4[qi].c;
                        if (fillsOwnEye(b, lr4, lc4, player) &&
                            !hasAtariNeighbor(b, lr4, lc4, opp))
                            continue;
                        copyBoard(probeBoard, b);
                        copyBoard(probeKo, koB);
                        var rd4 = simTryPlace(probeBoard, probeKo, koActive,
                                              player, lr4, lc4);
                        if (!rd4.success)
                            continue;
                        var dd4 = countLibertiesCapped(probeBoard, lr4, lc4, player, 5);
                        // No forced runs to the first line (see Tier 3).
                        // Forcing needs a SUBSTANTIAL group (3+ stones):
                        // 3-lib groups aren't urgent (the opponent must spend
                        // a tempo reducing them first — ours to take the big
                        // point instead, e.g. D4 over consolidating D7).
                        // Small dd>=4 breakouts are prior-only (tier set).
                        if (dd4 >= 4 && lr4 !== 0 && lr4 !== 8 && lc4 !== 0 && lc4 !== 8) {
                            if (info) {
                                info.tier = 4;
                                if (groupSizeCapped(b, qr, qc, qcol, 3) >= 3)
                                    info.t3def = true;
                            }
                            return m;
                        }
                        if (dd4 >= 2) {
                            // Live sidestep: prior-only pressure.
                            if (info)
                                info.tier = 4;
                            return m;
                        }
                    }
                }
            }
        }
        } // end t4pass
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

function chooseScoredMove(b, koB, koActiveObj, player, moves, lastR, lastC, followLocal) {
    var n = moves.length;
    var scores = scoredScratch;
    var i, best = -99999;
    for (i = 0; i < n; i++) {
        var s;
        if (moves[i].r === MCTS_PASS_ROW) {
            s = (n <= 3) ? 2000 : (mctsRng() % 10) - 40;
        } else {
            s = mctsRng() % 10;
            if (followLocal === false) {
                // Previous playout move was quiet: no chase — play the
                // global big point (strategy) so tenuki gets punished in
                // simulation instead of followed.
                s += stratGrid[moves[i].r * BOARD_SIZE + moves[i].c] * 0.5;
            } else {
                var dist = Math.abs(moves[i].r - lastR) +
                           Math.abs(moves[i].c - lastC);
                if (dist <= 2)
                    s += 20;
                else if (dist <= 4)
                    s += 10;
            }
            var mr = moves[i].r, mc = moves[i].c;
            var firstLine = (mr === 0 || mr === 8 || mc === 0 || mc === 8);
            var secondLine = (mr === 1 || mr === 7 || mc === 1 || mc === 7);
            if (firstLine)
                s -= 25;
            else if (secondLine)
                s -= 8;
            else if (mr >= 2 && mr <= 6 && mc >= 2 && mc <= 6)
                s += 6;
            // Static strategy direction (precomputed grid, root-position
            // based so slightly stale deep in playouts — low weight).
            s += stratGrid[mr * BOARD_SIZE + mc] * 0.15;
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
        // Enemy cut: sitting between 2+ distinct enemy groups (+40), but
        // ONLY small cuts (total ≤3 stones): diving between strong groups
        // is suicide (fitted cutSize negative). Small peeps must still be
        // taken or tenuki goes unpunished (split-walls lesson stands for
        // thin cuts).
        else {
            var eb = moves[i].r, ec = moves[i].c;
            var eopp = (player === BLACK) ? WHITE : BLACK;
            var edr = [-1, 1, 0, 0], edc = [0, 0, -1, 1];
            var en = 0, esum = 0;
            var eseen = {};
            for (var ed = 0; ed < 4; ed++) {
                var eni = boardIndex(eb + edr[ed], ec + edc[ed]);
                if (eni < 0 || b[eni] !== eopp || eseen[eni])
                    continue;
                en++;
                // Flood-size this enemy group (cap 4: only small/large matters).
                var est = [[eb + edr[ed], ec + edc[ed]]];
                eseen[eni] = true;
                var esz = 0;
                while (est.length && esz < 4) {
                    var ec2 = est.pop();
                    esz++;
                    for (var ee = 0; ee < 4; ee++) {
                        var ejr = ec2[0] + edr[ee], ejc = ec2[1] + edc[ee];
                        var eji = boardIndex(ejr, ejc);
                        if (eji < 0 || b[eji] !== eopp || eseen[eji])
                            continue;
                        eseen[eji] = true;
                        est.push([ejr, ejc]);
                    }
                }
                esum += esz;
                if (en >= 2 && esum > 3)
                    break;
            }
            if (en >= 2 && esum <= 3)
                scores[i] += 40;
        }
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
    // A/B branch: plain Tromp-Taylor terminal (Fuego-style, everything
    // alive). scoreBoard() never mutates its input.
    if (PLAIN_SCORE)
        return scoreBoard(b);
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
    // Fight-following state: the leaf's last tree move is forcing until
    // proven otherwise, so the first reply looks locally.
    var lastTactical = true;
    // Eval-only ablation (PEBBLE_RANDOM_PLAYOUT=1): uniform-random legal
    // playouts, no tactics/heuristics. Tests whether the "smart" playout
    // policy is net-positive (Fuego found eager tactics slightly harmful).
    var randomPlayout = (typeof process !== 'undefined' && process.env &&
                         process.env.PEBBLE_RANDOM_PLAYOUT === '1');

    while (playoutMoves < MCTS_MAX_PLAYOUT) {
        var moves = getLegalMovesOn(playBoard, playKoBoard, playKoActive, playPlayer, true);
        if (moves.length === 0)
            break;

        if (randomPlayout) {
            var ri = mctsRng() % moves.length;
            var rm = moves[ri];
            if (rm.r === MCTS_PASS_ROW) {
                playPasses++;
                if (playPasses >= 2)
                    break;
            } else {
                var rres = simTryPlace(playBoard, playKoBoard, playKoActive,
                                       playPlayer, rm.r, rm.c);
                if (rres.success) {
                    playKoActive = rres.koActive;
                    playLastRow = rm.r;
                    playLastCol = rm.c;
                    playPasses = 0;
                    recordHistMove(rm.r, rm.c, playPlayer);
                } else {
                    playPasses++;
                    if (playPasses >= 2)
                        break;
                }
            }
            playPlayer = (playPlayer === BLACK) ? WHITE : BLACK;
            playoutMoves++;
            continue;
        }

        // Tiered tactics first (atari kill/escape, 2-lib fights), then
        // the scored fallback. Fight-following: answer forcing moves
        // locally, but after a QUIET move look globally — chasing a
        // tenuki across the board lets it escape unpunished in simulation
        // (the search then learns tenuki is free). lastTactical tracks
        // whether the previous playout move was tactical.
        var moveIdx = findTacticalMove(playBoard, playKoBoard, playKoActive,
                                       playPlayer, moves, playLastRow,
                                       playLastCol, null,
                                       FULL_T3 || !lastTactical);
        if (moveIdx >= 0) {
            var tm = moves[moveIdx];
            var tres = simTryPlace(playBoard, playKoBoard, playKoActive,
                                   playPlayer, tm.r, tm.c);
            if (tres.success) {
                playKoActive = tres.koActive;
                playLastRow = tm.r;
                playLastCol = tm.c;
                playPasses = 0;
                lastTactical = true;
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
                                      playLastCol, lastTactical);
            playKoActive = koBox.flag;
            lastTactical = false;
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
    // Eval-only playout diagnostics (PEBBLE_PLAYOUT_STATS=1): end reasons
    // + terminal empties, aggregated per request on stderr.
    if (typeof process !== 'undefined' && process.env &&
        process.env.PEBBLE_PLAYOUT_STATS === '1') {
        plStatN++;
        plStatMoves += playoutMoves;
        var te = 0;
        for (var se = 0; se < 81; se++) {
            if (playBoard[se] === EMPTY)
                te++;
        }
        plStatEmpty += te;
        if (playoutMoves >= MCTS_MAX_PLAYOUT)
            plStatCap++;
        else
            plStatPass++;
    }
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

    // Static strategy direction for this request (zero marginal cost at
    // expansion/playout: plain array reads of the precomputed grid).
    stratCompute(gBoard, currentPlayer);

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
    openingMoves = pruneTreeMoves(openingMoves, simBoard, currentPlayer,
                                   lastRow, lastCol);
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
                    // Eval-deep override: hold the requested count (the 20s
                    // wall box still backstops); the adaptive cut is a
                    // phone-speed fit and would fight it.
                    var evalHold = (typeof process !== 'undefined' && process.env &&
                                    process.env.PEBBLE_EVAL_ITERS);
                    if (!evalHold && estFit < iterations) {
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
        moves = pruneTreeMoves(moves, simBoard, simPlayer,
                               simLastRow, simLastCol);

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
            var eloc = 0;
            var expRes = null, expOk = (expRow === MCTS_PASS_ROW);
            if (!expOk) {
                ees = eyeMakeScore(simBoard, simKoBoard,
                                   simKoActive, expMover, expRow, expCol);
                // 3x3 pattern prior, same PRE-move board, near the
                // previous last move only (local shape language).
                if (Math.abs(expRow - simLastRow) +
                    Math.abs(expCol - simLastCol) <= 2)
                    eps = patBonus(simBoard, expRow, expCol, expMover);
                // Locality: answer nearby (Fuego proximity / Pachi
                // neighborhood bias). Fights are local; tenuki to a far
                // star while the opponent settles is how games hemorrhage.
                if (Math.abs(expRow - simLastRow) +
                    Math.abs(expCol - simLastCol) <= 2)
                    eloc = 1;
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
                // (Enemy-cut ecut was tried and reverted: fitted cutSize is
                // negative — diving between strong groups is suicide. Small
                // peeps ride press/proximity; strategy grid scores cuts by
                // thickness above.)
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
                    nodePool[newChild].loc = eloc;
                    nodePool[newChild].strat = stratGrid[expRow * BOARD_SIZE + expCol];
                    // Tier-3/4 fight prior: this candidate IS the tactical
                    // attack/defense (no extra board sims — reuse the tier
                    // verdict computed above for expansion ordering).
                    // Tier-4 attacks need t4pres (substantial target) —
                    // empty squeezes must not outshout defense.
                    if (tactIdx >= 0 && (tactInfo.tier === 3 ||
                        (tactInfo.tier === 4 && (tactInfo.t3def ||
                         tactInfo.cap || tactInfo.t4pres))) &&
                        moves[tactIdx].r === expRow &&
                        moves[tactIdx].c === expCol)
                        nodePool[newChild].t32 = 1;
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
                (c.con ? 200 : 0) + (c.cut ? 800 : 0) + (c.t32 ? 650 : 0) +
                (c.loc ? 250 : 0) + ((c.strat || 0) * 4);
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

// ---- KataGo-distilled opening book (plies 0-24) ----
// Canonical-hash (both colors, 8 symmetries) -> KataGo's top reply in
// canonical coords, distilled from analyzed real-game positions
// (tools/eval/make_book.js; data spliced below at <KATAGO_BOOK_DATA>).
// Verified replies outrank strategy/search but not immediate tactics:
// the reply path consults this after tactics-forcing, before cut answers.
// <KATAGO_BOOK_DATA>
// (spliced by tools/eval/splice_book.sh — do not hand-edit between markers)
var KATAGO_BOOK = {"20,32|40,41":{"turn":"B","r":4,"c":6,"wr":0.374},"30|40":{"turn":"B","r":3,"c":4,"wr":0.5},"20,24,48|40,49,58":{"turn":"B","r":5,"c":6,"wr":0.435},"20,24,31,48|40,49,57,58":{"turn":"B","r":5,"c":6,"wr":0.331},"12,20,24,31,47,48|39,40,49,56,57,58":{"turn":"B","r":5,"c":6,"wr":0.264},"20,23,32,39,56|24,33,40,41,42":{"turn":"B","r":6,"c":4,"wr":0.333},"12,20,24,31,46,47,48|28,39,40,49,56,57,58":{"turn":"B","r":3,"c":2,"wr":0.116},"12,20,24,31,46,47,48,50|28,38,39,40,49,56,57,58":{"turn":"B","r":6,"c":6,"wr":0.021},"12,20,24,31,41,46,47,48,50|28,38,39,40,49,56,57,58,60":{"turn":"B","r":2,"c":1,"wr":0.012},"12,20,24,31,41,46,47,48,50,59|28,38,39,40,49,51,56,57,58,60":{"turn":"B","r":7,"c":5,"wr":0.465},"30|50":{"turn":"B","r":4,"c":5,"wr":0.452},"30,41|29,50":{"turn":"B","r":5,"c":4,"wr":0.548},"30,31,49|21,33,50":{"turn":"B","r":6,"c":4,"wr":0.571},"22,31,48,49|30,32,51,57":{"turn":"B","r":6,"c":2,"wr":0.807},"21,22,31,48,49|30,32,39,51,57":{"turn":"B","r":5,"c":5,"wr":0.81},"21,22,31,47,48,49|23,30,32,39,51,57":{"turn":"B","r":5,"c":5,"wr":0.868},"21,22,31,40,47,48,49|23,29,30,32,39,51,57":{"turn":"B","r":6,"c":6,"wr":0.982},"21,22,31,40,47,48,49,58|23,29,30,32,39,51,57,66":{"turn":"B","r":6,"c":6,"wr":0.987},"12,23,29,32,38,39,40,41,42|20,21,30,31,33,34,47,48,59":{"turn":"B","r":6,"c":6,"wr":0.972},"11,12,23,29,32,38,39,40,41,42|19,20,21,30,31,33,34,47,48,59":{"turn":"B","r":6,"c":6,"wr":0.977},"30|51":{"turn":"B","r":5,"c":4,"wr":0.485},"20,32|51,57":{"turn":"B","r":5,"c":3,"wr":0.395},"20,24,30|42,47,59":{"turn":"B","r":6,"c":4,"wr":0.367},"20,24,30,57|42,47,56,59":{"turn":"B","r":5,"c":3,"wr":0.466},"20,24,30,40,57|42,47,48,56,59":{"turn":"B","r":6,"c":6,"wr":0.156},"20,24,30,40,57,58|42,47,48,56,59,68":{"turn":"B","r":5,"c":4,"wr":0.562},"20,24,30,39,40,57,58|42,47,48,49,56,59,68":{"turn":"B","r":4,"c":7,"wr":0.002},"12,21,22,39,40,48,56,60|11,14,20,23,29,30,31,42":{"turn":"B","r":4,"c":7,"wr":0.002},"20,24,30,39,40,57,58,66,75|32,42,47,48,49,56,59,65,68":{"turn":"B","r":4,"c":5,"wr":0.002},"20,21,40,42,48,49,51,52,53,56|22,30,31,33,34,41,50,59,60,61":{"turn":"B","r":3,"c":2,"wr":0},"31|49":{"turn":"B","r":4,"c":2,"wr":0.461},"30,41|31,39":{"turn":"B","r":4,"c":4,"wr":0.594},"21,30,41|31,39,77":{"turn":"B","r":4,"c":4,"wr":0.909},"21,30,41,49|31,39,40,77":{"turn":"B","r":5,"c":5,"wr":0.481},"21,30,41,48,49,59|31,39,40,58,67,77":{"turn":"B","r":4,"c":2,"wr":0.995},"21,30,41,49,59|31,39,40,58,77":{"turn":"B","r":5,"c":3,"wr":0.793},"21,30,32,41,48,49,59|22,31,39,40,58,67,77":{"turn":"B","r":4,"c":2,"wr":0.985},"21,30,32,38,41,48,49,59|13,22,31,39,40,58,67,77":{"turn":"B","r":6,"c":2,"wr":0.99},"11,23,30,32,39,42,49,50,57|13,21,22,31,40,41,58,67,75":{"turn":"B","r":2,"c":2,"wr":0.982},"11,20,23,30,32,39,42,49,50,57|13,21,22,31,40,41,58,67,75,78":{"turn":"B","r":6,"c":6,"wr":0.998},"20,21,30,33,56|23,24,32,51,58":{"turn":"B","r":6,"c":5,"wr":0.036},"20,21,30,33,42,56|23,24,25,32,51,58":{"turn":"B","r":4,"c":5,"wr":0.317},"20,21,30,33,40,42,56|23,24,25,32,41,51,58":{"turn":"B","r":5,"c":4,"wr":0.01},"13,21,22,40,47,48,56,60|11,14,20,23,29,30,31,42":{"turn":"B","r":4,"c":5,"wr":0.007},"20,21,30,33,40,42,43,44,56|23,24,25,32,41,48,51,52,58":{"turn":"B","r":5,"c":4,"wr":0.002},"20,21,30,33,39,40,42,43,44,56|23,24,25,32,41,47,48,51,52,58":{"turn":"B","r":5,"c":1,"wr":0.001},"20,22,48|40,49,58":{"turn":"B","r":3,"c":6,"wr":0.403},"13,20,32,38|33,40,41,42":{"turn":"B","r":6,"c":4,"wr":0.498},"13,20,23,32,38|16,33,40,41,42":{"turn":"B","r":6,"c":4,"wr":0.502},"13,20,23,32,38,39|16,33,40,41,42,56":{"turn":"B","r":6,"c":4,"wr":0.448},"13,20,23,32,38,39,58|16,33,40,41,42,56,67":{"turn":"B","r":7,"c":3,"wr":0.577},"13,20,23,32,38,39,49,58|16,33,40,41,42,46,56,67":{"turn":"B","r":7,"c":3,"wr":0.603},"13,20,22,23,32,38,39,49,58|16,33,40,41,42,46,56,64,67":{"turn":"B","r":6,"c":6,"wr":0.319},"13,20,22,23,32,38,39,43,49,58|16,33,40,41,42,46,56,60,64,67":{"turn":"B","r":7,"c":3,"wr":0.033},"30|60":{"turn":"B","r":5,"c":5,"wr":0.547},"20,32|56,59":{"turn":"B","r":5,"c":6,"wr":0.507},"20,24,30|38,57,60":{"turn":"B","r":6,"c":4,"wr":0.326},"20,22,24,30|38,42,57,60":{"turn":"B","r":5,"c":5,"wr":0.089},"20,22,24,30,40|34,38,42,57,60":{"turn":"B","r":6,"c":4,"wr":0.094},"20,21,30,38,40,56|13,22,33,58,60,66":{"turn":"B","r":4,"c":6,"wr":0.051},"20,21,30,38,40,49,56|13,22,33,58,60,64,66":{"turn":"B","r":5,"c":6,"wr":0.07},"20,21,30,38,40,42,49,56|13,22,33,43,58,60,64,66":{"turn":"B","r":3,"c":7,"wr":0.059},"20,21,30,38,40,41,42,49,56|13,22,33,34,43,58,60,64,66":{"turn":"B","r":7,"c":2,"wr":0.008},"20,21,24,30,38,40,41,42,49,56|13,15,22,33,34,43,58,60,64,66":{"turn":"B","r":7,"c":2,"wr":0.004},"40|20":{"turn":"B","r":2,"c":3,"wr":0.498},"22,40|20,56":{"turn":"B","r":6,"c":4,"wr":0.579},"22,39,40|24,56,60":{"turn":"B","r":4,"c":6,"wr":0.498},"22,39,40,58|20,24,56,60":{"turn":"B","r":4,"c":6,"wr":0.622},"13,31,38,40,42|20,24,56,58,60":{"turn":"B","r":6,"c":1,"wr":0.612},"12,22,37,39,40,58|20,24,33,42,56,60":{"turn":"B","r":7,"c":3,"wr":0.9},"12,22,37,39,40,58,66|20,24,33,42,51,56,60":{"turn":"B","r":7,"c":5,"wr":0.966},"12,14,22,37,39,40,58,66|20,24,31,33,42,51,56,60":{"turn":"B","r":3,"c":3,"wr":0.977},"10,12,14,22,40,41,43,58,68|20,24,29,30,31,38,47,56,60":{"turn":"B","r":3,"c":5,"wr":0.963},"10,12,14,22,40,41,43,58,66,68|20,24,29,30,31,38,47,49,56,60":{"turn":"B","r":5,"c":6,"wr":0.839},"30|32":{"turn":"B","r":5,"c":4,"wr":0.512},"30,32|29,48":{"turn":"B","r":2,"c":2,"wr":0.523},"21,32,50|22,23,30":{"turn":"B","r":3,"c":4,"wr":0.459},"20,21,32,50|22,23,30,31":{"turn":"B","r":4,"c":1,"wr":0.318},"20,21,32,33,50|16,22,23,30,31":{"turn":"B","r":4,"c":1,"wr":0.502},"20,21,32,33,47,50|16,22,23,30,31,48":{"turn":"B","r":3,"c":2,"wr":0.475},"20,21,32,33,39,47,50|16,22,23,30,31,48,57":{"turn":"B","r":4,"c":4,"wr":0.449},"20,21,32,33,39,40,47,50|16,22,23,30,31,48,57,68":{"turn":"B","r":3,"c":2,"wr":0.883},"20,21,32,33,38,39,40,47,50|16,22,23,30,31,48,56,57,68":{"turn":"B","r":7,"c":6,"wr":0.807},"20,21,24,32,33,38,39,40,47,50|12,16,22,23,30,31,48,56,57,68":{"turn":"B","r":6,"c":5,"wr":0.911},"22,40|20,31":{"turn":"B","r":3,"c":3,"wr":0.694},"22,30,40|24,31,32":{"turn":"B","r":4,"c":3,"wr":0.601},"21,40,42,50|24,32,41,59":{"turn":"B","r":5,"c":4,"wr":0.761},"20,22,30,40,51|21,24,29,31,32":{"turn":"B","r":4,"c":3,"wr":0.756},"12,20,22,30,40,51|21,24,29,31,32,39":{"turn":"B","r":2,"c":3,"wr":0.56},"12,20,22,30,40,49,51|21,24,29,31,32,39":{"turn":"B","r":2,"c":1,"wr":0.349},"11,12,20,22,30,40,49,51|1,21,24,29,31,32,39":{"turn":"B","r":3,"c":3,"wr":0.727},"11,12,20,22,30,40,49,51,56|1,21,24,29,31,32,38,39":{"turn":"B","r":1,"c":5,"wr":0.897},"11,12,20,22,30,40,49,51,56|1,13,21,24,29,31,32,38,39":{"turn":"B","r":1,"c":5,"wr":0.965},"12,21,32,50|22,23,30,31":{"turn":"B","r":5,"c":3,"wr":0.119},"12,21,32,41,50|20,22,23,30,31":{"turn":"B","r":5,"c":3,"wr":0.104},"12,21,29,32,41,50|11,20,22,23,30,31":{"turn":"B","r":5,"c":3,"wr":0.097},"21,27,28,29,48,49,50|19,20,22,30,38,39,47":{"turn":"B","r":1,"c":3,"wr":0.023},"12,21,27,28,29,48,49,50|13,19,20,22,30,38,39,47":{"turn":"B","r":6,"c":2,"wr":0.006},"11,12,21,27,28,29,48,49,50|10,13,19,20,22,30,38,39,47":{"turn":"B","r":6,"c":2,"wr":0.004},"11,12,21,27,28,29,31,48,49,50|10,13,19,20,22,30,38,39,47,65":{"turn":"B","r":6,"c":2,"wr":0.019},"30|33":{"turn":"B","r":4,"c":5,"wr":0.534},"20,32|21,29":{"turn":"B","r":3,"c":3,"wr":0.514},"11,20,48|21,29,39":{"turn":"B","r":5,"c":2,"wr":0.296},"11,20,48,57|21,29,39,40":{"turn":"B","r":5,"c":5,"wr":0.169},"11,20,38,48,57|21,28,29,39,40":{"turn":"B","r":2,"c":4,"wr":0.045},"11,20,38,47,48,57|12,21,28,29,39,40":{"turn":"B","r":5,"c":6,"wr":0.009},"11,20,22,38,47,48,57|12,14,21,28,29,39,40":{"turn":"B","r":5,"c":5,"wr":0.009},"11,20,22,38,41,47,48,57|12,14,21,28,29,39,40,50":{"turn":"B","r":5,"c":4,"wr":0.061},"11,20,22,32,38,41,47,48,57|12,14,21,28,29,39,40,42,50":{"turn":"B","r":5,"c":4,"wr":0.167},"11,20,22,23,32,38,41,47,48,57|12,14,21,28,29,33,39,40,42,50":{"turn":"B","r":5,"c":4,"wr":0.088},"22,48|23,31":{"turn":"B","r":3,"c":3,"wr":0.409},"22,30,50|20,21,31":{"turn":"B","r":3,"c":5,"wr":0.477},"21,32,42,48|24,33,41,51":{"turn":"B","r":6,"c":5,"wr":0.283},"13,22,30,47,50|14,20,21,23,31":{"turn":"B","r":3,"c":5,"wr":0.439},"13,22,30,32,47,50|14,20,21,23,31,40":{"turn":"B","r":4,"c":5,"wr":0.514},"13,22,30,32,39,48,51|12,21,23,24,31,40,41":{"turn":"B","r":4,"c":6,"wr":0.573},"13,22,29,30,32,41,47,50|14,20,21,23,31,38,39,40":{"turn":"B","r":5,"c":3,"wr":0.066},"12,21,23,30,37,38,48,49,50|13,20,22,29,31,39,40,46,47":{"turn":"B","r":1,"c":5,"wr":0.113},"13,22,27,28,29,30,32,41,47,50|14,20,21,23,31,36,37,38,39,40":{"turn":"B","r":5,"c":4,"wr":0.064},"21,50|12,20":{"turn":"B","r":3,"c":2,"wr":0.66},"21,22,50|12,20,57":{"turn":"B","r":3,"c":2,"wr":0.643},"21,22,38,50|12,20,39,57":{"turn":"B","r":3,"c":2,"wr":0.644},"21,22,38,48,50|12,20,39,47,57":{"turn":"B","r":5,"c":4,"wr":0.352},"21,22,38,48,49,50|12,20,37,39,47,57":{"turn":"B","r":6,"c":2,"wr":0.279},"20,22,30,33,39,42,48|12,13,21,24,29,31,34":{"turn":"B","r":2,"c":7,"wr":0.623},"20,22,30,33,39,42,48,50|12,13,21,24,28,29,31,34":{"turn":"B","r":4,"c":2,"wr":0.368},"20,22,23,30,33,39,42,48,50|12,13,21,24,28,29,31,32,34":{"turn":"B","r":4,"c":1,"wr":0.356},"20,22,23,30,33,39,41,42,48,50|12,13,14,21,24,28,29,31,32,34":{"turn":"B","r":5,"c":1,"wr":0.183},"13,22,48|23,30,31":{"turn":"B","r":3,"c":5,"wr":0.362},"13,22,30,50|21,29,31,32":{"turn":"B","r":4,"c":3,"wr":0.566},"13,22,30,39,50|12,21,29,31,32":{"turn":"B","r":2,"c":6,"wr":0.609},"13,22,30,39,48,50|12,14,21,29,31,32":{"turn":"B","r":2,"c":2,"wr":0.35},"30,31,32,36,37,38,50|21,28,29,39,46,48,55":{"turn":"B","r":2,"c":2,"wr":0.379},"20,30,31,32,36,37,38,50|19,21,28,29,39,46,48,55":{"turn":"B","r":1,"c":2,"wr":0.403},"11,20,30,31,32,36,37,38,50|10,19,21,28,29,39,46,48,55":{"turn":"B","r":1,"c":3,"wr":0.396},"11,20,30,31,32,36,37,38,47,50|10,19,21,28,29,39,46,48,55,57":{"turn":"B","r":1,"c":3,"wr":0.259},"30|24":{"turn":"B","r":6,"c":4,"wr":0.527},"21,32|12,20":{"turn":"B","r":3,"c":2,"wr":0.623},"21,30,32|12,20,51":{"turn":"B","r":6,"c":5,"wr":0.57},"11,21,30,32|10,12,20,51":{"turn":"B","r":6,"c":5,"wr":0.469},"11,19,21,30,32|10,12,20,29,51":{"turn":"B","r":4,"c":2,"wr":0.226},"11,19,21,30,32,38|10,12,20,29,34,51":{"turn":"B","r":3,"c":1,"wr":0.77},"11,12,19,22,29,30,48|10,20,21,28,42,59,66":{"turn":"B","r":3,"c":7,"wr":0.843},"11,12,19,22,29,30,39,48|10,20,21,24,28,42,59,66":{"turn":"B","r":7,"c":5,"wr":0.261},"11,12,19,22,29,30,33,39,48|10,20,21,24,28,32,42,59,66":{"turn":"B","r":3,"c":7,"wr":0.323},"11,12,19,22,29,30,31,33,39,48|10,20,21,24,28,32,34,42,59,66":{"turn":"B","r":7,"c":2,"wr":0.059},"30|20":{"turn":"B","r":2,"c":5,"wr":0.545},"21,32|24,33":{"turn":"B","r":5,"c":5,"wr":0.562},"21,23,30|20,29,38":{"turn":"B","r":6,"c":5,"wr":0.522},"21,23,30,47|20,29,38,46":{"turn":"B","r":5,"c":5,"wr":0.481},"20,21,32,33,51|12,22,23,24,31":{"turn":"B","r":5,"c":2,"wr":0.381},"12,21,23,30,47,56|20,29,38,39,40,46":{"turn":"B","r":6,"c":5,"wr":0.354},"12,21,23,30,37,47,56|20,29,38,39,40,45,46":{"turn":"B","r":6,"c":5,"wr":0.391},"12,13,23,24,28,29,30,47|5,11,14,20,21,22,31,40":{"turn":"B","r":5,"c":6,"wr":0.203},"12,13,23,24,28,29,30,41,47|5,11,14,20,21,22,31,40,49":{"turn":"B","r":1,"c":6,"wr":0.178},"12,13,23,24,28,29,30,41,42,47|5,11,14,19,20,21,22,31,40,49":{"turn":"B","r":6,"c":3,"wr":0.281},"20,22,30,33,42,48|21,24,29,31,34,39":{"turn":"B","r":1,"c":3,"wr":0.091},"20,22,30,32,38,57,58|12,21,29,31,39,56,66":{"turn":"B","r":5,"c":2,"wr":0.062},"20,22,30,32,38,40,57,58|12,21,29,30,31,39,56,66":{"turn":"B","r":5,"c":2,"wr":0.01},"20,22,23,30,32,38,40,57,58|12,21,29,30,31,39,56,60,66":{"turn":"B","r":7,"c":4,"wr":0.009},"20,22,23,30,32,38,40,41,57,58|12,21,29,30,31,39,56,60,66,67":{"turn":"B","r":6,"c":5,"wr":0.008},"|":{"turn":"B","r":4,"c":5,"wr":0.466},"21,48|32,47":{"turn":"B","r":6,"c":2,"wr":0.546},"20,30,33|21,22,50":{"turn":"B","r":3,"c":4,"wr":0.629},"20,21,30,57|23,29,38,50":{"turn":"B","r":4,"c":3,"wr":0.535},"12,23,50,59,60|30,32,42,51,57":{"turn":"B","r":2,"c":6,"wr":0.389},"12,23,24,32,59,66|21,30,33,42,48,50":{"turn":"B","r":6,"c":4,"wr":0.464},"12,23,24,32,59,60,66|21,30,33,41,42,48,50":{"turn":"B","r":1,"c":2,"wr":0.686},"11,12,23,24,32,59,60,66|21,30,33,39,41,42,48,50":{"turn":"B","r":6,"c":2,"wr":0.983},"20,50|23,30":{"turn":"B","r":3,"c":2,"wr":0.381},"20,21,50|30,39,47":{"turn":"B","r":3,"c":5,"wr":0.815},"20,21,22,50|23,30,39,47":{"turn":"B","r":3,"c":5,"wr":0.802},"20,21,22,32,50|14,23,30,39,47":{"turn":"B","r":3,"c":6,"wr":0.924},"20,21,22,24,32,50|14,23,30,39,41,47":{"turn":"B","r":4,"c":6,"wr":0.961},"20,21,22,24,32,33,50|14,23,30,39,40,41,47":{"turn":"B","r":4,"c":6,"wr":0.984},"20,21,22,24,32,33,50,51|5,14,23,30,39,40,41,47":{"turn":"B","r":6,"c":3,"wr":0.993},"21,40,42,50|24,32,33,41":{"turn":"B","r":5,"c":4,"wr":0.791},"13,22,30,40,51|21,23,24,31,32":{"turn":"B","r":3,"c":2,"wr":0.644},"13,20,22,30,40,51|12,21,23,24,31,32":{"turn":"B","r":1,"c":2,"wr":0.723},"11,13,20,22,30,40,51|12,21,23,24,29,31,32":{"turn":"B","r":4,"c":3,"wr":0.995},"11,13,20,22,30,39,40,51|12,21,23,24,29,31,32,42":{"turn":"B","r":4,"c":7,"wr":0.998},"12,23,24,32,59,66|21,33,41,42,48,50":{"turn":"B","r":6,"c":6,"wr":0.472},"12,23,24,32,59,60,66|21,33,39,41,42,48,50":{"turn":"B","r":2,"c":2,"wr":0.717},"21,40|11,20":{"turn":"B","r":4,"c":2,"wr":0.63},"13,21,40|11,20,22":{"turn":"B","r":2,"c":5,"wr":0.721},"13,21,23,40|11,14,20,22":{"turn":"B","r":3,"c":4,"wr":0.903},"11,13,21,23,40|12,15,20,22,24":{"turn":"B","r":3,"c":4,"wr":0.902},"11,13,21,23,31,40|12,15,20,22,24,32":{"turn":"B","r":4,"c":6,"wr":0.994},"11,13,21,23,29,31,40|12,15,19,20,22,24,32":{"turn":"B","r":4,"c":6,"wr":0.997},"11,13,21,23,28,29,31,40|12,15,19,20,22,24,32,41":{"turn":"B","r":5,"c":5,"wr":0.993},"21,40|22,24":{"turn":"B","r":3,"c":4,"wr":0.549},"21,30,40|22,23,24":{"turn":"B","r":6,"c":3,"wr":0.841},"21,30,40,51|22,23,24,39":{"turn":"B","r":5,"c":3,"wr":0.947},"21,30,40,48,51|22,23,24,39,49":{"turn":"B","r":4,"c":2,"wr":0.986},"21,30,40,48,51,58|22,23,24,39,49,57":{"turn":"B","r":5,"c":5,"wr":0.991},"21,30,32,33,38,40,57|29,31,39,42,51,58,60":{"turn":"B","r":5,"c":3,"wr":0.995},"12,22,29,30,33,40,48,57|13,21,31,39,42,58,59,60":{"turn":"B","r":3,"c":5,"wr":0.996},"20,40|21,60":{"turn":"B","r":3,"c":3,"wr":0.498},"20,21,40|29,38,60":{"turn":"B","r":6,"c":4,"wr":0.719},"20,21,33,40|22,29,38,60":{"turn":"B","r":5,"c":3,"wr":0.782},"12,23,24,29,40|22,31,33,42,56":{"turn":"B","r":3,"c":5,"wr":0.587},"12,13,23,24,29,40|22,31,32,33,42,56":{"turn":"B","r":5,"c":3,"wr":0.595},"12,13,23,24,29,40,60|14,22,31,32,33,42,56":{"turn":"B","r":2,"c":7,"wr":0.685},"11,20,24,29,37,40,46,57|21,22,28,30,38,39,41,60":{"turn":"B","r":4,"c":6,"wr":0.853},"30,41|21,39":{"turn":"B","r":3,"c":2,"wr":0.636},"21,30,49|29,31,47":{"turn":"B","r":4,"c":3,"wr":0.76},"20,21,30,49|28,29,31,47":{"turn":"B","r":6,"c":2,"wr":0.799},"12,23,24,32,49|21,31,33,34,51":{"turn":"B","r":6,"c":6,"wr":0.738},"11,20,29,30,41,46|12,21,23,38,39,47":{"turn":"B","r":4,"c":1,"wr":0.711},"11,20,29,30,37,41,46|12,21,23,28,38,39,47":{"turn":"B","r":6,"c":2,"wr":0.969},"11,20,29,30,32,37,41,46|12,19,21,23,28,38,39,47":{"turn":"B","r":6,"c":2,"wr":0.965},"30,41|31,40":{"turn":"B","r":5,"c":4,"wr":0.278},"30,31,48|38,39,40":{"turn":"B","r":4,"c":5,"wr":0.203},"21,30,32,41|22,31,39,40":{"turn":"B","r":6,"c":5,"wr":0.101},"21,30,32,38,41|22,23,31,39,40":{"turn":"B","r":5,"c":2,"wr":0.246},"20,23,30,32,39,42|11,21,22,31,40,41":{"turn":"B","r":5,"c":6,"wr":0.216},"20,21,30,31,47,48,58|19,29,38,39,40,41,49":{"turn":"B","r":6,"c":5,"wr":0.235},"20,21,30,31,32,47,48,58|19,29,38,39,40,41,49,57":{"turn":"B","r":6,"c":2,"wr":0.284},"30,40|20,32":{"turn":"B","r":4,"c":5,"wr":0.539},"21,40,50|32,39,60":{"turn":"B","r":3,"c":4,"wr":0.618},"21,40,48,50|32,38,39,60":{"turn":"B","r":3,"c":4,"wr":0.764},"12,29,32,40,50|22,30,31,48,60":{"turn":"B","r":4,"c":3,"wr":0.765},"12,29,32,39,40,50|22,30,31,47,48,60":{"turn":"B","r":6,"c":5,"wr":0.874},"12,23,29,32,39,40,50|13,22,30,31,47,48,60":{"turn":"B","r":6,"c":5,"wr":0.946},"12,14,21,30,33,40,41,48|13,20,22,31,32,50,51,56":{"turn":"B","r":6,"c":3,"wr":0.991},"30,41|47,59":{"turn":"B","r":6,"c":6,"wr":0.533},"30,32,49|21,29,47":{"turn":"B","r":2,"c":2,"wr":0.493},"30,31,32,49|21,22,29,47":{"turn":"B","r":2,"c":5,"wr":0.561},"21,30,31,32,49|22,23,33,51,59":{"turn":"B","r":6,"c":4,"wr":0.656},"21,30,31,32,49,50|22,23,33,51,59,66":{"turn":"B","r":6,"c":4,"wr":0.587},"21,30,31,32,48,49,50|14,22,23,33,51,59,66":{"turn":"B","r":6,"c":6,"wr":0.458},"21,30,31,32,39,48,49,50|14,22,23,33,51,56,59,66":{"turn":"B","r":4,"c":6,"wr":0.059},"30,41|49,50":{"turn":"B","r":5,"c":6,"wr":0.529},"22,31,48|23,32,41":{"turn":"B","r":6,"c":5,"wr":0.478},"22,31,39,48|23,29,32,41":{"turn":"B","r":6,"c":5,"wr":0.453},"21,32,41,49,58|30,39,48,51,57":{"turn":"B","r":2,"c":2,"wr":0.57},"21,22,32,41,49,58|24,30,39,48,51,57":{"turn":"B","r":3,"c":7,"wr":0.752},"12,30,31,38,41,42,47|20,22,23,48,49,50,51":{"turn":"B","r":2,"c":3,"wr":0.95},"12,30,31,38,41,42,47,56|20,21,22,23,48,49,50,51":{"turn":"B","r":4,"c":7,"wr":0.133},"21,40|56,60":{"turn":"B","r":4,"c":6,"wr":0.536},"21,38,40|24,56,60":{"turn":"B","r":6,"c":4,"wr":0.575},"21,38,40,57|20,24,39,60":{"turn":"B","r":3,"c":3,"wr":0.789},"21,30,38,40,57|20,24,39,48,60":{"turn":"B","r":5,"c":4,"wr":0.905},"21,30,38,40,49,57|20,24,39,47,48,60":{"turn":"B","r":5,"c":1,"wr":0.955},"12,22,29,32,33,39,40|21,23,24,30,31,56,60":{"turn":"B","r":2,"c":2,"wr":0.98},"12,20,22,29,32,33,39,40|21,23,24,30,31,56,60,71":{"turn":"B","r":6,"c":4,"wr":0.999},"12,22,37,39,40,58|20,24,41,42,56,60":{"turn":"B","r":6,"c":3,"wr":0.883},"12,22,37,39,40,58,66|20,24,38,41,42,56,60":{"turn":"B","r":5,"c":2,"wr":0.88},"12,22,29,37,39,40,58,66|20,24,38,41,42,47,56,60":{"turn":"B","r":3,"c":1,"wr":0.913},"30|31":{"turn":"B","r":4,"c":4,"wr":0.542},"30,41|39,40":{"turn":"B","r":3,"c":4,"wr":0.567},"22,39,50|40,41,42":{"turn":"B","r":5,"c":4,"wr":0.418},"13,30,41,58|38,39,40,56":{"turn":"B","r":5,"c":5,"wr":0.514},"13,30,32,39,58|40,41,42,48,60":{"turn":"B","r":5,"c":2,"wr":0.44},"13,29,30,32,41,58|38,39,40,50,56,59":{"turn":"B","r":5,"c":4,"wr":0.056},"13,29,30,31,32,41,58|38,39,40,50,51,56,59":{"turn":"B","r":5,"c":4,"wr":0.032},"13,22,29,30,31,32,41,58|34,38,39,40,50,51,56,59":{"turn":"B","r":2,"c":7,"wr":0.004},"22|58":{"turn":"B","r":5,"c":4,"wr":0.48},"22,39|41,58":{"turn":"B","r":5,"c":4,"wr":0.505},"21,38,49|31,40,42":{"turn":"B","r":5,"c":3,"wr":0.573},"20,31,42,59|38,39,40,49":{"turn":"B","r":3,"c":5,"wr":0.846},"12,23,42,49,56|31,38,39,40,58":{"turn":"B","r":5,"c":5,"wr":0.817},"12,20,31,42,59,66|22,37,38,39,40,49":{"turn":"B","r":3,"c":5,"wr":0.945},"12,20,30,31,42,59,66|22,33,37,38,39,40,49":{"turn":"B","r":3,"c":5,"wr":0.797},"11,24,28,32,34,41,47,58|13,22,29,31,39,40,42,59":{"turn":"B","r":5,"c":5,"wr":0.778},"21,22,48|23,31,32":{"turn":"B","r":3,"c":3,"wr":0.471},"21,22,48,51|23,30,31,32":{"turn":"B","r":3,"c":2,"wr":0.353},"21,22,33,48,51|20,23,30,31,32":{"turn":"B","r":2,"c":6,"wr":0.218},"12,21,22,33,48,51|11,20,23,30,31,32":{"turn":"B","r":2,"c":6,"wr":0.139},"12,13,21,22,33,48,51|11,14,20,23,30,31,32":{"turn":"B","r":6,"c":2,"wr":0.007},"21,23,37,38,45,46,47,50|28,29,30,39,48,55,56,60":{"turn":"B","r":6,"c":5,"wr":0.001},"21,40|42,60":{"turn":"B","r":5,"c":5,"wr":0.49},"21,40,57|22,24,42":{"turn":"B","r":1,"c":4,"wr":0.608},"12,21,40,57|22,24,39,42":{"turn":"B","r":3,"c":3,"wr":0.606},"12,21,31,40,57|13,22,24,39,42":{"turn":"B","r":5,"c":3,"wr":0.732},"12,21,31,40,48,57|13,22,24,38,39,42":{"turn":"B","r":3,"c":3,"wr":0.729},"12,21,28,31,40,48,57|13,22,24,33,38,39,42":{"turn":"B","r":5,"c":5,"wr":0.933},"12,21,28,31,40,48,57,60|13,22,24,33,38,39,42,59":{"turn":"B","r":5,"c":5,"wr":0.967},"20,30,32|21,22,29":{"turn":"B","r":3,"c":4,"wr":0.591},"11,20,30,32|21,22,29,31":{"turn":"B","r":4,"c":3,"wr":0.234},"11,20,30,32,39|21,22,29,31,40":{"turn":"B","r":5,"c":3,"wr":0.267},"11,20,30,32,39,48|15,21,22,29,31,40":{"turn":"B","r":5,"c":4,"wr":0.643},"11,20,23,30,32,39,48|15,21,22,28,29,31,40":{"turn":"B","r":1,"c":5,"wr":0.425},"11,20,23,30,32,39,41,48|15,21,22,28,29,31,34,40":{"turn":"B","r":5,"c":4,"wr":0.979},"20,21,22,32,50|23,30,39,41,47":{"turn":"B","r":4,"c":6,"wr":0.928},"20,21,22,32,42,50|23,30,39,41,47,51":{"turn":"B","r":4,"c":4,"wr":0.976},"20,21,22,32,42,50,59|23,30,33,39,41,47,51":{"turn":"B","r":4,"c":4,"wr":0.905},"20,21,22,32,40,42,50,59|23,30,33,39,41,47,49,51":{"turn":"B","r":2,"c":6,"wr":0.998},"30|42":{"turn":"B","r":5,"c":5,"wr":0.536},"20,32|51,58":{"turn":"B","r":4,"c":6,"wr":0.489},"20,23,48|32,42,59":{"turn":"B","r":6,"c":4,"wr":0.465},"20,23,40,48|24,32,42,59":{"turn":"B","r":6,"c":4,"wr":0.226},"20,23,40,48,50|24,32,42,51,59":{"turn":"B","r":6,"c":4,"wr":0.184},"20,23,40,48,49,50|22,24,32,42,51,59":{"turn":"B","r":7,"c":5,"wr":0.01},"12,21,24,40,48,49,50|13,20,22,30,38,47,57":{"turn":"B","r":3,"c":4,"wr":0.037},"12,21,24,40,48,49,50,56|13,20,22,30,38,47,57,66":{"turn":"B","r":7,"c":2,"wr":0.058},"12,22,37,39,40,58|20,24,31,42,56,60":{"turn":"B","r":3,"c":5,"wr":0.744},"12,22,37,39,40,58,66|20,21,24,31,42,56,60":{"turn":"B","r":3,"c":5,"wr":0.394},"12,22,29,37,39,40,58,66|20,21,23,24,31,42,56,60":{"turn":"B","r":1,"c":4,"wr":0.309},"20,32|48,51":{"turn":"B","r":5,"c":5,"wr":0.365},"20,24,30|42,47,50":{"turn":"B","r":6,"c":4,"wr":0.375},"20,24,30,60|42,47,50,52":{"turn":"B","r":6,"c":4,"wr":0.628},"20,23,50,56,60|28,30,32,33,38":{"turn":"B","r":2,"c":4,"wr":0.583},"20,21,24,47,50,60|12,22,30,38,48,57":{"turn":"B","r":3,"c":4,"wr":0.25},"12,21,24,33,48,56,60|13,22,29,30,32,34,42":{"turn":"B","r":4,"c":5,"wr":0.153},"12,21,24,33,41,48,56,60|13,22,29,30,32,34,42,46":{"turn":"B","r":2,"c":7,"wr":0.54},"12,22,37,39,40,58|20,24,38,42,56,60":{"turn":"B","r":5,"c":2,"wr":0.631},"12,22,37,39,40,47,58|20,24,29,38,42,56,60":{"turn":"B","r":5,"c":3,"wr":0.797},"11,13,21,31,34,38,40,42|20,22,23,24,29,56,58,60":{"turn":"B","r":4,"c":3,"wr":0.756},"30|41":{"turn":"B","r":5,"c":4,"wr":0.499},"20,32|49,51":{"turn":"B","r":4,"c":6,"wr":0.416},"20,24,48|41,59,66":{"turn":"B","r":3,"c":4,"wr":0.545},"20,24,48,50|39,47,57,68":{"turn":"B","r":5,"c":4,"wr":0.417},"20,24,48,49,50|29,39,47,57,68":{"turn":"B","r":6,"c":2,"wr":0.43},"20,24,30,48,49,50|29,39,47,56,57,68":{"turn":"B","r":3,"c":1,"wr":0.493},"20,24,30,40,48,49,50|28,29,39,47,56,57,68":{"turn":"B","r":4,"c":2,"wr":0.612},"20,22,30,32,40,41,50,56|12,13,21,23,24,31,33,52":{"turn":"B","r":6,"c":6,"wr":0.702},"22,40|56,60":{"turn":"B","r":6,"c":4,"wr":0.507},"22,38,40|24,57,60":{"turn":"B","r":4,"c":6,"wr":0.527},"11,22,40,42|24,29,56,60":{"turn":"B","r":5,"c":6,"wr":0.462},"11,22,34,40,42|24,29,56,58,60":{"turn":"B","r":6,"c":7,"wr":0.287},"11,19,22,34,40,42|24,29,41,56,58,60":{"turn":"B","r":3,"c":5,"wr":0.336},"11,19,22,32,34,40,42|24,29,41,50,56,58,60":{"turn":"B","r":5,"c":7,"wr":0.35},"11,12,22,30,38,40,55,65|20,23,24,31,32,42,57,60":{"turn":"B","r":1,"c":5,"wr":0.275},"20,22,24,30,40,51|34,38,42,52,57,60":{"turn":"B","r":6,"c":4,"wr":0.038},"20,22,24,30,40,50,51|34,38,42,52,57,59,60":{"turn":"B","r":5,"c":2,"wr":0.014},"20,22,24,30,40,41,50,51|16,34,38,42,52,57,59,60":{"turn":"B","r":6,"c":2,"wr":0.024},"30,40|20,24":{"turn":"B","r":5,"c":6,"wr":0.522},"22,40,48|20,56,60":{"turn":"B","r":5,"c":2,"wr":0.593},"21,32,38,40|20,24,50,60":{"turn":"B","r":3,"c":6,"wr":0.56},"21,22,29,40,48|19,20,50,56,60":{"turn":"B","r":6,"c":3,"wr":0.695},"12,21,29,32,38,40|11,20,24,39,50,60":{"turn":"B","r":5,"c":4,"wr":0.874},"12,21,29,32,33,38,40|11,20,24,31,39,50,60":{"turn":"B","r":5,"c":3,"wr":0.985},"12,21,29,32,33,38,40,48|11,20,24,31,39,49,50,60":{"turn":"B","r":3,"c":3,"wr":0.989},"30,31,48|21,22,32":{"turn":"B","r":2,"c":2,"wr":0.478},"13,39,48,50|30,31,38,47":{"turn":"B","r":6,"c":2,"wr":0.341},"13,39,48,50,56|30,31,33,38,47":{"turn":"B","r":3,"c":2,"wr":0.521},"13,30,41,48,50,60|21,29,31,32,42,51":{"turn":"B","r":4,"c":3,"wr":0.317},"13,30,39,41,48,50,60|12,21,29,31,32,42,51":{"turn":"B","r":3,"c":6,"wr":0.395},"13,22,30,39,41,48,50,60|12,21,29,31,32,33,42,51":{"turn":"B","r":2,"c":2,"wr":0.435},"20|60":{"turn":"B","r":5,"c":5,"wr":0.52},"20,33|56,60":{"turn":"B","r":5,"c":5,"wr":0.538},"20,33,58|23,56,60":{"turn":"B","r":3,"c":5,"wr":0.599},"20,21,42,56|24,29,30,60":{"turn":"B","r":3,"c":5,"wr":0.544},"20,21,31,42,56|24,29,30,35,60":{"turn":"B","r":6,"c":4,"wr":0.919},"20,21,31,39,42,56|24,29,30,35,38,60":{"turn":"B","r":4,"c":4,"wr":0.96},"20,21,31,39,42,48,56|24,29,30,35,38,60,64":{"turn":"B","r":3,"c":6,"wr":0.973},"11,23,24,31,38,41,50,60|20,22,27,32,33,42,56,70":{"turn":"B","r":2,"c":3,"wr":0.867}};
// </KATAGO_BOOK_DATA>
function katagoBookMove(b, koB, koActive, player) {
    var tb = [], tw = [], i;
    for (i = 0; i < 81; i++) {
        if (b[i] === BLACK)
            tb.push(i);
        else if (b[i] === WHITE)
            tw.push(i);
    }
    var best = null, bestT = 0;
    for (var t = 0; t < 8; t++) {
        var xb = [], xw = [];
        for (i = 0; i < tb.length; i++) {
            var pb = symApply(t, Math.floor(tb[i] / 9), tb[i] % 9);
            xb.push(pb[0] * 9 + pb[1]);
        }
        for (i = 0; i < tw.length; i++) {
            var pw = symApply(t, Math.floor(tw[i] / 9), tw[i] % 9);
            xw.push(pw[0] * 9 + pw[1]);
        }
        xb.sort(function (a, c) { return a - c; });
        xw.sort(function (a, c) { return a - c; });
        var k = xb.join(',') + '|' + xw.join(',');
        if (best === null || k < best) {
            best = k;
            bestT = t;
        }
    }
    var ent = KATAGO_BOOK[best];
    if (!ent)
        return null;
    if (ent.turn !== (player === BLACK ? 'B' : 'W'))
        return null; // wrong side to move (transposed entry)
    var bk = symApply(SYM_INV[bestT], ent.r, ent.c);
    if (boardIndex(bk[0], bk[1]) < 0 || b[bk[0] * 9 + bk[1]] !== EMPTY)
        return null;
    if (!simLegal(b, koB, koActive, player, bk[0], bk[1]))
        return null;
    return bk;
}

// ---- fuseki replies, moves 2-9 (item C) ----
// After the 2-move canonical opening, answer 4-4 approaches with the
// pro-style enclosure instead of improvising. Open points belong to the
// strategy layer (quiet-strategy branch in the reply path), which weighs
// fight proximity — the old emptiest-quadrant scatter is gone (it played
// isolated 2nd-line points like C7, -27pp, while frameworks grew).
// Strict gates: exact stone count (a capture means fighting started), no
// orthogonal B-W contact anywhere (contact means fighting started),
// replies verified empty+legal. Returns [r, c] or null (→ strategy/search).
var FUSEKI_CORNERS44 = [[3, 3], [3, 5], [5, 3], [5, 5]];

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
    // Enclosure replies only. The old emptiest-quadrant scatter was
    // removed (docs/eval.md): maximizing distance from stones plays
    // isolated 2nd-line points like C7 (-27pp) while the opponent builds
    // a framework. Open points belong to the strategy layer, which weighs
    // fight proximity instead of distance.
    return fusekiEnclosure(b, koB, koActive, player, lastR, lastC);
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

    // Pre-search tactics + quiet strategy (scratch is free: no search ran
    // yet this request). (a) Verified escapes and sound 2-lib defenses
    // play immediately — no reason to search a forced reply. Tier-1 kills
    // stay with the shortcut above (snapback caution) and the post-search
    // backstop. (b) With NO forced tactic and the game still open, play
    // the static big point INSTEAD of searching — even when unverified
    // 2-lib skirmishes exist. Rationale (docs/eval.md): the search returns
    // 2%-winrate consolidations (D7) where KataGo plays the center (F6);
    // non-forced skirmishes are by definition non-urgent, and tenuki-ing
    // them for the big point is usually correct urgent-vs-big judgment.
    var preInfo = {};
    var preMoves = getLegalMovesOn(gBoard, gKoBoard, gKoActive,
                                   currentPlayer);
    var preIdx = findTacticalMove(gBoard, gKoBoard, gKoActive, currentPlayer,
                                  preMoves, lastRow, lastCol, preInfo, true);
    // Tier-2 escapes force only to strength (3+ libs post-move):
    // running to 2 libs inside a squeeze donates (F3: 6% vs E3: 65%).
    var preForced = false;
    if (preIdx >= 0) {
        if (preInfo.cap) {
            // Capturing tactics: concrete gain, always forced (snapback
            // guards already passed inside; Tier-1 kills stay with the
            // shortcut above and the post-search backstop).
            preForced = true;
        } else if (preInfo.tier === 2 || preInfo.t3def || preInfo.t3small) {
            // Escapes and breakouts: forced only when sound (uniform
            // predicate: urgency + direction + liveness). Plain attacks
            // stay prior-only.
            var prt = preMoves[preIdx].r, pct = preMoves[preIdx].c;
            preForced = forceDefenseOk(gBoard, gKoBoard, gKoActive,
                                       currentPlayer, prt, pct);
        }
    }
    // KataGo-distilled book (plies 0-24, tools/eval/make_book.js): verified
    // replies outrank heuristics (cut/strategy/search) but not the
    // immediate tactics above. Handles transpositions via canonical hash.
    var kbMove = katagoBookMove(gBoard, gKoBoard, gKoActive, currentPlayer);
    if (kbMove) {
        console.log('pkjs: book plays (' + kbMove[0] + ',' + kbMove[1] + ')');
        sendMoveReply(kbMove[0], kbMove[1], 0);
        ponderStart(kbMove[0], kbMove[1], 0, currentPlayer);
        return;
    }
    // Eye-divider force: making two eyes is life, as urgent as a kill.
    // (Survival when ahead — convert winning positions instead of
    // donating them. Dividers are verified sound here: legal, not
    // self-atari, not dead on arrival. Solidifiers stay prior-only.)
    // Runs after the distilled book (verified replies handle life when
    // the position is known) and before cut answers.
    var eyeIdx = findEyeMove(gBoard, gKoBoard, gKoActive,
                             currentPlayer, preMoves);
    if (eyeIdx >= 0) {
        var er = preMoves[eyeIdx].r, ec = preMoves[eyeIdx].c;
        if (simLegal(gBoard, gKoBoard, gKoActive, currentPlayer, er, ec) &&
            !putsSelfInAtari(gBoard, gKoBoard, gKoActive, currentPlayer, er, ec) &&
            !lifeStoneDeadOnArrival(gBoard, gKoBoard, gKoActive, currentPlayer, er, ec)) {
            console.log('pkjs: eye divider (' + er + ',' + ec + ')');
            sendMoveReply(er, ec, 0);
            ponderStart(er, ec, 0, currentPlayer);
            return;
        }
    }
    // Capturing-race reader: behind-or-even eyeless contact fights play
    // the best liberty-differential move (semeaiMove verifies legality by
    // simulation). Skips comfortably-ahead races. Tactical safety (no
    // self-atari/eye-fill); no dead-arrival veto (eyeless is the premise).
    // Mid-game only (movesMade >= 10): opening "races" are skirmishes
    // best left to tactics/strategy (F6 misfire: -20pp on move 4).
    // Ablation flag PEBBLE_NO_SEMEAI=1 (default off = enabled).
    var noSemeai = (typeof process !== 'undefined' && process.env &&
                    process.env.PEBBLE_NO_SEMEAI === '1');
    var sem = (noSemeai || movesMade < 10) ? null :
        semeaiMove(gBoard, gKoBoard, gKoActive, currentPlayer);
    if (sem) {
        if (simLegal(gBoard, gKoBoard, gKoActive, currentPlayer, sem[0], sem[1]) &&
            !putsSelfInAtari(gBoard, gKoBoard, gKoActive, currentPlayer, sem[0], sem[1]) &&
            !fillsOwnEye(gBoard, sem[0], sem[1], currentPlayer)) {
            console.log('pkjs: semeai race (' + sem[0] + ',' + sem[1] + ')');
            sendMoveReply(sem[0], sem[1], 0);
            ponderStart(sem[0], sem[1], 0, currentPlayer);
            return;
        }
    }
    // Live cut: some legal move joins 2+ own groups next to enemy stones
    // (an answered peep). Cuts need reading (which side, ladder, snapback),
    // not a static pick — search decides those; strategy takes the rest.
    var cutUrgent = false;
    for (var qi = 0; qi < preMoves.length && !cutUrgent; qi++) {
        var qr = preMoves[qi].r, qc = preMoves[qi].c;
        if (qr === MCTS_PASS_ROW)
            continue;
        if (connectCount(gBoard, currentPlayer, qr, qc) >= 2 &&
            hasOppNeighbor(gBoard, qr, qc, currentPlayer))
            cutUrgent = true;
    }
    if (preForced) {
        var fr2 = preMoves[preIdx].r, fc2 = preMoves[preIdx].c;
        if (simLegal(gBoard, gKoBoard, gKoActive, currentPlayer, fr2, fc2)) {
            console.log('pkjs: pre-search forced tier-' + preInfo.tier +
                        ' (' + fr2 + ',' + fc2 + ')');
            sendMoveReply(fr2, fc2, 0);
            ponderStart(fr2, fc2, 0, currentPlayer);
            return;
        }
    }
    // Forced cut answers: a live cut (conn2 + enemy neighbor) is answered
    // immediately, picked by strategy argmax among the cut points — NOT by
    // search (search misevaluates cuts: playouts never cut, so tenuki looks
    // free and the cut goes unanswered, e.g. split-walls (3,3) over (4,3)).
    // Same tactical safety as strategy picks; else fall through to search.
    if (!preForced && cutUrgent) {
        stratCompute(gBoard, currentPlayer);
        var cbi = -1, cbs = -99999;
        for (var cqi = 0; cqi < preMoves.length; cqi++) {
            var cqr = preMoves[cqi].r, cqc = preMoves[cqi].c;
            if (cqr === MCTS_PASS_ROW)
                continue;
            if (connectCount(gBoard, currentPlayer, cqr, cqc) >= 2 &&
                hasOppNeighbor(gBoard, cqr, cqc, currentPlayer) &&
                stratGrid[cqr * BOARD_SIZE + cqc] > cbs) {
                cbs = stratGrid[cqr * BOARD_SIZE + cqc];
                cbi = cqi;
            }
        }
        if (cbi >= 0) {
            var cbr = preMoves[cbi].r, cbc = preMoves[cbi].c;
            if (simLegal(gBoard, gKoBoard, gKoActive, currentPlayer, cbr, cbc) &&
                !putsSelfInAtari(gBoard, gKoBoard, gKoActive, currentPlayer, cbr, cbc) &&
                !fillsOwnEye(gBoard, cbr, cbc, currentPlayer) &&
                eyeSpaceVerdict(gBoard, gKoBoard, gKoActive, currentPlayer, cbr, cbc) !== 'kill' &&
                !lifeStoneDeadOnArrival(gBoard, gKoBoard, gKoActive, currentPlayer, cbr, cbc)) {
                console.log('pkjs: forced cut answer (' + cbr + ',' + cbc + ') strat=' + cbs);
                sendMoveReply(cbr, cbc, 0);
                ponderStart(cbr, cbc, 0, currentPlayer);
                return;
            }
        }
    }
    // Double-attack initiative vs small-group consolidation: a genuine
    // peep between stones (D4: 45%) is handled by the strategy press
    // bonus (adjacent enemies + room), which outranks consolidation in
    // the grid — no forcing needed. A lone squeeze (E3: 6%) must not
    // outrank the breakout (C4: 15%): small-group breakouts force below.
    // (A forcing double-attack reply was tried and removed: it cannot
    // tell a real peep (D4) from an empty corner touch (B2) — both match
    // the local pattern. Only reading separates them.)
    if (!preForced) {
        if (preIdx >= 0 && preInfo.tier === 3 && preInfo.t3small) {
            var sr3 = preMoves[preIdx].r, sc3 = preMoves[preIdx].c;
            // Same uniform predicate as preForced (urgency + direction +
            // liveness): C4 forces, C2/E1 fall through to strategy.
            if (simLegal(gBoard, gKoBoard, gKoActive, currentPlayer, sr3, sc3) &&
                forceDefenseOk(gBoard, gKoBoard, gKoActive,
                               currentPlayer, sr3, sc3)) {
                console.log('pkjs: small-group breakout (' + sr3 + ',' + sc3 + ')');
                sendMoveReply(sr3, sc3, 0);
                ponderStart(sr3, sc3, 0, currentPlayer);
                return;
            }
        }
    }
    if (!preForced && !cutUrgent && movesMade < 50) {
        stratCompute(gBoard, currentPlayer);
        // Argmax over grid + shape patterns (NO locality: v3-fitted +20
        // tested r29-30 and REJECTED — 150pp mean vs 105 baseline, variance
        // exploded (54 best but 210/213 worst). Ladder over fit.
        // Tree nodes carry eloc instead, with correct per-node context).
        // 1-ply tempo minimax over the top 3: don't leave a bigger reply
        // (F6 lets White take E6: -20pp; E6 first keeps 47%). value(move)
        // = grid(move) - oppBest(after), both raw grid scale.
        var stop3 = [];
        for (var ssi = 0; ssi < 81; ssi++) {
            if (gBoard[ssi] === EMPTY) {
                var ssr0 = Math.floor(ssi / BOARD_SIZE), ssc0 = ssi % BOARD_SIZE;
                var sv = stratGrid[ssi];
                sv += patBonus(gBoard, ssr0, ssc0, currentPlayer) * 10;
                stop3.push({ i: ssi, s: sv });
            }
        }
        stop3.sort(function (a, b) { return b.s - a.s; });
        var sbi = -1, sbs = -99999;
        var oppP = (currentPlayer === BLACK) ? WHITE : BLACK;
        for (var t3i = 0; t3i < stop3.length && t3i < 3; t3i++) {
            var tr = Math.floor(stop3[t3i].i / BOARD_SIZE);
            var tc = stop3[t3i].i % BOARD_SIZE;
            copyBoard(probeBoard, gBoard);
            copyBoard(probeKo, gKoBoard);
            var tres = simTryPlace(probeBoard, probeKo, gKoActive,
                                   currentPlayer, tr, tc);
            var tv;
            if (!tres.success) {
                tv = -99999;
            } else {
                stratCompute(probeBoard, oppP, stratGrid2);
                var ob = -99999;
                for (var oi = 0; oi < 81; oi++) {
                    if (probeBoard[oi] === EMPTY && stratGrid2[oi] > ob)
                        ob = stratGrid2[oi];
                }
                tv = stop3[t3i].s - ob;
            }
            if (tv > sbs) {
                sbs = tv;
                sbi = stop3[t3i].i;
            }
        }
        if (sbi >= 0 && sbs <= -99999 + 1) {
            // All sims failed (shouldn't happen): fall back to plain argmax.
            sbi = stop3.length ? stop3[0].i : -1;
            sbs = stop3.length ? stop3[0].s : -99999;
        }
        if (sbi >= 0) {
            var ssr = Math.floor(sbi / BOARD_SIZE), ssc = sbi % BOARD_SIZE;
            // Static pick, tactical safety: legal, not self-atari, not an
            // eye fill, not eye-killing, not dead on arrival. Else search.
            if (simLegal(gBoard, gKoBoard, gKoActive, currentPlayer, ssr, ssc) &&
                !putsSelfInAtari(gBoard, gKoBoard, gKoActive, currentPlayer, ssr, ssc) &&
                !fillsOwnEye(gBoard, ssr, ssc, currentPlayer) &&
                eyeSpaceVerdict(gBoard, gKoBoard, gKoActive, currentPlayer, ssr, ssc) !== 'kill' &&
                !lifeStoneDeadOnArrival(gBoard, gKoBoard, gKoActive, currentPlayer, ssr, ssc)) {
                console.log('pkjs: quiet strategy plays (' + ssr + ',' + ssc + ') tempo=' + sbs);
                sendMoveReply(ssr, ssc, 0);
                ponderStart(ssr, ssc, 0, currentPlayer);
                return;
            }
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
    // Eval-only override: PEBBLE_EVAL_ITERS=N fixes the search size (the
    // 20s time-box still backstops). Measures the architecture's ceiling
    // with deep reading; the phone path is unchanged (flag defaults off).
    if (typeof process !== 'undefined' && process.env &&
        process.env.PEBBLE_EVAL_ITERS) {
        var ei = parseInt(process.env.PEBBLE_EVAL_ITERS, 10);
        if (ei >= 100 && ei <= 200000)
            planIters = ei;
    }
    console.log('pkjs: running MCTS with up to ' + planIters + ' iterations (empties=' + planEmpties + ' tense=' + planTense + ')...');
    var startTime = Date.now();
    mctsRun(planIters, currentPlayer, lastRow, lastCol, consecutivePasses);
    var elapsed = Date.now() - startTime;
    console.log('pkjs: MCTS finished in ' + elapsed + 'ms');
    if (typeof process !== 'undefined' && process.env &&
        process.env.PEBBLE_PLAYOUT_STATS === '1' && plStatN > 0) {
        console.log('pkjs: playouts n=' + plStatN +
                    ' avgLen=' + (plStatMoves / plStatN).toFixed(1) +
                    ' avgTermEmpty=' + (plStatEmpty / plStatN).toFixed(1) +
                    ' endCap=' + plStatCap + ' endPass=' + plStatPass);
        plStatN = 0; plStatMoves = 0; plStatEmpty = 0; plStatCap = 0; plStatPass = 0;
    }

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
    // Forced root tactics: a verified Tier-1 kill, Tier-2 escape, or Tier-3
    // 2-lib attack/defense in the CURRENT position is played outright, not
    // ranked in the visit race (probes showed tactics losing the race to
    // shape-prior noise). The scan is FULL-board: Tier 3 is windowed
    // in-search for speed, but the reply must see fights anywhere.
    // Safety is established inside findTacticalMove: kills pass legality +
    // the snapback guard (killer ends >1 lib), escapes pass ladder +
    // dead-rescue verdicts and eye-fill/self-atari exclusions, forced
    // Tier-3 defenses need 3-lib extension/capture/supported-4+ and forced
    // attacks take stones off. Non-capturing Tier-3 attacks stay
    // prior-only: the cut/connection judgment belongs to the search.
    // Only legality is re-verified here (ko may have evolved); the move
    // must already have a root child (else fall back to the searched
    // choice).
    // NOTE: probeBoard/playBoard scratch is free here (search finished).
    var forcedNode = MCTS_NO_NODE;
    var forceInfo = {};
    var forceMoves = getLegalMovesOn(gBoard, gKoBoard, gKoActive,
                                     currentPlayer);
    var forceIdx = findTacticalMove(gBoard, gKoBoard, gKoActive,
                                    currentPlayer, forceMoves,
                                    lastRow, lastCol, forceInfo, true);
    // Defenses force only when sound (uniform predicate); captures and
    // Tier-1 kills bypass it (concrete gain / shortcut guards).
    var forceDef = false;
    if (forceIdx >= 0 && !forceInfo.cap && forceInfo.tier !== 1 &&
        (forceInfo.tier === 2 || forceInfo.t3def || forceInfo.t3small)) {
        var fr2 = forceMoves[forceIdx].r, fc2 = forceMoves[forceIdx].c;
        forceDef = true;
        if (!forceDefenseOk(gBoard, gKoBoard, gKoActive,
                            currentPlayer, fr2, fc2))
            forceDef = false;
    }
    if (forceIdx >= 0 && (forceInfo.tier === 1 || forceInfo.cap || forceDef)) {
        var fr = forceMoves[forceIdx].r, fc = forceMoves[forceIdx].c;
        if (simLegal(gBoard, gKoBoard, gKoActive, currentPlayer, fr, fc)) {
            var fch = nodePool[rootNode].firstChild;
            while (fch !== MCTS_NO_NODE && fch < MCTS_POOL_SIZE) {
                var fcn = nodePool[fch];
                if (fcn.moveRow === fr && fcn.moveCol === fc) {
                    forcedNode = fch;
                    break;
                }
                fch = fcn.nextSibling;
            }
            if (forcedNode !== MCTS_NO_NODE)
                console.log('pkjs: forced tier-' + forceInfo.tier +
                            ' (' + fr + ',' + fc + ')');
        }
    }
    if (forcedNode !== MCTS_NO_NODE)
        best = forcedNode;
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
    // Eval-only root dump (PEBBLE_DUMP_ROOT=1): all root children with
    // visits/wins/flags, for value-function diagnostics.
    if (typeof process !== 'undefined' && process.env &&
        process.env.PEBBLE_DUMP_ROOT === '1') {
        var drch = nodePool[rootNode].firstChild;
        var drl = [];
        while (drch !== MCTS_NO_NODE && drch < MCTS_POOL_SIZE) {
            var drc = nodePool[drch];
            var wr = drc.visits > 0 ? (100 * drc.wins / drc.visits).toFixed(0) : '-';
            drl.push('(' + drc.moveRow + ',' + drc.moveCol + ')v' + drc.visits +
                     'w' + wr + (drc.urg ? 'U' : '') + (drc.thr ? 'T' : '') +
                     (drc.t32 ? '3' : '') + (drc.cut ? 'C' : '') + (drc.eye ? 'E' + drc.eye : ''));
            drch = drc.nextSibling;
        }
        console.log('pkjs: rootchild ' + drl.join(' '));
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
