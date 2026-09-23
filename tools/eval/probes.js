/*
 * Tactical probe suite: GTP-level gate for the full engine pipeline.
 *
 * Each probe sets up a position via `play`, asks `genmove`, and checks the
 * reply against an expected set. A fresh engine process per probe keeps
 * results reproducible (engine RNG is request-seeded).
 *
 * Usage: node tools/eval/probes.js [--probe N] [--engine "<cmd>"]
 * Exit 0 iff all probes pass. Prints a results table.
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ENGINE = (() => {
    const i = process.argv.indexOf('--engine');
    return i >= 0 ? process.argv[i + 1] : `node ${path.join(__dirname, 'gtp.js')}`;
})();

// setup: [color, vertex] plays. mover: 'black'|'white'.
// expect: array of acceptable vertices, or { not: [...] } (forbidden list).
const PROBES = [
    {
        name: 'escape-b-1lib', desc: 'Black stone in atari must extend',
        setup: [['black', 'C3'], ['white', 'B3'], ['white', 'D3'], ['white', 'C2']],
        mover: 'black', expect: ['C4'],
    },
    {
        name: 'escape-w-1lib', desc: 'White stone in atari must extend (mirror)',
        setup: [['white', 'C3'], ['black', 'B3'], ['black', 'D3'], ['black', 'C2']],
        mover: 'white', expect: ['C4'],
    },
    {
        name: 'capture-b-1lib', desc: 'Black must take hanging white stone',
        setup: [['white', 'C3'], ['black', 'B3'], ['black', 'D3'], ['black', 'C2']],
        mover: 'black', expect: ['C4'],
    },
    {
        name: 'capture-w-1lib', desc: 'White must take hanging black stone (mirror)',
        setup: [['black', 'C3'], ['white', 'B3'], ['white', 'D3'], ['white', 'C2']],
        mover: 'white', expect: ['C4'],
    },
    {
        name: 'extend-b-2lib', desc: 'Black 2-lib group should extend, not tenuki',
        setup: [['black', 'C3'], ['white', 'B3'], ['white', 'D3']],
        mover: 'black', expect: ['C2', 'C4'],
    },
    {
        name: 'extend-w-2lib', desc: 'White 2-lib group should extend (mirror)',
        setup: [['white', 'C3'], ['black', 'B3'], ['black', 'D3']],
        mover: 'white', expect: ['C2', 'C4'],
    },
    {
        name: 'capture-b-2stones', desc: 'Black must capture 2-stone group in atari',
        setup: [['white', 'C3'], ['white', 'D3'], ['black', 'B3'], ['black', 'E3'],
                ['black', 'C2'], ['black', 'D2'], ['black', 'C4']],
        mover: 'black', expect: ['D4'],
    },
    // NOTE: a 2-stone escape probe was removed — the natural construction
    // (B C3/D3 + W B3/E3/C2/D2/C4) is KataGo-verified 0% for every reply,
    // so it gates nothing. Tier-2 escape-to-strength forcing is covered by
    // the 1-lib probes above (C4 escapes to 3 libs).
    {
        name: 'no-eye-fill', desc: 'Must not fill own finished eye',
        setup: [['black', 'C2'], ['black', 'D2'], ['black', 'E2'], ['black', 'C3'],
                ['black', 'E3'], ['black', 'C4'], ['black', 'D4'], ['black', 'E4'],
                ['white', 'A1']],
        mover: 'black', expect: { not: ['D3'] },
    },
    {
        name: 'opening-sane', desc: 'Empty-board reply must not be first line',
        setup: [],
        mover: 'black', expect: { notFirstLine: true },
    },
];

function runProbe(p) {
    const cmds = ['boardsize 9', 'komi 7.5', 'clear_board'];
    for (const [c, v] of p.setup) cmds.push(`play ${c} ${v}`);
    cmds.push(`genmove ${p.mover}`);
    const input = cmds.join('\n') + '\nquit\n';
    const parts = ENGINE.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    const cmd = parts.shift();
    const args = parts.map((s) => s.replace(/^["']|["']$/g, ''));
    const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 120000 });
    const responses = (r.stdout || '').split('\n\n').map((s) => s.trim()).filter(Boolean);
    // Last response is from `quit`; genmove's is second-to-last.
    const genmoveResp = responses.length >= 2 ? responses[responses.length - 2] : (responses[0] || '');
    const m = genmoveResp.match(/^=\s*(\S+)/);
    const reply = m ? m[1].toUpperCase() : 'NONE(' + genmoveResp.slice(0, 40) + ')';

    let pass;
    if (Array.isArray(p.expect)) {
        pass = p.expect.includes(reply);
    } else if (p.expect.not) {
        pass = !p.expect.not.includes(reply);
    } else if (p.expect.notFirstLine) {
        // First line = row 1/9 or col A/J.
        pass = reply !== 'PASS' && !/[AJ]/.test(reply[0]) && !/(1|9)$/.test(reply);
    }
    return { name: p.name, reply, pass: !!pass };
}

function main() {
    const only = (() => {
        const i = process.argv.indexOf('--probe');
        return i >= 0 ? process.argv[i + 1] : null;
    })();
    const list = only ? PROBES.filter((p) => p.name === only) : PROBES;
    let fails = 0;
    for (const p of list) {
        const r = runProbe(p);
        if (!r.pass) fails++;
        console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}: got ${r.reply}` +
            (r.pass ? '' : ` — ${p.desc}; setup ${JSON.stringify(p.setup)} mover=${p.mover}`));
    }
    console.log(`\n${list.length - fails}/${list.length} probes pass`);
    process.exit(fails ? 1 : 0);
}

if (require.main === module) main();
module.exports = { PROBES, runProbe };
