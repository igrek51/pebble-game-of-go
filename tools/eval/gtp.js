/*
 * GTP adapter for the Pebble Game of Go pkjs engine.
 *
 * Exposes the REAL src/pkjs/pebble-js-app.js as a Go Text Protocol engine
 * on stdin/stdout, so it can play matches vs GNU Go / KataGo (local ladder),
 * CGOS (cgosGtp client) and OGS (gtp2ogs).
 *
 * Usage: node tools/eval/gtp.js [--komi 7.5]
 *
 * Notes:
 *  - 9x9 only (boardsize other than 9 is rejected).
 *  - The engine uses its own fixed search budget; time_settings/time_left
 *    are accepted but currently ignored (see docs/eval.md).
 *  - All engine chatter (console.log) is redirected to stderr so stdout
 *    stays clean GTP.
 */
'use strict';

// Keep the engine fully synchronous: every reply settled before genmove returns.
process.env.PEBBLE_NO_PONDER = '1';

// Engine logs via console.log — must not pollute GTP stdout.
const origLog = console.log;
console.log = (...args) => process.stderr.write(args.join(' ') + '\n');

const fs = require('fs');
const path = require('path');
const { freshPebble } = require('../../tests/pkjs/mock_pebble');
const R = require('./go_rules');

const PKJS = path.resolve(__dirname, '../../src/pkjs/pebble-js-app.js');
let ENGINE_VERSION = '1.2.0';
try {
    ENGINE_VERSION = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')).version || ENGINE_VERSION;
} catch (e) { /* keep default */ }

let KOMI = 7.5;
for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === '--komi') KOMI = parseFloat(process.argv[i + 1]);
}

// ---- engine bootstrap ----
const pebble = freshPebble();
require(PKJS);
pebble._emit('ready', {});

// ---- game state ----
let board, ko, history, toMove, lastR, lastC, passes, movesMade, komi;

function resetPosition() {
    board = new Array(81).fill(R.EMPTY);
    ko = { board: new Array(81).fill(R.EMPTY), active: false };
    history = [];
    toMove = R.BLACK;
    lastR = 4; lastC = 4;
    passes = 0; movesMade = 0;
    komi = KOMI;
}
resetPosition();

function snapshot() {
    return {
        board: board.slice(), koBoard: ko.board.slice(), koActive: ko.active,
        toMove, lastR, lastC, passes, movesMade,
    };
}

function restore(s) {
    board = s.board.slice();
    ko = { board: s.koBoard.slice(), active: s.koActive };
    toMove = s.toMove; lastR = s.lastR; lastC = s.lastC;
    passes = s.passes; movesMade = s.movesMade;
}

function engineMove(player) {
    // One synchronous request, exactly like tests/match/play.js aiRequest().
    for (let attempt = 0; attempt < 2; attempt++) {
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
            return { error: 'engine gave no reply' };
        const reply = pebble.sentMessages[0];
        if (reply[3] === 2)
            continue; // engine error: one retry (mirrors watch Retry)
        return { row: reply[1], col: reply[2], pass: reply[3] === 1 };
    }
    return { error: 'engine error twice' };
}

function applyPass() {
    history.push(snapshot());
    passes++;
    toMove = R.opp(toMove);
}

function showBoard() {
    const lines = [''];
    for (let r = 0; r < 9; r++) {
        let line = '';
        for (let c = 0; c < 9; c++) {
            const v = board[r * 9 + c];
            line += v === R.BLACK ? 'X ' : v === R.WHITE ? 'O ' : '. ';
        }
        lines.push(line);
    }
    return lines.join('\n');
}

// Standard 9x9 fixed-handicap points, (row, col) 0-indexed top-left origin.
const HANDICAP_PTS = [[2, 2], [6, 6], [2, 6], [6, 2], [4, 4], [1, 1], [7, 7], [1, 7], [7, 1]];

// ---- GTP main loop ----
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
    const head = ok ? '=' : '?';
    process.stdout.write(head + (id ? id : '') + (text ? ' ' + text : '') + '\n\n');
}

