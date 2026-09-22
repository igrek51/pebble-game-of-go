/*
 * Shared Go rules for eval tooling (tools/eval/).
 *
 * Independent referee + Chinese area scoring with Benson dead-removal,
 * mirroring tests/match/play.js. Used by gtp.js (adapter) and gtp_match.js.
 */
'use strict';

const N = 9;
const EMPTY = 0, BLACK = 1, WHITE = 2;

const idx = (r, c) => (r >= 0 && r < N && c >= 0 && c < N ? r * N + c : -1);
const opp = (p) => (p === BLACK ? WHITE : BLACK);

function libertiesOf(b, sr, sc) {
    const color = b[sr * N + sc];
    const seen = new Set([sr * N + sc]);
    const stack = [[sr, sc]];
    const libs = new Set();
    const dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    while (stack.length) {
        const [r, c] = stack.pop();
        for (let d = 0; d < 4; d++) {
            const ni = idx(r + dr[d], c + dc[d]);
            if (ni < 0 || seen.has(ni))
                continue;
            if (b[ni] === EMPTY) {
                seen.add(ni);
                libs.add(ni);
            } else if (b[ni] === color) {
                seen.add(ni);
                stack.push([r + dr[d], c + dc[d]]);
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
    const dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    while (stack.length) {
        const [r, c] = stack.pop();
        b[r * N + c] = EMPTY;
        n++;
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

// Place stone; returns { ok, captured }. Never mutates on illegal moves.
// ko = { board:[81] (position before last capturing move), active:bool }.
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
        return { ok: false, captured: 0 };
    }
    if (ko.active) {
        let equal = true;
        for (let k = 0; k < 81; k++) {
            if (b[k] !== ko.board[k]) { equal = false; break; }
        }
        if (equal) {
            for (let k = 0; k < 81; k++) b[k] = snapshot[k];
            return { ok: false, captured: 0 };
        }
    }
    ko.board = snapshot;
    ko.active = captured > 0;
    return { ok: true, captured };
}

// ---- Benson dead removal (port of src/c/logic/life.c, via play.js) ----
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
                const ni = idx(r + dr[d], c + dc[d]);
                if (ni < 0 || labels[ni] >= 0)
                    continue;
                if ((b[ni] === EMPTY) !== wantEmpty)
                    continue;
                if (!wantEmpty && b[ni] !== color)
                    continue;
                labels[ni] = id;
                stack.push([r + dr[d], c + dc[d]]);
            }
        }
    };
    for (let r = 0; r < N; r++)
        for (let c = 0; c < N; c++) {
            const i = r * N + c;
            if (b[i] !== EMPTY) {
                if (block[i] < 0) { flood(r, c, block, nblocks, false, b[i]); blockColor[nblocks] = b[i]; nblocks++; }
            } else if (region[i] < 0) { flood(r, c, region, nregions, true, 0); nregions++; }
        }
    return { block, region, blockColor, nblocks, nregions };
}

function bensonAlive(b, lab, color) {
    const alive = new Array(81).fill(false);
    const X = [], R = [];
    for (let i = 0; i < lab.nblocks; i++) X[i] = lab.blockColor[i] === color;
    const dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    const enclosedBy = (r, col) => {
        let found = false;
        for (let i = 0; i < 81; i++) {
            if (lab.region[i] !== r) continue;
            const row = Math.floor(i / N), cc = i % N;
            for (let d = 0; d < 4; d++) {
                const ni = idx(row + dr[d], cc + dc[d]);
                if (ni < 0 || b[ni] === EMPTY) continue;
                if (b[ni] !== col) return false;
                found = true;
            }
        }
        return found;
    };
    for (let i = 0; i < lab.nregions; i++) R[i] = enclosedBy(i, color);
    const vitalFor = (r, blk) => {
        for (let i = 0; i < 81; i++) {
            if (lab.region[i] !== r) continue;
            const row = Math.floor(i / N), cc = i % N;
            let touches = false;
            for (let d = 0; d < 4; d++) {
                if (lab.block[idx(row + dr[d], cc + dc[d])] === blk) { touches = true; break; }
            }
            if (!touches) return false;
        }
        return true;
    };
    const supported = (r) => {
        for (let i = 0; i < 81; i++) {
            if (lab.region[i] !== r) continue;
            const row = Math.floor(i / N), cc = i % N;
            for (let d = 0; d < 4; d++) {
                const ni = idx(row + dr[d], cc + dc[d]);
                if (ni < 0 || b[ni] === EMPTY) continue;
                if (!X[lab.block[ni]]) return false;
            }
        }
        return true;
    };
    let changed = true;
    while (changed) {
        changed = false;
        for (let blk = 0; blk < lab.nblocks; blk++) {
            if (!X[blk]) continue;
            let vital = 0;
            for (let r = 0; r < lab.nregions; r++) {
                if (R[r] && vitalFor(r, blk) && ++vital >= 2) break;
            }
            if (vital < 2) { X[blk] = false; changed = true; }
        }
        for (let r = 0; r < lab.nregions; r++) {
            if (R[r] && !supported(r)) { R[r] = false; changed = true; }
        }
    }
    for (let i = 0; i < 81; i++) {
        if (lab.block[i] >= 0 && X[lab.block[i]]) alive[i] = true;
    }
    return alive;
}

