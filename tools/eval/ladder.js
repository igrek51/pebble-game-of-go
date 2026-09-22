/*
 * KataGo ladder driver: plays our engine (via tools/eval/gtp.js) against
 * KataGo at increasing strength rungs (net + maxVisits).
 *
 * Usage:
 *   node tools/eval/ladder.js [--games 4] [--rungs 0,1,2] [--sgf 1]
 *
 * Rungs are defined below, weakest first. Results append to
 * tools/eval/results.jsonl and print as a markdown table row block.
 */
'use strict';

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const VENDOR = path.join(HERE, 'vendor');
const KATAGO = path.join(VENDOR, 'katago171', 'katago');
const BASE_CFG = path.join(VENDOR, 'katago171', 'default_gtp.cfg');

const NETS = {
    b6: path.join(VENDOR, 'kata1-b6c96-s175395328-d26788732.txt.gz'),
    b10: path.join(VENDOR, 'kata1-b10c128-s41138688-d27396855.txt.gz'),
};

// Weakest first. (kata9x9 specialist + higher visits added once we clear these.)
const RUNGS = [
    { net: 'b6', visits: 2 },
    { net: 'b6', visits: 10 },
    { net: 'b6', visits: 50 },
    { net: 'b6', visits: 200 },
    { net: 'b10', visits: 50 },
    { net: 'b10', visits: 200 },
    { net: 'b10', visits: 500 },
];

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const GAMES = parseInt(arg('games', '4'), 10);
const RUNG_SEL = arg('rungs', RUNGS.map((_, i) => i).join(',')).split(',').map((s) => parseInt(s, 10));
const SAVE_SGF = arg('sgf', '1') !== '0';

function rungCfg(net, visits) {
    const base = fs.readFileSync(BASE_CFG, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(maxVisits|numSearchThreads|ponderingEnabled)\b/.test(l))
        .join('\n');
    const cfgPath = path.join(VENDOR, `rung_${net}_${visits}.cfg`);
    fs.writeFileSync(cfgPath, base +
        `\n# ladder override\nmaxVisits = ${visits}\nnumSearchThreads = 4\nponderingEnabled = false\n`);
    return cfgPath;
}

function main() {
    for (const ri of RUNG_SEL) {
        const rung = RUNGS[ri];
        const label = `${rung.net}_v${rung.visits}`;
        const cfg = rungCfg(rung.net, rung.visits);
        const katagoCmd = `${KATAGO} gtp -model ${NETS[rung.net]} -config ${cfg}`;
        console.log(`\n=== rung ${ri}: KataGo ${rung.net} maxVisits=${rung.visits} ===`);
        const args = [
            path.join(HERE, 'gtp_match.js'),
            '--black', `node ${path.join(HERE, 'gtp.js')}`,
            '--white', katagoCmd,
            '--games', String(GAMES),
            '--komi', '7.5',
            '--label', label,
        ];
        if (SAVE_SGF) args.push('--sgf-dir', path.join(HERE, 'sgf', label));
        const out = execSync(`node ${args.map((a) => `'${a}'`).join(' ')}`, {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            timeout: 3600 * 1000,
        });
        process.stdout.write(out);
        const m = out.match(/summary: A=(\S+) (\d+) - (\d+) (\S+)=B, voided=(\d+)/);
        const rec = {
            date: new Date().toISOString().slice(0, 10),
            engine: 'PebbleGo ' + JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8')).version,
            rung: label, visits: rung.visits, net: rung.net,
            wins: m ? parseInt(m[2], 10) : -1, losses: m ? parseInt(m[3], 10) : -1,
            voided: m ? parseInt(m[5], 10) : -1, games: GAMES,
        };
        fs.appendFileSync(path.join(HERE, 'results.jsonl'), JSON.stringify(rec) + '\n');
        console.log(`recorded: ${JSON.stringify(rec)}`);
    }
}

if (require.main === module) {
    try {
        main();
    } catch (e) {
        console.error('ladder failed: ' + (e.stdout || e.message));
        process.exit(1);
    }
}

module.exports = { RUNGS };
