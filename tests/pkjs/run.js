/*
 * L2 unit tests for src/pkjs/pebble-js-app.js run under Node with a mocked
 * Pebble global. Mirrors the timely-plus L2 pkjs harness.
 *
 * Core regression coverage for the "hanging AI move" bug: EVERY request
 * with type=0 must produce exactly one reply (a real move or a pass), even
 * on malformed input or internal throws — otherwise the watch sits in
 * AI_THINKING with dead buttons until its 4s timeout fires.
 *
 * Usage: node tests/pkjs/run.js
 */
'use strict';

// Hermetic tests: disable background pondering (it only warms cross-move
// AMAF via setTimeout slices, which would leak CPU/noise between cases).
process.env.PEBBLE_NO_PONDER = '1';

const assert = require('assert');
const path = require('path');

const { freshPebble } = require('./mock_pebble');

const PKJS = path.resolve(__dirname, '../../src/pkjs/pebble-js-app.js');

let pebble = null;

function loadPkjs() {
    pebble = freshPebble();
    delete require.cache[require.resolve(PKJS)];
    require(PKJS);
    pebble._emit('ready', {});
}

function aiRequest(payload) {
    pebble.reset();
    pebble._emit('appmessage', { payload });
    return pebble.sentMessages;
}

function validBoard() {
    const b = new Array(81).fill(0);
    b[4 * 9 + 4] = 1;
    b[4 * 9 + 5] = 2;
    return b;
}

function validKo() {
    return new Array(82).fill(0);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS ' + name);
    } catch (e) {
        failed++;
        console.log('FAIL ' + name + ': ' + e.message);
    }
}

function assertSingleReply(msgs) {
    assert.strictEqual(msgs.length, 1, 'expected exactly one reply, got ' + msgs.length);
    const r = msgs[0];
    assert.strictEqual(r[0], 1, 'reply type must be 1');
    assert.ok(Number.isInteger(r[1]) && Number.isInteger(r[2]), 'row/col must be ints');
    assert.ok(r[3] === 0 || r[3] === 1 || r[3] === 2, 'is_pass must be 0/1/2');
    return r;
}

/* --- happy path --- */

test('valid request replies with a move', () => {
    loadPkjs();
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 4, 3: 4, 4: 0, 5: validBoard(), 6: validKo() });
    const r = assertSingleReply(msgs);
    assert.ok(r[1] >= 0 && r[1] <= 9 && r[2] >= 0 && r[2] <= 9, 'coords in range');
});

test('Uint8Array board payload works', () => {
    loadPkjs();
    const msgs = aiRequest({ 0: 0, 1: 2, 2: 0, 3: 0, 4: 0, 5: Uint8Array.from(validBoard()), 6: Uint8Array.from(validKo()) });
    assertSingleReply(msgs);
});

test('non-zero type is ignored (no reply)', () => {
    loadPkjs();
    const msgs = aiRequest({ 0: 99 });
    assert.strictEqual(msgs.length, 0);
});

/* --- opening book: KataGo-based first two moves, rotation-proof --- */

test('book plays 4-4 on empty board', () => {
    loadPkjs();
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 4, 3: 4, 4: 0, 5: new Array(81).fill(0), 6: validKo(), 7: 0 });
    const r = assertSingleReply(msgs);
    assert.deepStrictEqual([r[1], r[2], r[3]], [3, 3, 0]);
});

test('book answers 4-4 corner with opposing 4-4, all rotations', () => {
    // Black (3,3) and its rotations -> White mirrors across the center.
    const cases = [
        [[3, 3], [5, 5]], [[3, 5], [5, 3]],
        [[5, 5], [3, 3]], [[5, 3], [3, 5]],
    ];
    for (const [[br, bc], [er, ec]] of cases) {
        loadPkjs();
        const board = new Array(81).fill(0);
        board[br * 9 + bc] = 1;
        const msgs = aiRequest({ 0: 0, 1: 2, 2: br, 3: bc, 4: 0, 5: board, 6: validKo(), 7: 1 });
        const r = assertSingleReply(msgs);
        assert.deepStrictEqual([r[1], r[2], r[3]], [er, ec, 0],
            'vs black (' + br + ',' + bc + ')');
    }
});

test('book answers tengen with 3-3 corner', () => {
    loadPkjs();
    const board = new Array(81).fill(0);
    board[4 * 9 + 4] = 1;
    const msgs = aiRequest({ 0: 0, 1: 2, 2: 4, 3: 4, 4: 0, 5: board, 6: validKo(), 7: 1 });
    const r = assertSingleReply(msgs);
    assert.deepStrictEqual([r[1], r[2], r[3]], [2, 2, 0]);
});

