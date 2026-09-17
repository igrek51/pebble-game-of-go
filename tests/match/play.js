/*
 * AI-vs-AI match tool for the pkjs companion engine.
 *
 * Loads the REAL src/pkjs/pebble-js-app.js once (like the phone companion:
 * AMAF memory and RNG sequence persist across the whole game) and plays a
 * full 9x9 game to 2 consecutive passes, refereeing with independent rules.
 *
 * Usage: node tests/match/play.js [--max-moves N]
 *
 * End result: move statistics, final score, and the ending board as
 * ascii/emoji art (. empty, black stone, white stone).
 */
'use strict';

// No background pondering: the match must be fully synchronous so every
// reply is settled before the next request goes out.
process.env.PEBBLE_NO_PONDER = '1';

const path = require('path');
const { freshPebble } = require('../pkjs/mock_pebble');

const PKJS = path.resolve(__dirname, '../../src/pkjs/pebble-js-app.js');

const N = 9;
const EMPTY = 0, BLACK = 1, WHITE = 2;
const PASS_ROW = 9, PASS_COL = 9;
const MAX_MOVES = Number((process.argv.find((a) => a.startsWith('--max-moves=')) || '').split('=')[1]) || 300;

const idx = (r, c) => (r >= 0 && r < N && c >= 0 && c < N ? r * N + c : -1);
const opp = (p) => (p === BLACK ? WHITE : BLACK);
const pname = (p) => (p === BLACK ? 'Black' : 'White');

// ---- independent referee rules (mirrors the engine, written separately) ----

function libertiesOf(b, sr, sc) {
    const color = b[sr * N + sc];
    const seen = new Set([sr * N + sc]);
    const stack = [[sr, sc]];
    const libs = new Set();
    const dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    while (stack.length) {
        const [r, c] = stack.pop();
        for (let d = 0; d < 4; d++) {
            const nr = r + dr[d], nc = c + dc[d];
            const ni = idx(nr, nc);
            if (ni < 0 || seen.has(ni))
                continue;
            if (b[ni] === EMPTY) {
                seen.add(ni);
                libs.add(ni);
            } else if (b[ni] === color) {
                seen.add(ni);
                stack.push([nr, nc]);
            }
        }
    }
    return libs;
}

function removeGroup(b, sr, sc) {
    const color = b[sr * N + sc];
    const seen = new Set([sr * N + sc]);
    const stack = [[sr, sc]];
    let n = 0;
    while (stack.length) {
        const [r, c] = stack.pop();
        b[r * N + c] = EMPTY;
        n++;
        const dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
        for (let d = 0; d < 4; d++) {
            const ni = idx(r + dr[d], c + dc[d]);
            if (ni >= 0 && !seen.has(ni) && b[ni] === color) {
                seen.add(ni);
                stack.push([r + dr[d], c + dc[d]]);
            }
        }
    }
    return n;
}

// Returns { ok, captured } — never mutates on illegal moves.
function refereePlace(b, ko, player, r, c) {
    const i = idx(r, c);
    if (i < 0 || b[i] !== EMPTY)
        return { ok: false, captured: 0 };
    const snapshot = b.slice();
    b[i] = player;
    let captured = 0;
    const dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    for (let d = 0; d < 4; d++) {
        const ni = idx(r + dr[d], c + dc[d]);
        if (ni >= 0 && b[ni] === opp(player) && libertiesOf(b, r + dr[d], c + dc[d]).size === 0)
            captured += removeGroup(b, r + dr[d], c + dc[d]);
    }
    if (libertiesOf(b, r, c).size === 0) {
        for (let k = 0; k < 81; k++) b[k] = snapshot[k];
        return { ok: false, captured: 0 }; // suicide
    }
    if (ko.active) {
        let equal = true;
        for (let k = 0; k < 81; k++) {
            if (b[k] !== ko.board[k]) {
                equal = false;
                break;
            }
        }
        if (equal) {
            for (let k = 0; k < 81; k++) b[k] = snapshot[k];
            return { ok: false, captured: 0 }; // ko
        }
    }
    ko.board = snapshot;
    ko.active = captured > 0;
    return { ok: true, captured };
}

// Static life & death (compact port of src/c/logic/life.c): Benson's
// unconditionally-alive test plus confined-region removal. Only small
// enclosed regions count as evidence of death; shared regions (seki),
// open areas and big dragons are always kept.
const DEAD_REGION_MAX = 8;