function regionSize(lab, r) {
    let n = 0;
    for (let i = 0; i < 81; i++) if (lab.region[i] === r) n++;
    return n;
}

function blockConfinedDead(b, lab, blk, oppc) {
    const seen = {};
    const dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    for (let i = 0; i < 81; i++) {
        if (lab.block[i] !== blk) continue;
        const row = Math.floor(i / N), col = i % N;
        for (let d = 0; d < 4; d++) {
            const ni = idx(row + dr[d], col + dc[d]);
            if (ni < 0 || b[ni] !== EMPTY) continue;
            const r = lab.region[ni];
            if (seen[r]) continue;
            seen[r] = true;
            if (regionSize(lab, r) > DEAD_REGION_MAX) return false;
            let oppFound = false;
            for (let j = 0; j < 81; j++) {
                if (lab.region[j] !== r) continue;
                const jr = Math.floor(j / N), jc = j % N;
                for (let e = 0; e < 4; e++) {
                    const ki = idx(jr + dr[e], jc + dc[e]);
                    if (ki < 0 || b[ki] === EMPTY || lab.block[ki] === blk) continue;
                    if (b[ki] !== oppc) return false;
                    oppFound = true;
                }
            }
            if (!oppFound) return false;
        }
    }
    return true;
}

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
                if (lab.block[i] === blk && (aliveB[i] || aliveW[i])) { isAlive = true; break; }
            }
            if (isAlive) continue;
            const oc = lab.blockColor[blk];
            const op = oc === BLACK ? WHITE : BLACK;
            if (blockConfinedDead(w, lab, blk, op)) { kill[blk] = true; nkill++; }
        }
        if (nkill === 0) break;
        for (let i = 0; i < 81; i++) {
            if (lab.block[i] >= 0 && kill[lab.block[i]]) {
                if (w[i] === BLACK) removed.black++; else removed.white++;
                w[i] = EMPTY;
            }
        }
    }
    return removed;
}

// Chinese area score with komi. Captures never counted.
function areaScore(b, komi) {
    const w = b.slice();
    const removed = removeDeadStones(w);
    let bs = 0, ws = 0, bt = 0, wt = 0;
    for (let i = 0; i < 81; i++) {
        if (w[i] === BLACK) bs++;
        else if (w[i] === WHITE) ws++;
    }
    const seen = new Array(81).fill(false);
    const dr = [-1, 1, 0, 0], dc = [0, 0, -1, 1];
    for (let s = 0; s < 81; s++) {
        if (w[s] !== EMPTY || seen[s]) continue;
        const queue = [s];
        seen[s] = true;
        let size = 0, tb = false, tw = false;
        while (queue.length) {
            const cur = queue.pop();
            size++;
            const r = Math.floor(cur / N), c = cur % N;
            for (let d = 0; d < 4; d++) {
                const ni = idx(r + dr[d], c + dc[d]);
                if (ni < 0) continue;
                if (w[ni] === BLACK) tb = true;
                else if (w[ni] === WHITE) tw = true;
                else if (!seen[ni]) { seen[ni] = true; queue.push(ni); }
            }
        }
        if (tb && !tw) bt += size;
        else if (tw && !tb) wt += size;
    }
    return { bs, ws, bt, wt, removed, diff: bs + bt - (ws + wt + komi) };
}

// ---- GTP coordinates (cols A-H,J; row 1 = bottom = our row 8) ----
const GTP_COLS = 'ABCDEFGHJ';

function parseVertex(v) {
    if (!v || v.toLowerCase() === 'pass') return { pass: true };
    const s = v.toUpperCase();
    const col = GTP_COLS.indexOf(s[0]);
    const row = parseInt(s.slice(1), 10);
    if (col < 0 || !(row >= 1 && row <= 9)) return null;
    return { pass: false, r: N - row, c: col };
}

function formatVertex(r, c) {
    if (r === 9 && c === 9) return 'pass';
    return GTP_COLS[c] + (N - r);
}

module.exports = {
    N, EMPTY, BLACK, WHITE, PASS_R: 9, PASS_C: 9,
    idx, opp, libertiesOf, refereePlace,
    removeDeadStones, areaScore,
    parseVertex, formatVertex,
};