test('book default is diagonal split, rotation-consistent', () => {
    loadPkjs();
    const board = new Array(81).fill(0);
    board[1 * 9 + 4] = 1; // side stone: canonical (1,4) -> reply (7,4)
    const msgs = aiRequest({ 0: 0, 1: 2, 2: 1, 3: 4, 4: 0, 5: board, 6: validKo(), 7: 1 });
    const r = assertSingleReply(msgs);
    assert.deepStrictEqual([r[1], r[2], r[3]], [7, 4, 0]);
});

/* --- opening quality: no first-line reply to a center opening --- */function onEdge(r, c) {
    return r === 0 || r === 8 || c === 0 || c === 8;
}

test('opening reply to center stone is not on the edge', () => {
    loadPkjs();
    const board = new Array(81).fill(0);
    board[4 * 9 + 4] = 1; // black 1st move: tengen (center)
    const msgs = aiRequest({ 0: 0, 1: 2, 2: 4, 3: 4, 4: 0, 5: board, 6: validKo() });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 0, 'white should play a stone, not pass');
    assert.strictEqual(board[r[1] * 9 + r[2]], 0, 'reply must be on an empty point');
    assert.ok(!onEdge(r[1], r[2]),
        'white reply (' + r[1] + ',' + r[2] + ') must not be on the edge');
});

/* --- pass discipline: never early, always when finished --- */test('does not pass on an empty board', () => {
    loadPkjs();
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 4, 3: 4, 4: 0, 5: new Array(81).fill(0), 6: validKo() });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 0, 'must play a stone on move 1, not pass');
});

test('does not pass midgame', () => {
    loadPkjs();
    const board = new Array(81).fill(0);
    board[2 * 9 + 2] = 1; board[2 * 9 + 3] = 1; board[3 * 9 + 2] = 1;
    board[6 * 9 + 6] = 2; board[6 * 9 + 5] = 2; board[5 * 9 + 6] = 2;
    board[4 * 9 + 4] = 1;
    const msgs = aiRequest({ 0: 0, 1: 2, 2: 4, 3: 4, 4: 0, 5: board, 6: validKo(), 7: 20 });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 0, 'must play in an open midgame, not pass');
});

test('does not pass a dense fight (pass-prior regression)', () => {
    // Dense chaotic board where every stone move looks bad in playouts:
    // the pass child used to outrank them all. Pass must stay crippled
    // while the board is open.
    loadPkjs();
    let s = 7;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const board = new Array(81).fill(0);
    for (let i = 0; i < 81; i++) {
        if (rnd() < 0.7)
            board[i] = rnd() < 0.5 ? 1 : 2;
    }
    const msgs = aiRequest({ 0: 0, 1: 2, 2: 4, 3: 4, 4: 0, 5: board, 6: validKo(), 7: 30 });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 0, 'must play in a dense fight, not pass');
});

test('passes a full board late game', () => {
    loadPkjs();
    const board = [];
    for (let i = 0; i < 81; i++) board[i] = (i % 2) + 1;
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 0, 3: 0, 4: 1, 5: board, 6: validKo(), 7: 80 });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 1, 'must pass when no legal move exists');
});

test('refuses early pass with an error, even on a full board', () => {
    loadPkjs();
    const board = [];
    for (let i = 0; i < 81; i++) board[i] = (i % 2) + 1;
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 0, 3: 0, 4: 1, 5: board, 6: validKo(), 7: 10 });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 2, 'early pass must be reported as error, not played');
});

/* --- tactics: must capture a group in atari --- */test('takes the atari capture', () => {
    loadPkjs();
    // Black stone (4,4) has one liberty left at (4,5); White to move must
    // capture there instead of playing elsewhere.
    const board = new Array(81).fill(0);
    board[4 * 9 + 4] = 1;
    board[3 * 9 + 4] = 2;
    board[5 * 9 + 4] = 2;
    board[4 * 9 + 3] = 2;
    const msgs = aiRequest({ 0: 0, 1: 2, 2: 4, 3: 4, 4: 0, 5: board, 6: validKo() });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 0, 'white should play a stone, not pass');
    assert.deepStrictEqual([r[1], r[2]], [4, 5], 'white must capture at (4,5)');
});

test('escapes its own atari instead of tenuki', () => {
    loadPkjs();
    // Mirror: Black stone (4,4) has one liberty left at (4,5); Black to
    // move must escape there. Tenuki looks deceptively good in random
    // playouts (the simulated opponent marches into walls instead of the
    // open board), so this only passes via the escape-urgency prior plus
    // honest playout defenses — never via raw statistics.
    const board = new Array(81).fill(0);
    board[4 * 9 + 4] = 1;
    board[3 * 9 + 4] = 2;
    board[5 * 9 + 4] = 2;
    board[4 * 9 + 3] = 2;
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 4, 3: 4, 4: 0, 5: board, 6: validKo(), 7: 10 });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 0, 'black should play a stone, not pass');
    assert.deepStrictEqual([r[1], r[2]], [4, 5], 'black must escape at (4,5)');
});

