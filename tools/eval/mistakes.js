/*
 * Per-move mistake attribution: for every move by SIDE in an SGF, ask
 * KataGo's analysis engine for the position winrate before and after the
 * move. Rank moves by winrate drop (our perspective).
 *
 * Usage: node tools/eval/mistakes.js <sgf> <B|W> [--visits 150]
 *
 * Requires tools/eval/vendor KataGo (see docs/eval.md). Prints a table of
 * the worst moves + KataGo's preferred reply at each.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SGF = process.argv[2];
const SIDE = (process.argv[3] || 'B').toUpperCase();
const VISITS = parseInt((process.argv.find((a) => a.startsWith('--visits=')) || '').split('=')[1], 10) || 150;

const VENDOR = path.join(__dirname, 'vendor');
const KATAGO = path.join(VENDOR, 'katago171', 'katago');
const NET = path.join(VENDOR, 'kata1-b10c128-s41138688-d27396855.txt.gz');
const CFG = path.join(VENDOR, 'katago171', 'analysis_example.cfg');

const COLS = 'ABCDEFGHJ';
function toGtp(r, c) { return COLS[c] + (9 - r); }

function main() {
    const s = fs.readFileSync(SGF, 'utf8');
    const moves = [...s.matchAll(/;([BW])\[([a-z]{2}|tt)\]/g)].map((m) => ({
        color: m[1], pass: m[2] === 'tt',
        r: m[2] === 'tt' ? -1 : 'abcdefghj'.indexOf(m[2][1]),
        c: m[2] === 'tt' ? -1 : 'abcdefghj'.indexOf(m[2][0]),
    }));

    // Build analysis queries: for each SIDE move i, position before (turn i)
    // and position after (turn i+1). KataGo replays `moves`, so prefixes
    // must be legal — they are (real game record).
    const queries = [];
    const tags = [];
    const seq = [];
    for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        if (m.color === SIDE && !m.pass) {
            queries.push({
                id: `before_${i}`, rules: 'chinese', komi: 7.5,
                boardXSize: 9, boardYSize: 9,
                moves: seq.map((q) => [q.color, q.pass ? 'pass' : toGtp(q.r, q.c)]),
                analyzeTurns: [seq.length], maxVisits: VISITS,
            });
            tags.push({ ply: i, when: 'before', move: m });
        }
        seq.push(m);
        if (m.color === SIDE && !m.pass) {
            queries.push({
                id: `after_${i}`, rules: 'chinese', komi: 7.5,
                boardXSize: 9, boardYSize: 9,
                moves: seq.map((q) => [q.color, q.pass ? 'pass' : toGtp(q.r, q.c)]),
                analyzeTurns: [seq.length], maxVisits: VISITS,
            });
            tags.push({ ply: i, when: 'after', move: m });
        }
    }

    const input = queries.map((q) => JSON.stringify(q)).join('\n');
    const r = spawnSync(KATAGO, ['analysis', '-model', NET, '-config', CFG],
        { input, encoding: 'utf8', timeout: 1800000, maxBuffer: 256 * 1024 * 1024 });
    const byId = {};
    for (const line of (r.stdout || '').split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
            const d = JSON.parse(t);
            if (d.id) byId[d.id] = d;
        } catch (e) { /* partial line */ }
    }

    // Pair before/after. KataGo rootInfo.winrate is ALWAYS Black's
    // perspective (verified: white-to-move after B pass => 0.015).
    const weAreBlack = SIDE === 'B';
    const rows = [];
    for (let i = 0; i < moves.length; i++) {
        const b = byId[`before_${i}`], a = byId[`after_${i}`];
        if (!b || !a || !b.rootInfo || !a.rootInfo) continue;
        const m = moves[i];
        const wBefore = weAreBlack ? b.rootInfo.winrate : 1 - b.rootInfo.winrate;
        const wAfter = weAreBlack ? a.rootInfo.winrate : 1 - a.rootInfo.winrate;
        const best = (b.moveInfos && b.moveInfos[0]) ? b.moveInfos[0] : null;
        const bestWr = best ? (weAreBlack ? best.winrate : 1 - best.winrate) : 0;
        rows.push({
            ply: i,
            ours: toGtp(m.r, m.c),
            kata: best ? `${best.move} (${(bestWr * 100).toFixed(0)}%)` : '?',
            before: wBefore, after: wAfter, drop: wBefore - wAfter,
        });
    }
    rows.sort((x, y) => y.drop - x.drop);
    console.log(`mistakes for ${SIDE} in ${SGF} (katago b10, ${VISITS} visits):`);
    console.log('ply  ours  kata-pref   before  after   drop');
    for (const r2 of rows.slice(0, 15)) {
        console.log(`${String(r2.ply).padStart(3)}  ${r2.ours.padEnd(4)}  ${r2.kata.padEnd(10)}  ` +
            `${(r2.before * 100).toFixed(1)}%  ${(r2.after * 100).toFixed(1)}%  -${(r2.drop * 100).toFixed(1)}pp`);
    }
    const scored = rows.filter((x) => x.drop > 0.03);
    console.log(`\n${scored.length}/${rows.length} our moves lost >3pp; ` +
        `total swing on those: ${(scored.reduce((a, x) => a + x.drop, 0) * 100).toFixed(0)}pp`);
}

if (require.main === module) main();
