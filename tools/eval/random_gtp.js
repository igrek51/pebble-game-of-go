/*
 * Dumbest possible GTP opponent: uniform-random legal moves.
 *
 * Absolute floor rung for the ladder ("can we beat random?").
 * Tracks its own board + ko via tools/eval/go_rules.js. Passes when there
 * is nothing legal left, or probabilistically late in the game so games
 * terminate (also hard-passes past a plie cap).
 *
 * Usage: node tools/eval/random_gtp.js [--seed N]
 */
'use strict';

const R = require('./go_rules');

let seed = parseInt((process.argv.find((a) => a.startsWith('--seed=')) || '').split('=')[1], 10) || 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

let board, ko, toMove, plies, komi;

function reset() {
    board = new Array(81).fill(R.EMPTY);
    ko = { board: new Array(81).fill(R.EMPTY), active: false };
    toMove = R.BLACK;
    plies = 0;
    komi = 7.5;
}
reset();

function legalMoves(player) {
    const out = [];
    for (let r = 0; r < 9; r++)
        for (let c = 0; c < 9; c++) {
            if (board[r * 9 + c] !== R.EMPTY) continue;
            const trial = board.slice();
            const tko = { board: ko.board.slice(), active: ko.active };
            if (R.refereePlace(trial, tko, player, r, c).ok) out.push([r, c]);
        }
    return out;
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
    }
});

function respond(id, ok, text) {
    process.stdout.write((ok ? '=' : '?') + (id ? id : '') + (text ? ' ' + text : '') + '\n\n');
}

function handleLine(raw) {
    const hash = raw.indexOf('#');
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).replace(/[\t\r]+/g, ' ').trim();
    if (!line) return;
    const parts = line.split(/ +/);
    let id = '';
    if (/^[0-9]+$/.test(parts[0])) id = parts.shift();
    const cmd = (parts.shift() || '').toLowerCase();
    const args = parts;
    const err = (m) => respond(id, false, m);
    const ok = (t) => respond(id, true, t || '');

    switch (cmd) {
        case 'protocol_version': return ok('2');
        case 'name': return ok('Random9x9');
        case 'version': return ok('1.0');
        case 'known_command': return ok('true');
        case 'list_commands': return ok('protocol_version\nname\nversion\nknown_command\nlist_commands\nquit\nboardsize\nclear_board\nkomi\nplay\ngenmove\nfinal_score');
        case 'quit': respond(id, true, ''); process.exit(0); return;
        case 'boardsize':
            if (parseInt(args[0], 10) !== 9) return err('unacceptable size');
            reset();
            return ok('');
        case 'clear_board': reset(); return ok('');
        case 'komi': komi = parseFloat(args[0]); return ok('');
        case 'play': {
            const color = (args[0] || '').toLowerCase();
            const player = color.startsWith('b') ? R.BLACK : color.startsWith('w') ? R.WHITE : 0;
            if (!player) return err('invalid color');
            const v = R.parseVertex(args[1] || '');
            if (!v) return err('invalid vertex');
            if (!v.pass) {
                if (!R.refereePlace(board, ko, player, v.r, v.c).ok) return err('illegal move');
                plies++;
            }
            toMove = R.opp(player);
            return ok('');
        }
        case 'genmove': {
            const color = (args[0] || '').toLowerCase();
            const player = color.startsWith('b') ? R.BLACK : color.startsWith('w') ? R.WHITE : 0;
            if (!player) return err('invalid color');
            const moves = legalMoves(player);
            if (moves.length === 0 || plies > 250 || (plies > 100 && rnd() < 0.1)) {
                toMove = R.opp(player);
                return ok('pass');
            }
            const [r, c] = moves[Math.floor(rnd() * moves.length)];
            R.refereePlace(board, ko, player, r, c);
            plies++;
            toMove = R.opp(player);
            return ok(R.formatVertex(r, c));
        }
        case 'final_score': {
            const s = R.areaScore(board, komi);
            if (s.diff > 0) return ok('B+' + s.diff);
            if (s.diff < 0) return ok('W+' + (-s.diff));
            return ok('0');
        }
        default: return err('unknown command');
    }
}
