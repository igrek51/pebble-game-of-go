/*
 * Calibrate stratScore weights against KataGo top moves (Bradley-Terry
 * spirit: fit static knowledge to predict strong moves).
 *
 * Usage: node tools/eval/strat_fit.js <train.json> [--hill]
 * Without --hill: reports baseline (current engine weights) top-1/top-3
 * hit rate. With --hill: coordinate ascent on weights, prints best.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const child = require('child_process');

const SGF_DIRS = [path.join(__dirname, 'sgf')];
function findSgf(base) {
    for (const d of SGF_DIRS) {
        const out = child.execSync(`find "${d}" -name "${base}"`, { encoding: 'utf8' }).trim();
        if (out) return out.split('\n')[0];
    }
    return null;
}

const COLS = 'ABCDEFGHJ';
function parseGtpVertex(v) {
    const c = COLS.indexOf(v[0].toUpperCase());
    const row = parseInt(v.slice(1), 10);
    return { r: 9 - row, c };
}

// Minimal rules for feature extraction (legal-place check only).
function libCount(b, sr, sc) {
    const color = b[sr * 9 + sc];
    const seen = new Set([sr * 9 + sc]);
    const stack = [[sr, sc]];
    const libs = new Set();
    while (stack.length) {
        const [r, c] = stack.pop();
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr > 8 || nc < 0 || nc > 8 || seen.has(nr * 9 + nc)) continue;
            if (b[nr * 9 + nc] === 0) { seen.add(nr * 9 + nc); libs.add(nr * 9 + nc); }
            else if (b[nr * 9 + nc] === color) { seen.add(nr * 9 + nc); stack.push([nr, nc]); }
        }
    }
    return libs.size;
}
function placeOk(b, ko, player, r, c) {
    // Cheap legality: empty, non-suicide (ko ignored — early game anyway).
    if (b[r * 9 + c] !== 0) return false;
    const t = b.slice();
    t[r * 9 + c] = player;
    // capture check omitted for speed; suicide check via liberties of new stone approx:
    return libCount(t, r, c) > 0;
}
function connectN(b, player, r, c) {
    const seen = new Set();
    let n = 0;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr > 8 || nc < 0 || nc > 8 || b[nr * 9 + nc] !== player) continue;
        // flood group id
        const stack = [[nr, nc]];
        const cells = [];
        let known = false;
        while (stack.length) {
            const [gr, gc] = stack.pop();
            const k = gr * 9 + gc;
            if (seen.has(k)) { known = true; break; }
            seen.add(k); cells.push(k);
            for (const [er, ec] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                const jr = gr + er, jc = gc + ec;
                if (jr >= 0 && jr <= 8 && jc >= 0 && jc <= 8 && b[jr * 9 + jc] === player && !seen.has(jr * 9 + jc))
                    stack.push([jr, jc]);
            }
        }
        if (!known) n++;
    }
    return n;
}

function features(b, turn, r, c, lastR, lastC) {
    const opp = turn === 1 ? 2 : 1;
    const f = {
        center: 8 - (Math.abs(r - 4) + Math.abs(c - 4)),
        prox: 0, proxUns: 0, adj: 0, adjWeak: 0, conn: 0,
        connCut: 0, connQuiet: 0,
        line1: (r === 0 || r === 8 || c === 0 || c === 8) ? 1 : 0,
        line2: (r === 1 || r === 7 || c === 1 || c === 7) ? 1 : 0,
        ring: Math.max(Math.abs(r - 4), Math.abs(c - 4)),
        nearLast: Math.abs(r - lastR) + Math.abs(c - lastC) <= 2 ? 1 : 0,
        cutSize: 0, pat: 0,
    };
    for (let i = 0; i < 81; i++) {
        if (b[i] === 0) continue;
        const ir = Math.floor(i / 9), ic = i % 9;
        const cheb = Math.max(Math.abs(ir - r), Math.abs(ic - c));
        if (cheb >= 2 && cheb <= 3) {
            f.prox++;
            if (groupLibs(b, ir, ic) <= 4) f.proxUns++;
        } else if (cheb <= 1) {
            f.adj++;
            if (b[i] === opp && groupLibs(b, ir, ic) <= 3) f.adjWeak++;
        }
    }
    f.conn = connectN(b, turn, r, c) >= 2 ? 1 : 0;
    // Enemy-cut size: sum of adjacent distinct enemy group sizes (>=2 groups).
    {
        const seen = new Set();
        const groups = [];
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr > 8 || nc < 0 || nc > 8 || b[nr * 9 + nc] !== opp) continue;
            // flood group id
            const stack = [[nr, nc]];
            const cells = [];
            let known = false;
            while (stack.length) {
                const [gr, gc] = stack.pop();
                const k = gr * 9 + gc;
                if (seen.has(k)) { known = true; break; }
                seen.add(k); cells.push(k);
                for (const [er, ec] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                    const jr = gr + er, jc = gc + ec;
                    if (jr >= 0 && jr <= 8 && jc >= 0 && jc <= 8 && b[jr * 9 + jc] === opp && !seen.has(jr * 9 + jc))
                        stack.push([jr, jc]);
                }
            }
            if (!known) groups.push(cells.length);
        }
        if (groups.length >= 2) f.cutSize = groups.reduce((a, x) => a + x, 0);
    }
    if (typeof globalThis.__patBonus === 'function') {
        // patBonus expects plain-array board with 0/1/2 (matches go_rules).
        try { f.pat = globalThis.__patBonus(b, r, c, turn); } catch (e) { f.pat = 0; }
    }
    return f;
}

function groupLibs(b, sr, sc) {
    const color = b[sr * 9 + sc];
    const seen = new Set([sr * 9 + sc]);
    const stack = [[sr, sc]];
    const libs = new Set();
    while (stack.length) {
        const [r, c] = stack.pop();
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr > 8 || nc < 0 || nc > 8 || seen.has(nr * 9 + nc)) continue;
            if (b[nr * 9 + nc] === 0) { seen.add(nr * 9 + nc); libs.add(nr * 9 + nc); }
            else if (b[nr * 9 + nc] === color) { seen.add(nr * 9 + nc); stack.push([nr, nc]); }
        }
    }
    return libs.size;
}

// Engine's strategy, parameterized (v2 features).
function scorePoint(W, b, turn, r, c, lastR, lastC) {
    const f = features(b, turn, r, c, lastR, lastC);
    let s = (f.ring === 0 ? W.ring0 : f.ring === 1 ? W.ring1 : f.ring === 2 ? W.ring2 : f.ring === 3 ? W.ring3 : W.ring4)
        + f.proxUns * W.proxUns + (f.prox - f.proxUns) * W.proxSet
        + f.adjWeak * W.adjWeak + (f.adj - f.adjWeak) * W.adj
        + f.connCut * W.connCut + f.connQuiet * W.connQuiet
        + f.cutSize * W.cutSize + f.pat * W.pat + f.nearLast * W.nearLast;
    if (!f.conn) s += 0; // (adj split above already)
    s += f.line1 * W.line1 + f.line2 * W.line2;
    return s;
}

function loadPositions(trainPath) {
    const data = JSON.parse(fs.readFileSync(trainPath, 'utf8'));
    const positions = [];
    const sgfCache = {};
    for (const rec of data) {
        const [base, plyStr] = rec.id.split(':');
        const ply = +plyStr;
        if (!sgfCache[base]) {
            const f = findSgf(base);
            if (!f) continue;
            const s = fs.readFileSync(f, 'utf8');
            sgfCache[base] = [...s.matchAll(/;([BW])\[([a-z]{2}|tt)\]/g)].map((m) => ({
                color: m[1] === 'B' ? 1 : 2, pass: m[2] === 'tt',
                r: m[2] === 'tt' ? -1 : 'abcdefghj'.indexOf(m[2][1]),
                c: m[2] === 'tt' ? -1 : 'abcdefghj'.indexOf(m[2][0]),
            }));
        }
        const seq = sgfCache[base].slice(0, ply);
        const b = new Array(81).fill(0);
        for (const m of seq) {
            if (!m.pass) b[m.r * 9 + m.c] = m.color;
        }
        const turn = rec.turn === 'B' ? 1 : 2;
        // KataGo top moves as GTP-parsed (pass excluded).
        const kataTop = rec.top.filter((t) => t.move !== 'pass').map((t) => ({ ...t, ...parseGtpVertex(t.move) }));
        const last = seq.length ? seq[seq.length - 1] : { r: -99, c: -99 };
        positions.push({ b, turn, kataTop, id: rec.id, lastR: last.r, lastC: last.c });
    }
    return positions;
}

// Load the engine's real patBonus (patterns included) via source eval.
function loadPatBonus() {
    try {
        const fs2 = require('fs');
        const src = fs2.readFileSync(path.join(__dirname, '..', '..', 'src', 'pkjs', 'pebble-js-app.js'), 'utf8');
        const grab = (name) => {
            const i = src.indexOf(name);
            let j = src.indexOf('{', i), depth = 0, k = j;
            while (true) {
                if (src[k] === '{') depth++;
                if (src[k] === '}') { depth--; if (!depth) break; }
                k++;
            }
            return src.slice(i, k + 1);
        };
        let code = 'var BLACK=1,WHITE=2,EMPTY=0,BOARD_SIZE=9;';
        code += 'var boardIndex=function(r,c){return (r>=0&&r<9&&c>=0&&c<9)?r*9+c:-1;};';
        code += src.slice(src.indexOf('var PATTERNS_BASE'), src.indexOf('// Net pattern weight'));
        code += grab('function patBonus');
        code += ';globalThis.__patBonus=patBonus;';
        (0, eval)(code);
        // count patterns
        const n = (code.match(/w: -?1/g) || []).length;
        console.log(`patBonus loaded (${n} base patterns)`);
    } catch (e) {
        console.log('patBonus load failed: ' + e.message);
    }
}

function hitRate(W, positions, topK) {
    let hits = 0, total = 0;
    for (const p of positions) {
        let bi = -1, bs = -1e9;
        for (let i = 0; i < 81; i++) {
            if (p.b[i] !== 0) continue;
            const r = Math.floor(i / 9), c = i % 9;
            if (!placeOk(p.b, null, p.turn, r, c)) continue;
            const s = scorePoint(W, p.b, p.turn, r, c, p.lastR, p.lastC);
            if (s > bs) { bs = s; bi = i; }
        }
        if (bi < 0) continue;
        total++;
        const br = Math.floor(bi / 9), bc = bi % 9;
        const kt = p.kataTop.slice(0, topK);
        if (kt.some((k) => k.r === br && k.c === bc)) hits++;
    }
    return { hits, total, rate: total ? hits / total : 0 };
}

function main() {
    const trainPath = process.argv[2];
    const hill = process.argv.includes('--hill');
    const dump = process.argv.includes('--dump');
    const train2 = process.argv.includes('--train2');
    loadPatBonus();
    const positions = loadPositions(trainPath);
    if (train2) {
        const fs3 = require('fs');
        const extra = process.argv[process.argv.indexOf('--train2') + 1];
        if (extra && !extra.startsWith('--')) {
            // merge second dataset (positions concatenated)
            const saved = positions.length;
            const more = loadPositions(extra);
            for (const m of more) positions.push(m);
            console.log(`merged +${more.length} (total ${positions.length})`);
        }
    }
    console.log(`${positions.length} positions loaded`);

    // Baseline: current engine grid mapped onto v2 features.
    const base = {
        ring0: 2, ring1: 16, ring2: 20, ring3: 8, ring4: -20,
        proxUns: 3.5, proxSet: 3.5, adjWeak: -2, adj: -2,
        connCut: 24, connQuiet: 2, cutSize: 0, pat: 0, nearLast: 0,
        line1: -10, line2: -4,
    };
    const h1 = hitRate(base, positions, 1);
    const h3 = hitRate(base, positions, 3);
    console.log(`baseline: top1 ${h1.hits}/${h1.total} (${(h1.rate * 100).toFixed(1)}%), ` +
        `top3 ${h3.hits}/${h3.total} (${(h3.rate * 100).toFixed(1)}%)`);
    if (dump) {
        // Show misses: our argmax vs KataGo top-3, with feature deltas.
        let shown = 0;
        for (const p of positions) {
            if (shown >= 12) break;
            let bi = -1, bs = -1e9;
            const scored = [];
            for (let i = 0; i < 81; i++) {
                if (p.b[i] !== 0) continue;
                const r = Math.floor(i / 9), c = i % 9;
                if (!placeOk(p.b, null, p.turn, r, c)) continue;
                const s = scorePoint(base, p.b, p.turn, r, c);
                scored.push({ r, c, s });
                if (s > bs) { bs = s; bi = i; }
            }
            const br = Math.floor(bi / 9), bc = bi % 9;
            const kt = p.kataTop.slice(0, 3);
            if (kt.some((k) => k.r === br && k.c === bc)) continue;
            shown++;
            const C = 'ABCDEFGHJ';
            const vn = (r, c) => C[c] + (9 - r);
            console.log(`${p.id} turn=${p.turn === 1 ? 'B' : 'W'} ours=${vn(br, bc)} kata=${kt.map((k) => vn(k.r, k.c)).join(',')}`);
            const show = (r, c) => {
                const f = features(p.b, p.turn, r, c, -99, -99);
                return `${vn(r, c)} ring=${f.ring} prox=${f.prox} adj=${f.adj} conn=${f.conn} l1=${f.line1} l2=${f.line2}`;
            };
            console.log('  ours: ' + show(br, bc));
            for (const k of kt) console.log('  kata: ' + show(k.r, k.c));
        }
        return;
    }
    if (!hill) return;

    let W = { ...base };
    let best = hitRate(W, positions, 3).rate;
    const keys = ['ring0', 'ring1', 'ring2', 'ring3', 'ring4', 'proxUns', 'proxSet', 'adjWeak', 'adj', 'connCut', 'connQuiet', 'cutSize', 'pat', 'nearLast', 'line1', 'line2'];
    const steps = { ring0: 2, ring1: 2, ring2: 2, ring3: 2, ring4: 4, proxUns: 0.5, proxSet: 0.5, adjWeak: 0.5, adj: 0.5, connCut: 4, connQuiet: 2, cutSize: 1, pat: 5, nearLast: 20, line1: 3, line2: 2 };
    for (let round = 0; round < 6; round++) {
        let improved = false;
        for (const k of keys) {
            for (const dir of [1, -1]) {
                const W2 = { ...W };
                W2[k] += dir * steps[k];
                const r = hitRate(W2, positions, 3).rate;
                if (r > best + 1e-9) {
                    best = r; W = W2; improved = true;
                }
            }
        }
        console.log(`round ${round}: ${(best * 100).toFixed(1)}% ${JSON.stringify(W)}`);
        if (!improved) break;
    }
    const f1 = hitRate(W, positions, 1);
    console.log(`final: top1 ${(f1.rate * 100).toFixed(1)}%, top3 ${(best * 100).toFixed(1)}% weights=${JSON.stringify(W)}`);
}

if (require.main === module) main();