function labelAll(b) {
    const block = new Array(81).fill(-1);
    const region = new Array(81).fill(-1);
    const blockColor = [];
    let nblocks = 0, nregions = 0;
    const flood = (sr, sc, labels, id, wantEmpty, color) => {
        const stack = [[sr, sc]];
        labels[sr * N + sc] = id;
        while (stack.length) {
            const [r, c] = stack.pop();
            const dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
            for (let d = 0; d < 4; d++) {
                const nr = r + dr[d], nc = c + dc[d];
                const ni = idx(nr, nc);
                if (ni < 0 || labels[ni] >= 0)
                    continue;
                if ((b[ni] === EMPTY) !== wantEmpty)
                    continue;
                if (!wantEmpty && b[ni] !== color)
                    continue;
                labels[ni] = id;
                stack.push([nr, nc]);
            }
        }
    };
    for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
            const i = r * N + c;
            if (b[i] !== EMPTY) {
                if (block[i] < 0) {
                    flood(r, c, block, nblocks, false, b[i]);
                    blockColor[nblocks] = b[i];
                    nblocks++;
                }
            } else if (region[i] < 0) {
                flood(r, c, region, nregions, true, 0);
                nregions++;
            }
        }
    }
    return { block, region, blockColor, nblocks, nregions };
}

function bensonAlive(b, lab, color) {
    const alive = new Array(81).fill(false);
    const X = [], R = [];
    for (let i = 0; i < lab.nblocks; i++)
        X[i] = lab.blockColor[i] === color;
    const enclosedBy = (r, col) => {
        let found = false;
        const dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
        for (let i = 0; i < 81; i++) {
            if (lab.region[i] !== r)
                continue;
            const row = Math.floor(i / N), cc = i % N;
            for (let d = 0; d < 4; d++) {
                const ni = idx(row + dr[d], cc + dc[d]);
                if (ni < 0 || b[ni] === EMPTY)
                    continue;
                if (b[ni] !== col)
                    return false;
                found = true;
            }
        }
        return found;
    };
    for (let i = 0; i < lab.nregions; i++)
        R[i] = enclosedBy(i, color);
    const vitalFor = (r, blk) => {
        const dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
        for (let i = 0; i < 81; i++) {
            if (lab.region[i] !== r)
                continue;
            const row = Math.floor(i / N), cc = i % N;
            let touches = false;
            for (let d = 0; d < 4; d++) {
                if (lab.block[idx(row + dr[d], cc + dc[d])] === blk) {
                    touches = true;
                    break;
                }
            }
            if (!touches)
                return false;
        }
        return true;
    };
    const supported = (r) => {
        const dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
        for (let i = 0; i < 81; i++) {
            if (lab.region[i] !== r)
                continue;
            const row = Math.floor(i / N), cc = i % N;
            for (let d = 0; d < 4; d++) {
                const ni = idx(row + dr[d], cc + dc[d]);
                if (ni < 0 || b[ni] === EMPTY)
                    continue;
                if (!X[lab.block[ni]])
                    return false;
            }
        }
        return true;
    };
    let changed = true;
    while (changed) {
        changed = false;
        for (let blk = 0; blk < lab.nblocks; blk++) {
            if (!X[blk])
                continue;
            let vital = 0;
            for (let r = 0; r < lab.nregions; r++) {
                if (R[r] && vitalFor(r, blk) && ++vital >= 2)
                    break;
            }
            if (vital < 2) {
                X[blk] = false;
                changed = true;
            }
        }
        for (let r = 0; r < lab.nregions; r++) {
            if (R[r] && !supported(r)) {
                R[r] = false;
                changed = true;
            }
        }
    }
    for (let i = 0; i < 81; i++) {
        if (lab.block[i] >= 0 && X[lab.block[i]])
            alive[i] = true;
    }
    return alive;
}

function regionSize(lab, r) {
    let n = 0;
    for (let i = 0; i < 81; i++) {
        if (lab.region[i] === r)
            n++;
    }
    return n;
}

