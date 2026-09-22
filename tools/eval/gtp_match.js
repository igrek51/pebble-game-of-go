/*
 * GTP match runner: plays full 9x9 games between two GTP engines.
 *
 * Usage:
 *   node tools/eval/gtp_match.js --black "<cmd>" --white "<cmd>"
 *       [--games N] [--komi 7.5] [--sgf-dir dir] [--max-moves 300]
 *       [--move-timeout-ms 120000] [--label "text"]
 *
 * Rules: independent referee (tools/eval/go_rules.js), 2 consecutive passes
 * end the game, scored with Chinese area rules (Benson dead removal).
 * Illegal move from an engine = immediate loss. "resign" ends the game.
 * Colors alternate each game (game 0: given black plays black).
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const R = require('./go_rules');

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const GAMES = parseInt(arg('games', '2'), 10);
const KOMI = parseFloat(arg('komi', '7.5'));
const SGF_DIR = arg('sgf-dir', '');
const MAX_MOVES = parseInt(arg('max-moves', '300'), 10);
const MOVE_TIMEOUT = parseInt(arg('move-timeout-ms', '120000'), 10);
const LABEL = arg('label', '');

class GtpEngine {
    constructor(name, cmdline) {
        this.name = name;
        // Naive shell-like split (no quoted spaces needed for our commands).
        const parts = cmdline.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
        const cmd = parts.shift();
        const args = parts.map((p) => p.replace(/^["']|["']$/g, ''));
        this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
        this.buf = '';
        this.pending = [];
        this.id = 0;
        this.dead = false;
        this.proc.on('exit', () => { this.dead = true; this.failAll('engine exited'); });
        this.proc.on('error', (e) => { this.dead = true; this.failAll(String(e)); });
        this.proc.stdout.setEncoding('utf8');
        this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    }

    onData(chunk) {
        this.buf += chunk;
        // GTP responses are blank-line terminated.
        const parts = this.buf.split('\n\n');
        this.buf = parts.pop();
        for (const p of parts) this.onResponse(p);
    }

    onResponse(text) {
        const line = text.trim();
        if (!line) return;
        const m = line.match(/^([=?])(\d*)\s*([\s\S]*)$/);
        if (!m) return;
        const [, status, id, body] = m;
        const q = this.pending.find((p) => String(p.id) === id) || this.pending[0];
        if (!q) return;
        this.pending.splice(this.pending.indexOf(q), 1);
        clearTimeout(q.timer);
        if (status === '=') q.resolve(body.trim());
        else q.reject(new Error(body.trim() || 'GTP error'));
    }

    failAll(msg) {
        for (const q of this.pending.splice(0)) {
            clearTimeout(q.timer);
            q.reject(new Error(msg));
        }
    }

    send(cmd) {
        return new Promise((resolve, reject) => {
            if (this.dead) return reject(new Error('engine dead'));
            const id = ++this.id;
            const timer = setTimeout(() => {
                const i = this.pending.findIndex((p) => p.id === id);
                if (i >= 0) this.pending.splice(i, 1);
                reject(new Error('timeout: ' + cmd));
            }, MOVE_TIMEOUT);
            this.pending.push({ id, resolve, reject, timer });
            this.proc.stdin.write(id + ' ' + cmd + '\n');
        });
    }

    async newGame() {
        await this.send('boardsize 9');
        await this.send('komi ' + KOMI);
        await this.send('clear_board');
    }

    quit() {
        try { this.proc.stdin.write('quit\n'); } catch (e) { /* dead */ }
        setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch (e) { /* dead */ } }, 1000).unref?.();
    }
}

const COLS = 'ABCDEFGHJ';
function sgfCoord(r, c) {
    return 'abcdefghj'[c] + 'abcdefghj'[r];
}

function toSgf(moves, result, blackName, whiteName) {
    let s = `(;GM[1]FF[4]SZ[9]KM[${KOMI}]PB[${blackName}]PW[${whiteName}]RE[${result}]`;
    for (const m of moves) {
        if (m.pass) s += `;${m.color}[tt]`;
        else s += `;${m.color}[${sgfCoord(m.r, m.c)}]`;
    }
    return s + ')';
}

