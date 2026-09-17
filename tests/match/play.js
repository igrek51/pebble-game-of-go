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

function areaScore(b) {
    const seen = new Array(81).fill(false);
    let bs = 0, ws = 0, bt = 0, wt = 0;
    for (let i = 0; i < 81; i++) {
        if (b[i] === BLACK) bs++;
        else if (b[i] === WHITE) ws++;
    }
    const dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    for (let s = 0; s < 81; s++) {
        if (b[s] !== EMPTY || seen[s])
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
                if (b[ni] === BLACK) tb = true;
                else if (b[ni] === WHITE) tw = true;
                else if (!seen[ni]) {
                    seen[ni] = true;
                    queue.push(ni);
                }
            }
        }
        if (tb && !tw) bt += size;
        else if (tw && !tb) wt += size;
    }
    return { bs, ws, bt, wt, diff: bs + bt - (ws + wt + 7.5) };
}

const COLS = 'ABCDEFGHJ';

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
console.log(`captured: black lost ${capturedB}, white lost ${capturedW}`);
console.log(`score: B ${s.bs}+${s.bt} vs W ${s.ws}+${s.wt} (+7.5 komi) => ${s.diff > 0 ? 'B+' : s.diff < 0 ? 'W+' : ''}${Math.abs(s.diff)} — ${winner} wins`);
console.log(`time: ${(wallMs / 1000).toFixed(1)}s total, ${(totalMs / Math.max(1, moveNo)).toFixed(0)}ms avg/move, ${maxMs}ms max`);
console.log('\n' + boardArt(board));

process.exit(ended ? 0 : 1);