/* --- life as policy (items A/E): build eyes, don't fill them --- */

test('captures the eye-space peeper', () => {
    loadPkjs();
    // White peeped into the framework at (2,4) with one liberty (2,3):
    // playing the divider captures it AND splits the interior into two
    // 1-point eyes. Forced tactics (Tier-1) and knowledge (eye prior)
    // agree, so this is deterministic across search dynamics — unlike a
    // pure taste-level division, which visit arithmetic can flip. (Pure
    // division preference is verified ad hoc, not pinned here.)
    const board = new Array(81).fill(0);
    [[1, 1], [1, 2], [1, 3], [1, 4], [1, 5],
     [2, 1], [2, 5],
     [3, 1], [3, 2], [3, 3], [3, 4], [3, 5]].forEach(([r, c]) => board[r * 9 + c] = 1);
    board[2 * 9 + 4] = 2;
    board[6 * 9 + 6] = 2;
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 2, 3: 4, 4: 0, 5: board, 6: validKo(), 7: 20 });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 0, 'black should play a stone, not pass');
    assert.deepStrictEqual([r[1], r[2]], [2, 3], 'black must divide-capture at (2,3)');
});

test('never fills its own finished eye', () => {
    loadPkjs();
    // Black ring with a single-point eye at (2,2); filling it is vetoed.
    const board = new Array(81).fill(0);
    [[1, 1], [1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2], [3, 3]].forEach(([r, c]) => board[r * 9 + c] = 1);
    board[6 * 9 + 6] = 2;
    board[6 * 9 + 7] = 2;
    board[7 * 9 + 6] = 2;
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 0, 3: 0, 4: 0, 5: board, 6: validKo(), 7: 20 });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 0, 'black should play a stone, not pass');
    assert.ok(!(r[1] === 2 && r[2] === 2), 'black must not fill its eye at (2,2)');
    assert.strictEqual(board[r[1] * 9 + r[2]], 0, 'reply must be on an empty point');
});

test('does not march into a broken ladder', () => {
    loadPkjs();
    // Black (4,4) in atari with liberty (4,5), but a white wall along
    // column 6 funnels the chase to the edge: the escape dies. The AI must
    // tenuki anywhere else instead of donating the group.
    const board = new Array(81).fill(0);
    board[4 * 9 + 4] = 1;
    [[3, 4], [5, 4], [4, 3], [2, 6], [3, 6], [4, 6], [5, 6], [2, 5]].forEach(([r, c]) => board[r * 9 + c] = 2);
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 4, 3: 4, 4: 0, 5: board, 6: validKo(), 7: 10 });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 0, 'black should play a stone, not pass');
    assert.ok(!(r[1] === 4 && r[2] === 5), 'black must not escape into the broken ladder at (4,5)');
    assert.strictEqual(board[r[1] * 9 + r[2]], 0, 'reply must be on an empty point');
});

test('never recaptures a ko immediately', () => {
    loadPkjs();
    // True ko: W(4,5) just took B(4,4); recapturing at (4,4) takes W(4,5)
    // back, repeating the ko board, so it is banned (not suicide: the
    // recapture captures). Exact generation must filter it and the veto
    // must re-verify; the reply has to be a stone anywhere else.
    const board = new Array(81).fill(0);
    [[3, 5], [5, 5], [4, 6]].forEach(([r, c]) => board[r * 9 + c] = 1);
    [[4, 5], [3, 4], [5, 4], [4, 3]].forEach(([r, c]) => board[r * 9 + c] = 2);
    board[0 * 9 + 0] = 1;
    board[8 * 9 + 8] = 2;
    const koB = board.slice();
    koB[4 * 9 + 5] = 0;
    koB[4 * 9 + 4] = 1;
    const ko = koB.slice();
    ko.push(1);
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 4, 3: 5, 4: 0, 5: board, 6: ko, 7: 50 });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 0, 'black should play a stone, not pass');
    assert.ok(!(r[1] === 4 && r[2] === 4), 'black must not recapture the ko at (4,4)');
    assert.strictEqual(board[r[1] * 9 + r[2]], 0, 'reply must be on an empty point');
});