function handleLine(raw) {
    // Strip comments (# ...) and whitespace/control chars.
    const hash = raw.indexOf('#');
    let line = (hash >= 0 ? raw.slice(0, hash) : raw).replace(/[\t\r]+/g, ' ').trim();
    if (!line)
        return;
    const parts = line.split(/ +/);
    let id = '';
    if (/^[0-9]+$/.test(parts[0]))
        id = parts.shift();
    const cmd = (parts.shift() || '').toLowerCase();
    const args = parts;

    const err = (msg) => respond(id, false, msg);
    const ok = (text) => respond(id, true, text || '');

    switch (cmd) {
        case 'protocol_version': return ok('2');
        case 'name': return ok('PebbleGo');
        case 'version': return ok(ENGINE_VERSION);
        case 'known_command': return ok((KNOWN.has((args[0] || '').toLowerCase()) ? 'true' : 'false'));
        case 'list_commands': return ok([...KNOWN].sort().join('\n'));
        case 'quit': respond(id, true, ''); process.exit(0); return;
        case 'echo': return ok(args.join(' '));

        case 'boardsize':
            if (parseInt(args[0], 10) !== 9) return err('unacceptable size (9x9 only)');
            resetPosition();
            return ok('');

        case 'clear_board':
            resetPosition();
            return ok('');

        case 'komi':
            komi = parseFloat(args[0]);
            if (!(komi >= 0)) return err('invalid komi');
            return ok('');

        case 'fixed_handicap': {
            const n = parseInt(args[0], 10);
            if (!(n >= 2 && n <= HANDICAP_PTS.length)) return err('invalid handicap');
            if (board.some((v) => v !== R.EMPTY)) return err('board not empty');
            history.push(snapshot());
            const pts = [];
            for (let i = 0; i < n; i++) {
                board[HANDICAP_PTS[i][0] * 9 + HANDICAP_PTS[i][1]] = R.BLACK;
                pts.push(R.formatVertex(HANDICAP_PTS[i][0], HANDICAP_PTS[i][1]));
            }
            movesMade += n;
            toMove = R.WHITE;
            return ok(pts.join(' '));
        }

        case 'place_free_handicap':
        case 'set_free_handicap': {
            if (board.some((v) => v !== R.EMPTY)) return err('board not empty');
            history.push(snapshot());
            for (const a of args) {
                const v = R.parseVertex(a);
                if (!v || v.pass) return err('invalid vertex ' + a);
                board[v.r * 9 + v.c] = R.BLACK;
                movesMade++;
            }
            toMove = R.WHITE;
            return ok('');
        }

        case 'play': {
            const color = (args[0] || '').toLowerCase();
            const player = color.startsWith('b') ? R.BLACK : color.startsWith('w') ? R.WHITE : 0;
            if (!player) return err('invalid color');
            const v = R.parseVertex(args[1] || '');
            if (!v) return err('invalid vertex');
            if (v.pass) {
                applyPass();
                return ok('');
            }
            const pre = snapshot();
            const res = R.refereePlace(board, ko, player, v.r, v.c);
            if (!res.ok) return err('illegal move');
            history.push(pre);
            lastR = v.r; lastC = v.c;
            passes = 0; movesMade++;
            toMove = R.opp(player);
            return ok('');
        }

        case 'genmove': {
            const color = (args[0] || '').toLowerCase();
            const player = color.startsWith('b') ? R.BLACK : color.startsWith('w') ? R.WHITE : 0;
            if (!player) return err('invalid color');
            const mv = engineMove(player);
            if (mv.error) return err(mv.error);
            if (mv.pass || mv.row === 9) {
                applyPass();
                return ok('pass');
            }
            const pre = snapshot();
            const res = R.refereePlace(board, ko, player, mv.row, mv.col);
            if (!res.ok) {
                process.stderr.write(`gtp: engine returned illegal ${R.formatVertex(mv.row, mv.col)}, passing\n`);
                applyPass();
                return ok('pass');
            }
            history.push(pre);
            lastR = mv.row; lastC = mv.col;
            passes = 0; movesMade++;
            toMove = R.opp(player);
            return ok(R.formatVertex(mv.row, mv.col));
        }

        case 'undo':
            if (!history.length) return err('nothing to undo');
            restore(history.pop());
            return ok('');

        case 'final_score': {
            const s = R.areaScore(board, komi);
            if (s.diff > 0) return ok('B+' + s.diff);
            if (s.diff < 0) return ok('W+' + (-s.diff));
            return ok('0');
        }

        case 'final_status_list':
            // Minimal: everything on the board is alive (we never claim dead).
            if ((args[0] || '').toLowerCase() !== 'alive') return err('only "alive" supported');
            return ok('');

        case 'time_settings':
        case 'time_left':
        case 'kgs-time_settings':
            // Accepted but ignored: fixed internal budget (see docs/eval.md).
            return ok('');

        case 'cputime': return ok('0');
        case 'showboard': return ok(showBoard());
        case 'gogui-sigint': return ok('');

        default:
            return err('unknown command');
    }
}

const KNOWN = new Set([
    'protocol_version', 'name', 'version', 'known_command', 'list_commands',
    'quit', 'boardsize', 'clear_board', 'komi', 'play', 'genmove', 'undo',
    'final_score', 'final_status_list', 'fixed_handicap', 'place_free_handicap',
    'set_free_handicap', 'time_settings', 'time_left', 'kgs-time_settings',
    'cputime', 'showboard', 'echo', 'gogui-sigint',
]);