function blockConfinedDead(b, lab, blk, opp) {
    const seen = {};
    const dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    for (let i = 0; i < 81; i++) {
        if (lab.block[i] !== blk)
            continue;
        const row = Math.floor(i / N), col = i % N;
        for (let d = 0; d < 4; d++) {
            const ni = idx(row + dr[d], col + dc[d]);
            if (ni < 0 || b[ni] !== EMPTY)
                continue;
            const r = lab.region[ni];
            if (seen[r])
                continue;
            seen[r] = true;
            if (regionSize(lab, r) > DEAD_REGION_MAX)
                return false;
            let oppFound = false;
            for (let j = 0; j < 81; j++) {
                if (lab.region[j] !== r)
                    continue;
                const jr = Math.floor(j / N), jc = j % N;
                for (let e = 0; e < 4; e++) {
                    const ki = idx(jr + dr[e], jc + dc[e]);
                    if (ki < 0 || b[ki] === EMPTY || lab.block[ki] === blk)
                        continue;
                    if (b[ki] !== opp)
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

// In-place dead removal on w. Returns { black, white } stones removed.
function removeDeadStones(w) {
    const removed = { black: 0, white: 0 };
    for (let round = 0; round < 10; round++) {
        const lab = labelAll(w);
        const aliveB = bensonAlive(w, lab, BLACK);
        const aliveW = bensonAlive(w, lab, WHITE);
        const kill = new Array(lab.nblocks).fill(false);
        let nkill = 0;
        for (let blk = 0; blk < lab.nblocks; blk++) {
            let isAlive = false;
            for (let i = 0; i < 81; i++) {
                if (lab.block[i] === blk && (aliveB[i] || aliveW[i])) {
                    isAlive = true;
                    break;
                }
            }
            if (isAlive)
                continue;
            const oc = lab.blockColor[blk];
            const op = oc === BLACK ? WHITE : BLACK;
            if (blockConfinedDead(w, lab, blk, op)) {
                kill[blk] = true;
                nkill++;
            }
        }
        if (nkill === 0)
            break;
        for (let i = 0; i < 81; i++) {
            if (lab.block[i] >= 0 && kill[lab.block[i]]) {
                if (w[i] === BLACK)
                    removed.black++;
                else
                    removed.white++;
                w[i] = EMPTY;
            }
        }
    }
    return removed;
}

function areaScore(b) {
    // Strict Chinese area scoring, mirroring compute_chinese_score() in
    // src/c/logic/board.c: dead stones come OFF first (Benson, above),
    // then stones on board + surrounded territory. Prisoners (captures)
    // are NEVER counted under Chinese rules — the captured tallies in the
    // stats are informational only.
    const w = b.slice();
    const removed = removeDeadStones(w);
    const seen = new Array(81).fill(false);
    let bs = 0, ws = 0, bt = 0, wt = 0;
    for (let i = 0; i < 81; i++) {
        if (w[i] === BLACK) bs++;
        else if (w[i] === WHITE) ws++;
    }
    const dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    for (let s = 0; s < 81; s++) {
        if (w[s] !== EMPTY || seen[s])
            continue;
        const queue = [s];
        seen[s] = true;
        let size = 0, tb = false, tw = false;
        while (queue.length) {
            const cur = queue.pop();
            size++;
            const r = Math.floor(cur / N), c = cur % N;
            for (let d = 0; d < 4; d++) {
                const ni = idx(r + dr[d], c + dc[d]);
                if (ni < 0)
                    continue;
                if (w[ni] === BLACK) tb = true;
                else if (w[ni] === WHITE) tw = true;
                else if (!seen[ni]) {
                    seen[ni] = true;
                    queue.push(ni);
                }
            }
        }
        if (tb && !tw) bt += size;
        else if (tw && !tb) wt += size;
    }
    return { bs, ws, bt, wt, removed, diff: bs + bt - (ws + wt + 7.5) };
}

const COLS = 'ABCDEFGHJ';

function runSelfTest() {
    // Validates the Benson dead-removal port against known shapes.
    let fail = 0;
    const check = (name, cond) => {
        console.log((cond ? 'PASS ' : 'FAIL ') + name);
        if (!cond)
            fail++;
    };
    // Two-eyed black group (+ white wall): nothing removed.
    let b = new Array(81).fill(EMPTY);
    [[1, 1], [1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2], [3, 3]].forEach(([r, c]) => b[r * N + c] = BLACK);
    b[3 * 9 + 5] = BLACK;
    b[5 * 9 + 5] = WHITE;
    b[5 * 9 + 6] = WHITE;
    const w1 = b.slice();
    const rem1 = removeDeadStones(w1);
    check('two-eyed group kept', rem1.black === 0 && rem1.white === 0);
    // White dead invader inside black framework: removed.
    let d = new Array(81).fill(EMPTY);
    [[2, 2], [2, 3], [2, 4], [3, 2], [3, 4], [4, 2], [4, 3], [4, 4]].forEach(([r, c]) => d[r * N + c] = BLACK);
    d[3 * 9 + 3] = WHITE;
    const w2 = d.slice();
    const rem2 = removeDeadStones(w2);
    check('dead invader removed', rem2.white === 1 && w2[3 * 9 + 3] === EMPTY);
    // Captures are not scored: score uses board only.
    const s = areaScore(b);
    check('score ignores prisoners', s.diff === s.bs + s.bt - (s.ws + s.wt + 7.5));
    process.exit(fail ? 1 : 0);
}

if (process.argv.includes('--selftest'))
    runSelfTest();

function boardArt(b) {
    const lines = ['  ' + [...COLS].join(' ')];
    for (let r = 0; r < N; r++) {
        let line = String(N - r) + ' ';
        for (let c = 0; c < N; c++) {
            const v = b[r * N + c];
            line += (v === BLACK ? '⚫' : v === WHITE ? '⚪' : '.') + ' ';
        }
        lines.push(line + (N - r));
    }
    lines.push('  ' + [...COLS].join(' '));
    return lines.join('\n');
}

function coord(r, c) {
    return r === PASS_ROW ? 'pass' : COLS[c] + (N - r);
}

// ---- match driver ----

const pebble = freshPebble();
require(PKJS);
pebble._emit('ready', {});

const board = new Array(81).fill(EMPTY);
const ko = { board: new Array(81).fill(EMPTY), active: false };

let player = BLACK;
let lastR = 4, lastC = 4;
let passes = 0;
let movesMade = 0;
let moveNo = 0;
let retries = 0;
let errorPasses = 0;
let capturedB = 0, capturedW = 0;
let totalMs = 0, maxMs = 0;
const t0 = Date.now();

function aiRequest() {
    pebble.reset();
    const koPayload = ko.board.slice();
    koPayload.push(ko.active ? 1 : 0);
    pebble._emit('appmessage', {
        payload: {
            0: 0, 1: player, 2: lastR, 3: lastC, 4: passes,
            5: board.slice(), 6: koPayload, 7: movesMade,
        },
    });
    if (pebble.sentMessages.length !== 1)
        throw new Error('expected exactly one reply, got ' + pebble.sentMessages.length);
    return pebble.sentMessages[0];
}

let ended = false;
while (!ended && moveNo < MAX_MOVES) {
    moveNo++;
    const q0 = Date.now();
    let reply = aiRequest();
    let ms = Date.now() - q0;
    let row = reply[1], col = reply[2], isPass = reply[3];

    if (isPass === 2) {
        // Companion error (e.g. wanted an illegal early pass): one retry
        // with a fresh RNG seed (mirrors the watch Retry option), then pass.
        console.log(`move ${moveNo}: ${pname(player)} engine-error, retrying (movesMade=${movesMade})`);
        retries++;
        reply = aiRequest();
        ms += Date.now() - q0 - ms;
        row = reply[1];
        col = reply[2];
        isPass = reply[3];
        if (isPass === 2) {
            errorPasses++;
            isPass = 1;
            row = PASS_ROW;
            col = PASS_COL;
        }
    }

    totalMs += ms;
    if (ms > maxMs)
        maxMs = ms;

    if (isPass === 1 || (row === PASS_ROW && col === PASS_COL)) {
        passes++;
        console.log(`move ${moveNo}: ${pname(player)} pass (${ms}ms, passes=${passes})`);
        player = opp(player);
        if (passes >= 2)
            ended = true;
        continue;
    }

    const res = refereePlace(board, ko, player, row, col);
    if (!res.ok) {
        // Illegal reply from the engine: count it and pass (never crash).
        console.log(`move ${moveNo}: ${pname(player)} ILLEGAL ${coord(row, col)} -> pass (${ms}ms)`);
        errorPasses++;
        passes++;
        player = opp(player);
        if (passes >= 2)
            ended = true;
        continue;
    }

    passes = 0;
    movesMade++;
    if (player === BLACK)
        capturedW += res.captured;
    else
        capturedB += res.captured;
    lastR = row;
    lastC = col;
    console.log(`move ${moveNo}: ${pname(player)} ${coord(row, col)} (${ms}ms${res.captured ? `, captures ${res.captured}` : ''})`);
    player = opp(player);
}

const wallMs = Date.now() - t0;
const s = areaScore(board);
const winner = s.diff > 0 ? 'Black' : s.diff < 0 ? 'White' : 'Draw';

console.log('\n=== match over ===');
console.log(`ended by: ${ended ? '2 consecutive passes' : 'MAX_MOVES cap (' + MAX_MOVES + ')'}`);
console.log(`moves played: ${movesMade} stones (+${moveNo - movesMade} passes), retries: ${retries}, error-passes: ${errorPasses}, illegal: included above`);
console.log(`captured (info only, not scored under Chinese rules): black lost ${capturedB}, white lost ${capturedW}`);
console.log(`dead removed before scoring (Benson): black ${s.removed.black}, white ${s.removed.white}`);
console.log(`score (Chinese area: stones + territory + 7.5 komi): B ${s.bs}+${s.bt} vs W ${s.ws}+${s.wt} => ${s.diff > 0 ? 'B+' : s.diff < 0 ? 'W+' : ''}${Math.abs(s.diff)} — ${winner} wins`);
console.log(`time: ${(wallMs / 1000).toFixed(1)}s total, ${(totalMs / Math.max(1, moveNo)).toFixed(0)}ms avg/move, ${maxMs}ms max`);
console.log('\n' + boardArt(board));

process.exit(ended ? 0 : 1);
