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
    assert.ok(r[3] === 0 || r[3] === 1, 'is_pass must be 0/1');
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

/* --- opening quality: no first-line reply to a center opening --- */

function onEdge(r, c) {
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

/* --- malformed input must still reply (hang regression) --- */

test('missing board replies pass (no throw, no hang)', () => {
    loadPkjs();
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 4, 3: 4, 4: 0 });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 1, 'must be a pass');
});

test('short board replies pass', () => {
    loadPkjs();
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 4, 3: 4, 4: 0, 5: [1, 2], 6: [0] });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 1, 'must be a pass');
});

test('missing ko replies pass', () => {
    loadPkjs();
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 4, 3: 4, 4: 0, 5: validBoard() });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 1, 'must be a pass');
});

test('invalid player replies pass', () => {
    loadPkjs();
    const msgs = aiRequest({ 0: 0, 1: 7, 2: 4, 3: 4, 4: 0, 5: validBoard(), 6: validKo() });
    const r = assertSingleReply(msgs);
    assert.strictEqual(r[3], 1, 'must be a pass');
});

test('missing payload is ignored without throwing', () => {
    loadPkjs();
    pebble.reset();
    pebble._emit('appmessage', {});
    assert.strictEqual(pebble.sentMessages.length, 0);
});

/* --- responsiveness: reply must beat the 12000ms watch timeout --- */

test('MCTS reply arrives within time budget', () => {
    loadPkjs();
    const t0 = Date.now();
    const msgs = aiRequest({ 0: 0, 1: 1, 2: 4, 3: 4, 4: 0, 5: validBoard(), 6: validKo() });
    const dt = Date.now() - t0;
    assertSingleReply(msgs);
    assert.ok(dt < 12000, 'handler took ' + dt + 'ms, must be < 12000ms watch timeout');
    console.log('    (handler took ' + dt + 'ms)');
});

console.log(`\n=== pkjs: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