async function playGame(black, white, gameNo) {
    await black.newGame();
    await white.newGame();
    const board = new Array(81).fill(R.EMPTY);
    const ko = { board: new Array(81).fill(R.EMPTY), active: false };
    const moves = [];
    let toMove = R.BLACK;
    let passes = 0;
    let moveNo = 0;
    let result = null;

    while (!result && moveNo < MAX_MOVES) {
        moveNo++;
        const me = toMove === R.BLACK ? black : white;
        const foe = toMove === R.BLACK ? white : black;
        const colorName = toMove === R.BLACK ? 'black' : 'white';
        const colorTag = toMove === R.BLACK ? 'B' : 'W';
        let vertex;
        try {
            vertex = await me.send('genmove ' + colorName);
        } catch (e) {
            result = { winner: R.opp(toMove), reason: 'opponent crashed/timeout (' + e.message + ')', score: null };
            break;
        }
        const first = vertex.split(/\s+/)[0].toLowerCase();
        if (first === 'resign') {
            result = { winner: R.opp(toMove), reason: 'resign', score: null };
            break;
        }
        const v = R.parseVertex(first);
        if (!v) {
            result = { winner: R.opp(toMove), reason: 'unparseable genmove "' + vertex + '"', score: null };
            break;
        }
        if (v.pass) {
            passes++;
            moves.push({ color: colorTag, pass: true });
            try { await foe.send('play ' + colorName + ' pass'); } catch (e) { /* ignore */ }
            toMove = R.opp(toMove);
            if (passes >= 2) {
                const s = R.areaScore(board, KOMI);
                const w = s.diff > 0 ? R.BLACK : s.diff < 0 ? R.WHITE : 0;
                result = { winner: w, reason: 'score', score: s.diff, detail: s };
            }
            continue;
        }
        const res = R.refereePlace(board, ko, toMove, v.r, v.c);
        if (!res.ok) {
            result = { winner: R.opp(toMove), reason: 'illegal move ' + first, score: null };
            break;
        }
        passes = 0;
        moves.push({ color: colorTag, r: v.r, c: v.c });
        try { await foe.send('play ' + colorName + ' ' + first); }
        catch (e) {
            // Opponent rejects a legal move (rules mismatch): not a loss,
            // but the game can't continue fairly — void it.
            result = { winner: 0, reason: 'opponent rejected legal move ' + first + ' (' + e.message + ')', score: null };
            break;
        }
        toMove = R.opp(toMove);
    }
    if (!result)
        result = { winner: 0, reason: 'max moves reached', score: null };

    const wname = result.winner === R.BLACK ? 'B' : result.winner === R.WHITE ? 'W' : 'Void';
    const sgfResult = result.reason === 'score'
        ? (result.score > 0 ? `B+${result.score}` : result.score < 0 ? `W+${-result.score}` : 'Draw')
        : (wname === 'Void' ? 'Void' : `${wname}+${result.reason === 'resign' ? 'R' : 'F'}`);
    if (SGF_DIR) {
        fs.mkdirSync(SGF_DIR, { recursive: true });
        const stamp = LABEL ? LABEL.replace(/[^a-z0-9]+/gi, '_') + '_' : '';
        fs.writeFileSync(path.join(SGF_DIR, `${stamp}game${gameNo}.sgf`),
            toSgf(moves, sgfResult, black.name, white.name));
    }
    return { ...result, sgfResult, moves: moves.length };
}

async function main() {
    const blackCmd = arg('black', null), whiteCmd = arg('white', null);
    if (!blackCmd || !whiteCmd) {
        console.error('need --black "<cmd>" --white "<cmd>"');
        process.exit(2);
    }
    const engA = new GtpEngine('A', blackCmd);
    const engB = new GtpEngine('B', whiteCmd);
    // Name the engines properly.
    try { engA.name = await engA.send('name'); } catch (e) { engA.name = 'A'; }
    try { engB.name = await engB.send('name'); } catch (e) { engB.name = 'B'; }

    let winsA = 0, winsB = 0, voided = 0;
    for (let g = 0; g < GAMES; g++) {
        // Alternate colors: even games A=black, odd games B=black.
        const black = g % 2 === 0 ? engA : engB;
        const white = g % 2 === 0 ? engB : engA;
        const r = await playGame(black, white, g);
        const winnerName = r.winner === R.BLACK ? black.name : r.winner === R.WHITE ? white.name : '(void)';
        if (r.winner === 0) voided++;
        else if ((r.winner === R.BLACK && black === engA) || (r.winner === R.WHITE && white === engA)) winsA++;
        else winsB++;
        console.log(`game ${g}: ${black.name}(B) vs ${white.name}(W) -> ${r.sgfResult} [${r.reason}] (${r.moves} moves)`);
    }
    console.log(`\nsummary: A=${engA.name} ${winsA} - ${winsB} ${engB.name}=B, voided=${voided} (games=${GAMES})`);
    engA.quit();
    engB.quit();
    // Exit code: 0 if played, 1 if everything voided.
    process.exit(winsA + winsB > 0 ? 0 : 1);
}

main().catch((e) => { console.error('fatal: ' + e.message); process.exit(2); });
