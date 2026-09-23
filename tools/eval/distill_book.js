/*
 * Distill a compact opening book from KataGo analysis.
 *
 * Explores opening positions (transposition-deduped by canonical hash),
 * queries KataGo for top moves, and saves book.json: {hash: {turn, top}}.
 * Runtime lookup planned in src/pkjs (canonicalize + inverse transform).
 *
 * Usage: node tools/eval/distill_book.js <out.json> [--max-nodes 60] [--depth 8] [--visits 400]
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VENDOR = path.join(__dirname, 'vendor');
const KATAGO = path.join(VENDOR, 'katago171', 'katago');
const NET = path.join(VENDOR, 'kata1-b10c128-s41138688-d27396855.txt.gz');
const CFG = path.join(VENDOR, 'katago171', 'analysis_example.cfg');

const COLS = 'ABCDEFGHJ';
function toGtp(r, c) { return COLS[c] + (9 - r); }
function fromGtp(v) {
    if (v.toLowerCase() === 'pass') return null;
    return { r: 9 - parseInt(v.slice(1), 10), c: COLS.indexOf(v[0].toUpperCase()) };
}

// 8 dihedral transforms on (r,c); canonical key = min over transforms of
// black-map + '|' + white-map (both transformed jointly).
function xf(t, r, c) {
    if (t === 0) return [r, c];
    if (t === 1) return [c, 8 - r];
    if (t === 2) return [8 - r, 8 - c];
    if (t === 3) return [8 - c, r];
    if (t === 4) return [8 - r, c];
    if (t === 5) return [r, 8 - c];
    if (t === 6) return [c, r];
    return [8 - c, 8 - r];
}
function canonKey(black, white) {
    // black/white: Set of r*9+c.
    let best = null;
    for (let t = 0; t < 8; t++) {
        const tb = [], tw = [];
        for (const i of black) {
            const [r, c] = xf(t, Math.floor(i / 9), i % 9);
            tb.push(r * 9 + c);
        }
        for (const i of white) {
            const [r, c] = xf(t, Math.floor(i / 9), i % 9);
            tw.push(r * 9 + c);
        }
        tb.sort((a, b) => a - b);
        tw.sort((a, b) => a - b);
        const k = tb.join(',') + '|' + tw.join(',');
        if (best === null || k < best) best = k;
    }
    return best;
}

function main() {
    const args = process.argv.slice(2);
    const out = args.shift();
    const opt = (n, d) => {
        const i = args.indexOf('--' + n);
        return i >= 0 ? +args[i + 1] : d;
    };
    const MAX_NODES = opt('max-nodes', 60);
    const MAX_DEPTH = opt('depth', 8);
    const VISITS = opt('visits', 400);

    // BFS rounds over positions: {black:Set, white:Set, turn, seq}.
    // Transposition-deduped by canonical hash; top-2 replies expand.
    const bookOut = {};
    let current = [{ black: new Set(), white: new Set(), turn: 'B', seq: [] }];
    const seenAll = new Set();
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
        const batch = [];
        const batchNodes = [];
        for (const node of current) {
            const key = canonKey(node.black, node.white);
            if (seenAll.has(key)) continue;
            seenAll.add(key);
            if (Object.keys(bookOut).length + batch.length >= MAX_NODES) break;
            const gtpMoves = node.seq.map((m) => [m.color, toGtp(m.r, m.c)]);
            batch.push({
                id: `d${depth}n${batch.length}`, rules: 'chinese', komi: 7.5,
                boardXSize: 9, boardYSize: 9, moves: gtpMoves,
                analyzeTurns: [gtpMoves.length], maxVisits: VISITS,
            });
            batchNodes.push({ node, key });
        }
        if (!batch.length) break;
        console.log(`depth ${depth}: querying ${batch.length} positions...`);
        const input = batch.map((q) => JSON.stringify(q)).join('\n');
        const r = spawnSync(KATAGO, ['analysis', '-model', NET, '-config', CFG],
            { input, encoding: 'utf8', timeout: 3600000, maxBuffer: 256 * 1024 * 1024 });
        const next = [];
        for (const line of (r.stdout || '').split('\n')) {
            const t = line.trim();
            if (!t.startsWith('{')) continue;
            try {
                const d = JSON.parse(t);
                if (!d.id || !d.moveInfos) continue;
                const bi = batch.findIndex((q) => q.id === d.id);
                const { node, key } = batchNodes[bi];
                const flip = node.turn === 'W';
                const top = d.moveInfos.slice(0, 3)
                    .filter((m) => m.move !== 'pass')
                    .map((m) => {
                        const v = fromGtp(m.move);
                        return {
                            r: v.r, c: v.c,
                            winrate: flip ? 1 - m.winrate : m.winrate,
                        };
                    });
                bookOut[key] = { turn: node.turn, top };
                // Expand top-2 replies as children.
                for (const t2 of top.slice(0, 2)) {
                    const nb = new Set(node.black), nw = new Set(node.white);
                    if (node.turn === 'B') nb.add(t2.r * 9 + t2.c);
                    else nw.add(t2.r * 9 + t2.c);
                    // Legality: KataGo replies are legal by construction.
                    next.push({
                        black: nb, white: nw,
                        turn: node.turn === 'B' ? 'W' : 'B',
                        seq: [...node.seq, { color: node.turn, r: t2.r, c: t2.c }],
                    });
                }
            } catch (e) { /* partial line */ }
        }
        current = next;
    }
    fs.writeFileSync(out, JSON.stringify(bookOut));
    console.log(`saved ${Object.keys(bookOut).length} book positions to ${out}`);
}

if (require.main === module) main();
