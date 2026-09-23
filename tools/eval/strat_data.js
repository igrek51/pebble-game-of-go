/*
 * Strategy training data: for positions across our SGFs, ask KataGo for
 * its top moves. Used to calibrate stratScore weights (see strat_fit.js).
 *
 * Usage: node tools/eval/strat_data.js <out.json> <sgf...> [--plies 2-20] [--visits 200]
 * Saves [{ sgf, ply, turn, top: [{move, winrate, score}] }].
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

function main() {
    const args = process.argv.slice(2);
    const out = args.shift();
    let plo = 2, phi = 20, visits = 200;
    const sgfs = [];
    for (let ai = 0; ai < args.length; ai++) {
        const a = args[ai];
        let m;
        if (a === '--plies' && ai + 1 < args.length && (m = args[++ai].match(/^(\d+)-(\d+)$/))) {
            plo = +m[1]; phi = +m[2];
        } else if ((m = a.match(/^--plies=(\d+)-(\d+)$/))) { plo = +m[1]; phi = +m[2]; }
        else if (a === '--visits' && ai + 1 < args.length) visits = +args[++ai];
        else if ((m = a.match(/^--visits=(\d+)$/))) visits = +m[1];
        else sgfs.push(a);
    }

    const queries = [];
    const meta = [];
    for (const f of sgfs) {
        const s = fs.readFileSync(f, 'utf8');
        const moves = [...s.matchAll(/;([BW])\[([a-z]{2}|tt)\]/g)].map((m) => ({
            color: m[1], pass: m[2] === 'tt',
            r: m[2] === 'tt' ? -1 : 'abcdefghj'.indexOf(m[2][1]),
            c: m[2] === 'tt' ? -1 : 'abcdefghj'.indexOf(m[2][0]),
        }));
        for (let ply = plo; ply <= Math.min(phi, moves.length - 1); ply += 2) {
            const seq = moves.slice(0, ply);
            if (seq.some((m) => m.pass)) continue;
            queries.push({
                id: `${path.basename(f)}:${ply}`,
                rules: 'chinese', komi: 7.5, boardXSize: 9, boardYSize: 9,
                moves: seq.map((q) => [q.color, toGtp(q.r, q.c)]),
                analyzeTurns: [seq.length], maxVisits: visits,
            });
            meta.push({ sgf: f, ply, turn: moves[ply].color });
        }
    }
    console.log(`${queries.length} positions queued`);

    const input = queries.map((q) => JSON.stringify(q)).join('\n');
    const r = spawnSync(KATAGO, ['analysis', '-model', NET, '-config', CFG],
        { input, encoding: 'utf8', timeout: 3600000, maxBuffer: 256 * 1024 * 1024 });
    const data = [];
    for (const line of (r.stdout || '').split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
            const d = JSON.parse(t);
            if (!d.id || !d.moveInfos) continue;
            // moveInfos winrates are Black-perspective; store side-to-move
            // perspective using turn from meta.
            const m = meta.find((x) => `${path.basename(x.sgf)}:${x.ply}` === d.id);
            const flip = m && m.turn === 'W';
            data.push({
                id: d.id, turn: m ? m.turn : '?',
                top: d.moveInfos.slice(0, 5).map((x) => ({
                    move: x.move,
                    winrate: flip ? 1 - x.winrate : x.winrate,
                    score: flip ? -x.scoreLead : x.scoreLead,
                })),
            });
        } catch (e) { /* partial line */ }
    }
    fs.writeFileSync(out, JSON.stringify(data, null, 1));
    console.log(`saved ${data.length} analyzed positions to ${out}`);
}

if (require.main === module) main();