test('never plays a surrounded suicide', () => {
    loadPkjs();
    // (4,4) is fully surrounded by a connected white wall with outside
    // liberties: no capture, so it is pure suicide. Must play elsewhere.
    const board = new Array(81).fill(0);
    [[3, 4], [5, 4], [4, 3], [4, 5], [3, 3], [3, 5], [5, 3], [5, 5]].forEach(([r, c]) => board[r * 9 + c] = 2);
    board[0 * 9 + 0] = 1;
    board[8 * 9 + 8] = 1;
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 0, 3: 0, 4: 0, 5: board, 6: validKo(), 7: 50 });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 0, 'black should play a stone, not pass');
    assert.ok(!(r[1] === 4 && r[2] === 4), 'black must not suicide at (4,4)');
    assert.strictEqual(board[r[1] * 9 + r[2]], 0, 'reply must be on an empty point');
});

test('connects split walls instead of tenuki', () => {
    loadPkjs();
    // Two black walls with a one-point gap at (4,3) and a white peep at
    // (5,3): connecting defends the cut. Tenuki lets white through.
    const board = new Array(81).fill(0);
    [[4, 2], [4, 4], [3, 2], [3, 4], [5, 2], [5, 4]].forEach(([r, c]) => board[r * 9 + c] = 1);
    board[5 * 9 + 3] = 2;
    board[0 * 9 + 0] = 2;
    board[8 * 9 + 8] = 2;
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 4, 3: 4, 4: 0, 5: board, 6: validKo(), 7: 20 });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 0, 'black should play a stone, not pass');
    assert.deepStrictEqual([r[1], r[2]], [4, 3], 'black must connect at (4,3)');
});

/* --- fuseki book (moves 2-9): pro shape instead of noise --- */

test('fuseki takes the empty corner on move 3', () => {
    loadPkjs();
    // B(3,3), W(5,5): the emptiest quadrant star is (2,6).
    const board = new Array(81).fill(0);
    board[3 * 9 + 3] = 1;
    board[5 * 9 + 5] = 2;
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 5, 3: 5, 4: 0, 5: board, 6: validKo(), 7: 2 });
    const r = assertSingleReply(msgs);
    assert.deepStrictEqual([r[1], r[2], r[3]], [2, 6, 0]);
});

test('fuseki encloses an approached 4-4', () => {
    loadPkjs();
    // B(3,3) approached low at (3,5): extend the other side (5,3).
    const board = new Array(81).fill(0);
    board[3 * 9 + 3] = 1;
    board[3 * 9 + 5] = 2;
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 3, 3: 5, 4: 0, 5: board, 6: validKo(), 7: 2 });
    const r = assertSingleReply(msgs);
    assert.deepStrictEqual([r[1], r[2], r[3]], [5, 3, 0]);
});

/* --- retry explores: consecutive identical requests stay valid --- */

test('repeated request stays a valid reply', () => {
    loadPkjs();
    const board = new Array(81).fill(0);
    board[4 * 9 + 4] = 1;
    const payload = { 0: 0, 1: 2, 2: 4, 3: 4, 4: 0, 5: board, 6: validKo(), 7: 1 };
    const r1 = assertSingleReply(aiRequest(payload));
    const r2 = assertSingleReply(aiRequest(payload));
    for (const r of [r1, r2]) {
        assert.ok(r[3] === 0 || r[3] === 1 || r[3] === 2, 'tri-state reply');
        if (r[3] === 0)
            assert.strictEqual(board[r[1] * 9 + r[2]], 0, 'stone reply must be legal');
    }
});

/* --- malformed input must still reply (hang regression), as error --- */

test('missing board replies error (no throw, no hang)', () => {
    loadPkjs();
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 4, 3: 4, 4: 0 });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 2, 'must be an error');
});

test('short board replies error', () => {
    loadPkjs();
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 4, 3: 4, 4: 0, 5: [1, 2], 6: [0] });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 2, 'must be an error');
});

test('missing ko replies error', () => {
    loadPkjs();
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 4, 3: 4, 4: 0, 5: validBoard() });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 2, 'must be an error');
});

test('invalid player replies error', () => {
    loadPkjs();
    const msgs = aiRequest({ 0: 0, 1: 7, 2: 4, 3: 4, 4: 0, 5: validBoard(), 6: validKo() });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 2, 'must be an error');
});

test('missing payload is ignored without throwing', () => {
    loadPkjs();
    pebble.reset();
    pebble._emit('appmessage', {});
    assert.strictEqual(pebble.sentMessages.length, 0);
});

/* --- responsiveness: reply must beat the 72000ms watch timeout --- */

test('MCTS reply arrives within time budget', () => {
    loadPkjs();
    const t0 = Date.now();
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 4, 3: 4, 4: 0, 5: validBoard(), 6: validKo() });
    const dt = Date.now() - t0;
    assertSingleReply(msgs);
    assert.ok(dt < 72000, 'handler took ' + dt + 'ms, must be < 72000ms watch timeout');
    console.log('    (handler took ' + dt + 'ms)');
});

console.log(`\n=== pkjs: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
