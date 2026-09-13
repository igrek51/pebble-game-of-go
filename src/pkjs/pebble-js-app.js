var BOARD_SIZE = 9;
var EMPTY = 0, BLACK = 1, WHITE = 2;

var MCTS_PASS_ROW = 9;
var MCTS_PASS_COL = 9;
var MCTS_POOL_SIZE = 10000;
var MCTS_NO_NODE = -1;
var MCTS_ITERATIONS = 300;
var MCTS_MAX_PLAYOUT = 120;
// Wall-clock budget for one AI move. The watch falls back to its local AI
// after COMM_TIMEOUT_MS (6000ms), so the reply must leave well before that,
// including AppMessage transport time. Phone JS engines are much slower than
// desktop V8 (300 iterations measured ~1.7s on V8), so mctsRun() stops early
// once this budget is exceeded instead of running all iterations.
var MCTS_TIME_BUDGET_MS = 4000;

var nodePool = [];
var nodePoolUsed = 0;
var rootNode = MCTS_NO_NODE;

var simBoard = [];
var simKoBoard = [];
var simKoActive = false;
var simPlayer = EMPTY;
var simLastRow = -1;
var simLastCol = -1;
var simPasses = 0;

var playBoard = [];
var playKoBoard = [];
var playKoActive = false;
var playPlayer = EMPTY;
var playLastRow = -1;
var playLastCol = -1;
var playPasses = 0;

var mctsPath = [];
var mctsPathLen = 0;

var simTempBoard = [];
var gBoard = [];
var gKoBoard = [];
var gKoActive = false;

var rngState = 12345;

var UCT_EXPLORE_TABLE = [
    0,   0,   117, 140, 155, 166, 175, 182, 189, 195, 201, 205, 210, 214, 218,
    222, 225, 228, 232, 235, 237, 240, 243, 245, 248, 250, 252, 255, 257, 259,
    261, 263, 265, 267, 269, 271, 272, 274, 276, 277, 279, 281, 282, 284, 285,
    287, 288, 290, 291, 292, 294, 295, 296, 298, 299, 300, 301, 303, 304, 305,
    306, 307, 308, 309, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321,
    322, 323, 324, 325, 326, 327, 328, 329, 330, 330, 331, 332, 333, 334, 335,
    336, 336, 337, 338, 339, 340, 340, 341, 342, 343, 344, 345, 346, 347, 347,
    348, 349, 350, 351, 351, 352, 353, 354, 354, 355, 356, 357, 357, 358, 359,
    360, 360, 361, 362, 363, 363, 364, 365, 365, 366, 367, 367, 368, 369, 369,
    370, 371, 372, 372, 373, 374, 374, 375, 376, 376, 377, 378, 378, 379, 379,
    380, 381, 381, 382, 383, 383, 384, 385, 385, 386, 387, 387, 388, 388, 389,
    390, 390, 391, 391, 392, 393, 393, 394, 394, 395, 396, 396, 397, 397, 398,
    399, 399, 400, 400, 401, 401, 402, 403, 403, 404, 404, 405, 405, 406, 407,
    407, 408, 408, 409, 409, 410
];

function boardIndex(row, col) {
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE)
        return -1;
    return row * BOARD_SIZE + col;
}

function mctsRng() {
    rngState = (rngState * 1664525 + 1013904223) | 0;
    return rngState >>> 0;
}

function initPools() {
    nodePool = [];
    nodePoolUsed = 0;
    rootNode = MCTS_NO_NODE;
    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (simBoard.length <= i) {
            simBoard[i] = 0;
            simKoBoard[i] = 0;
            playBoard[i] = 0;
            playKoBoard[i] = 0;
            simTempBoard[i] = 0;
        } else {
            simBoard[i] = 0;
            simKoBoard[i] = 0;
            playBoard[i] = 0;
            playKoBoard[i] = 0;
            simTempBoard[i] = 0;
        }
    }
    simKoActive = false;
    playKoActive = false;
    rngState = 12345;
}

function allocNode(moveRow, moveCol, player) {
    if (nodePoolUsed >= MCTS_POOL_SIZE)
        return MCTS_NO_NODE;
    var idx = nodePoolUsed;
    nodePoolUsed++;
    nodePool[idx] = {
        visits: 0,
        wins: 0,
        firstChild: MCTS_NO_NODE,
        nextSibling: MCTS_NO_NODE,
        moveRow: moveRow,
        moveCol: moveCol,
        player: player
    };
    return idx;
}

function uct(childIdx, parentVisits) {
    if (childIdx === MCTS_NO_NODE)
        return -999999;
    var node = nodePool[childIdx];
    if (node.visits === 0)
        return 999999;
    if (parentVisits === 0)
        return 999999;

    var exploit = Math.floor((node.wins * 1000) / node.visits);

    var numerator = 0;
    if (parentVisits < 200) {
        numerator = UCT_EXPLORE_TABLE[parentVisits] * 10;
    } else {
        numerator = 4100;
    }

    var v = node.visits;
    var rootN = 1;
    if (v >= 4) rootN = 2;
    if (v >= 9) rootN = 3;
    if (v >= 16) rootN = 4;
    if (v >= 25) rootN = 5;
    if (v >= 36) rootN = 6;
    if (v >= 49) rootN = 7;
    if (v >= 64) rootN = 8;
    if (v >= 81) rootN = 9;
    if (v >= 100) rootN = 10;
    if (v >= 121) rootN = 11;
    if (v >= 144) rootN = 12;
    if (v >= 169) rootN = 13;
    if (v >= 196) rootN = 14;

    return exploit + Math.floor(numerator / rootN);
}

function copyBoard(dst, src) {
    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
        dst[i] = src[i];
}

function countLibertiesOn(b, startRow, startCol, color) {
    var visited = [];
    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
        visited[i] = false;

    var liberties = 0;
    var stack = [];
    var startIdx = boardIndex(startRow, startCol);
    if (startIdx < 0 || b[startIdx] !== color)
        return 0;

    stack.push({r: startRow, c: startCol});
    visited[startIdx] = true;

    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];

    while (stack.length > 0) {
        var cell = stack.pop();
        for (var d = 0; d < 4; d++) {
            var nr = cell.r + dr[d];
            var nc = cell.c + dc[d];
            var nidx = boardIndex(nr, nc);
            if (nidx < 0 || visited[nidx])
                continue;
            var ns = b[nidx];
            if (ns === EMPTY) {
                liberties++;
                visited[nidx] = true;
            } else if (ns === color) {
                visited[nidx] = true;
                stack.push({r: nr, c: nc});
            }
        }
    }
    return liberties;
}

function removeGroupOn(b, startRow, startCol, color) {
    var visited = [];
    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
        visited[i] = false;

    var stack = [];
    var startIdx = boardIndex(startRow, startCol);
    if (startIdx < 0 || b[startIdx] !== color)
        return;

    stack.push({r: startRow, c: startCol});
    visited[startIdx] = true;

    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];

    while (stack.length > 0) {
        var cell = stack.pop();
        var idx = boardIndex(cell.r, cell.c);
        if (idx >= 0)
            b[idx] = EMPTY;

        for (var d = 0; d < 4; d++) {
            var nr = cell.r + dr[d];
            var nc = cell.c + dc[d];
            var nidx = boardIndex(nr, nc);
            if (nidx < 0 || visited[nidx])
                continue;
            if (b[nidx] === color) {
                visited[nidx] = true;
                stack.push({r: nr, c: nc});
            }
        }
    }
}

function wouldCaptureAtari(b, r, c, player) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];
    for (var d = 0; d < 4; d++) {
        var nr = r + dr[d], nc = c + dc[d];
        var nidx = boardIndex(nr, nc);
        if (nidx >= 0 && b[nidx] === opp &&
            countLibertiesOn(b, nr, nc, opp) === 1) {
            return true;
        }
    }
    return false;
}

function wouldEscapeAtari(b, r, c, player) {
    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];
    for (var d = 0; d < 4; d++) {
        var nr = r + dr[d], nc = c + dc[d];
        var nidx = boardIndex(nr, nc);
        if (nidx >= 0 && b[nidx] === player &&
            countLibertiesOn(b, nr, nc, player) === 1) {
            return true;
        }
    }
    return false;
}

function findLiberty(b, r, c) {
    var color = b[boardIndex(r, c)];
    var visited = [];
    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
        visited[i] = false;

    var stack = [{r: r, c: c}];
    visited[boardIndex(r, c)] = true;

    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];

    while (stack.length > 0) {
        var cell = stack.pop();
        for (var d = 0; d < 4; d++) {
            var nr = cell.r + dr[d], nc = cell.c + dc[d];
            var nidx = boardIndex(nr, nc);
            if (nidx < 0 || visited[nidx])
                continue;
            if (b[nidx] === EMPTY) {
                return {r: nr, c: nc};
            } else if (b[nidx] === color) {
                visited[nidx] = true;
                stack.push({r: nr, c: nc});
            }
        }
    }
    return {r: -1, c: -1};
}

function getLegalMovesOn(b, koB, koActive, player) {
    var opp = (player === BLACK) ? WHITE : BLACK;
    var moves = [];
    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];

    for (var row = 0; row < BOARD_SIZE; row++) {
        for (var col = 0; col < BOARD_SIZE; col++) {
            var idx = boardIndex(row, col);
            if (b[idx] !== EMPTY)
                continue;

            b[idx] = player;

            var legal = true;
            var anyCaptured = false;

            for (var d = 0; d < 4; d++) {
                var nr = row + dr[d], nc = col + dc[d];
                var nidx = boardIndex(nr, nc);
                if (nidx >= 0 && b[nidx] === opp) {
                    if (countLibertiesOn(b, nr, nc, opp) === 0) {
                        anyCaptured = true;
                    }
                }
            }

            if (!anyCaptured && countLibertiesOn(b, row, col, player) === 0) {
                legal = false;
            }

            b[idx] = EMPTY;

            if (legal) {
                moves.push({r: row, c: col});
            }
        }
    }

    moves.push({r: MCTS_PASS_ROW, c: MCTS_PASS_COL});

    for (var i = moves.length - 1; i > 0; i--) {
        var j = Math.floor((mctsRng() / 65536) % (i + 1));
        var tmp = moves[i];
        moves[i] = moves[j];
        moves[j] = tmp;
    }

    return moves;
}

function simTryPlace(b, koB, koActiveFlag, player, row, col) {
    if (row === MCTS_PASS_ROW && col === MCTS_PASS_COL)
        return {success: true, koActive: koActiveFlag};

    var idx = boardIndex(row, col);
    if (idx < 0 || b[idx] !== EMPTY)
        return {success: false, koActive: koActiveFlag};

    var opponent = (player === BLACK) ? WHITE : BLACK;

    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
        simTempBoard[i] = b[i];

    b[idx] = player;

    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];
    var anyCaptured = false;

    for (var d = 0; d < 4; d++) {
        var nr = row + dr[d];
        var nc = col + dc[d];
        var nidx = boardIndex(nr, nc);
        if (nidx < 0)
            continue;
        if (b[nidx] === opponent &&
            countLibertiesOn(b, nr, nc, opponent) === 0) {
            removeGroupOn(b, nr, nc, opponent);
            anyCaptured = true;
        }
    }

    if (countLibertiesOn(b, row, col, player) === 0) {
        for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
            b[i] = simTempBoard[i];
        return {success: false, koActive: koActiveFlag};
    }

    if (koActiveFlag) {
        var equal = true;
        for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
            if (b[i] !== koB[i]) {
                equal = false;
                break;
            }
        }
        if (equal) {
            for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
                b[i] = simTempBoard[i];
            return {success: false, koActive: koActiveFlag};
        }
    }

    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
        koB[i] = simTempBoard[i];
    koActiveFlag = anyCaptured;

    return {success: true, koActive: koActiveFlag};
}

function scoreBoard(b) {
    var visited = [];
    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
        visited[i] = false;

    var bTerritory = 0, wTerritory = 0;
    var bStones = 0, wStones = 0;

    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (b[i] === BLACK) bStones++;
        else if (b[i] === WHITE) wStones++;
    }

    var dr = [-1, 1, 0, 0];
    var dc = [0, 0, -1, 1];

    for (var sr = 0; sr < BOARD_SIZE; sr++) {
        for (var sc = 0; sc < BOARD_SIZE; sc++) {
            var sidx = boardIndex(sr, sc);
            if (b[sidx] !== EMPTY || visited[sidx])
                continue;

            var queue = [{r: sr, c: sc}];
            var head = 0;
            visited[sidx] = true;

            var regionSize = 0;
            var touchesBlack = false;
            var touchesWhite = false;

            while (head < queue.length) {
                var cell = queue[head];
                head++;
                regionSize++;

                for (var d = 0; d < 4; d++) {
                    var nr = cell.r + dr[d], nc = cell.c + dc[d];
                    var nidx = boardIndex(nr, nc);
                    if (nidx < 0)
                        continue;
                    var ns = b[nidx];
                    if (ns === BLACK) {
                        touchesBlack = true;
                    } else if (ns === WHITE) {
                        touchesWhite = true;
                    } else if (!visited[nidx]) {
                        visited[nidx] = true;
                        queue.push({r: nr, c: nc});
                    }
                }
            }

            if (touchesBlack && !touchesWhite) {
                bTerritory += regionSize;
            } else if (touchesWhite && !touchesBlack) {
                wTerritory += regionSize;
            }
        }
    }

    var blackTotal = bStones + bTerritory;
    var whiteTotal = wStones + wTerritory + 7;
    return blackTotal - whiteTotal;
}

function mctsPlayout(initialPlayer) {
    copyBoard(playBoard, simBoard);
    copyBoard(playKoBoard, simKoBoard);
    playKoActive = simKoActive;
    playPlayer = initialPlayer;
    playLastRow = simLastRow;
    playLastCol = simLastCol;
    playPasses = 0;

    var playoutMoves = 0;

    while (playoutMoves < MCTS_MAX_PLAYOUT) {
        var moves = getLegalMovesOn(playBoard, playKoBoard, playKoActive, playPlayer);
        if (moves.length === 0)
            break;

        var moveIdx = -1;
        var opp = (playPlayer === BLACK) ? WHITE : BLACK;

        if (moveIdx < 0) {
            for (var r = 0; r < BOARD_SIZE && moveIdx < 0; r++) {
                for (var c = 0; c < BOARD_SIZE && moveIdx < 0; c++) {
                    var idx = boardIndex(r, c);
                    if (playBoard[idx] === playPlayer &&
                        countLibertiesOn(playBoard, r, c, playPlayer) === 1) {
                        var lib = findLiberty(playBoard, r, c);
                        if (lib.r >= 0) {
                            for (var m = 0; m < moves.length; m++) {
                                if (moves[m].r === lib.r && moves[m].c === lib.c) {
                                    moveIdx = m;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        if (moveIdx < 0) {
            for (var r = 0; r < BOARD_SIZE && moveIdx < 0; r++) {
                for (var c = 0; c < BOARD_SIZE && moveIdx < 0; c++) {
                    var idx = boardIndex(r, c);
                    if (playBoard[idx] === opp &&
                        countLibertiesOn(playBoard, r, c, opp) === 1) {
                        var lib = findLiberty(playBoard, r, c);
                        if (lib.r >= 0) {
                            for (var m = 0; m < moves.length; m++) {
                                if (moves[m].r === lib.r && moves[m].c === lib.c) {
                                    moveIdx = m;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        if (moveIdx < 0) {
            var bestFallbackScore = -999;
            for (var i = 0; i < moves.length; i++) {
                var score = mctsRng() % 10;
                if (moves[i].r !== MCTS_PASS_ROW) {
                    var dist = Math.abs(moves[i].r - playLastRow) +
                               Math.abs(moves[i].c - playLastCol);
                    if (dist <= 2)
                        score += 20;
                    else if (dist <= 4)
                        score += 10;
                    if ((moves[i].r === 0 || moves[i].r === 8 ||
                         moves[i].c === 0 || moves[i].c === 8) && dist > 2) {
                        score -= 15;
                    }
                }
                if (score > bestFallbackScore) {
                    bestFallbackScore = score;
                    moveIdx = i;
                }
            }
        }

        if (moveIdx < 0)
            moveIdx = Math.floor((mctsRng() / 65536) % moves.length);

        var move = moves[moveIdx];

        if (move.r === MCTS_PASS_ROW && move.c === MCTS_PASS_COL) {
            playPasses++;
            if (playPasses >= 2)
                break;
        } else {
            playPasses = 0;
            var result = simTryPlace(playBoard, playKoBoard, playKoActive, playPlayer, move.r, move.c);
            playKoActive = result.koActive;
            playLastRow = move.r;
            playLastCol = move.c;
        }

        playPlayer = (playPlayer === BLACK) ? WHITE : BLACK;
        playoutMoves++;
    }

    var score = scoreBoard(playBoard);
    return (score > 0) ? 1 : 0;
}

function mctsRun(iterations, currentPlayer, lastRow, lastCol, consecutivePasses) {
    initPools();

    rootNode = allocNode(MCTS_PASS_ROW, MCTS_PASS_COL, EMPTY);

    var startTime = Date.now();
    var iter = 0;
    for (iter = 0; iter < iterations; iter++) {
        // Time-boxed: stop early so the reply beats the watch-side timeout.
        // Date.now() is checked every 16 iterations to keep overhead low.
        if ((iter & 15) === 0 && iter > 0 && (Date.now() - startTime) > MCTS_TIME_BUDGET_MS) {
            console.log('pkjs: time budget exceeded at iter ' + iter + '/' + iterations);
            break;
        }
        if (iter % 500 === 0)
            console.log('pkjs: MCTS iter ' + iter + '/' + iterations + ' pool=' + nodePoolUsed);
        mctsPathLen = 0;
        var nodeIdx = rootNode;

        copyBoard(simBoard, gBoard);
        copyBoard(simKoBoard, gKoBoard);
        simKoActive = gKoActive;
        simPlayer = currentPlayer;
        simLastRow = lastRow;
        simLastCol = lastCol;
        simPasses = consecutivePasses;

        mctsPath[mctsPathLen] = nodeIdx;
        mctsPathLen++;

        while (mctsPathLen < 200 && nodeIdx < MCTS_POOL_SIZE) {
            var n = nodePool[nodeIdx];
            var child = n.firstChild;
            if (child === MCTS_NO_NODE)
                break;

            var bestChild = MCTS_NO_NODE;
            var bestUct = -999999;

            while (child !== MCTS_NO_NODE && child < MCTS_POOL_SIZE) {
                var uctVal = uct(child, n.visits);
                if (uctVal > bestUct) {
                    bestUct = uctVal;
                    bestChild = child;
                }
                child = nodePool[child].nextSibling;
            }

            if (bestChild === MCTS_NO_NODE)
                break;

            var bc = nodePool[bestChild];
            if (bc.moveRow === MCTS_PASS_ROW) {
                simPasses++;
            } else {
                simPasses = 0;
                var result = simTryPlace(simBoard, simKoBoard, simKoActive,
                                         simPlayer, bc.moveRow, bc.moveCol);
                simKoActive = result.koActive;
                simLastRow = bc.moveRow;
                simLastCol = bc.moveCol;
            }
            simPlayer = (simPlayer === BLACK) ? WHITE : BLACK;

            mctsPath[mctsPathLen] = bestChild;
            mctsPathLen++;
            nodeIdx = bestChild;
        }

        var leaf = nodePool[nodeIdx];
        var moves = getLegalMovesOn(simBoard, simKoBoard, simKoActive, simPlayer);

        var unexpandedIdx = -1;
        var atariCaptureIdx = -1;
        var atariEscapeIdx = -1;

        for (var m = 0; m < moves.length; m++) {
            var found = false;
            var child = leaf.firstChild;
            while (child !== MCTS_NO_NODE && child < MCTS_POOL_SIZE) {
                var c = nodePool[child];
                if (c.moveRow === moves[m].r && c.moveCol === moves[m].c) {
                    found = true;
                    break;
                }
                child = c.nextSibling;
            }
            if (!found) {
                if (atariCaptureIdx < 0 &&
                    moves[m].r !== MCTS_PASS_ROW &&
                    wouldCaptureAtari(simBoard, moves[m].r, moves[m].c, simPlayer)) {
                    atariCaptureIdx = m;
                } else if (atariEscapeIdx < 0 &&
                           moves[m].r !== MCTS_PASS_ROW &&
                           wouldEscapeAtari(simBoard, moves[m].r, moves[m].c, simPlayer)) {
                    atariEscapeIdx = m;
                }
                if (unexpandedIdx < 0) {
                    unexpandedIdx = m;
                }
            }
        }

        if (atariCaptureIdx >= 0) {
            unexpandedIdx = atariCaptureIdx;
        } else if (atariEscapeIdx >= 0) {
            unexpandedIdx = atariEscapeIdx;
        }

        if (unexpandedIdx >= 0) {
            var newChild = allocNode(moves[unexpandedIdx].r, moves[unexpandedIdx].c, simPlayer);
            if (newChild !== MCTS_NO_NODE) {
                if (leaf.firstChild === MCTS_NO_NODE) {
                    leaf.firstChild = newChild;
                } else {
                    var sib = leaf.firstChild;
                    while (nodePool[sib].nextSibling !== MCTS_NO_NODE) {
                        sib = nodePool[sib].nextSibling;
                    }
                    nodePool[sib].nextSibling = newChild;
                }

                if (moves[unexpandedIdx].r === MCTS_PASS_ROW) {
                    simPasses++;
                } else {
                    simPasses = 0;
                    var result = simTryPlace(simBoard, simKoBoard, simKoActive,
                                             simPlayer, moves[unexpandedIdx].r,
                                             moves[unexpandedIdx].c);
                    simKoActive = result.koActive;
                    simLastRow = moves[unexpandedIdx].r;
                    simLastCol = moves[unexpandedIdx].c;
                }
                simPlayer = (simPlayer === BLACK) ? WHITE : BLACK;

                if (mctsPathLen < 199) {
                    mctsPath[mctsPathLen] = newChild;
                    mctsPathLen++;
                    nodeIdx = newChild;
                }
            }
        }

        var resultVal = mctsPlayout(simPlayer);

        for (var i = mctsPathLen - 1; i >= 0; i--) {
            var n = nodePool[mctsPath[i]];
            n.visits++;
            if (n.player === BLACK && resultVal === 1) {
                n.wins++;
            } else if (n.player === WHITE && resultVal === 0) {
                n.wins++;
            }
        }
    }
}

function mctsGetBestMove() {
    var root = nodePool[rootNode];
    var bestChild = MCTS_NO_NODE;
    var bestVisits = 0;

    var child = root.firstChild;
    while (child !== MCTS_NO_NODE && child < MCTS_POOL_SIZE) {
        var c = nodePool[child];
        if (c.visits > bestVisits) {
            bestVisits = c.visits;
            bestChild = child;
        }
        child = c.nextSibling;
    }
    return bestChild;
}


// Send a move reply back to the watch. This is the ONLY way the watch
// leaves AI_THINKING (besides its own timeout), so every code path below
// must end here — never throw without replying, or the game appears hung
// with dead buttons until the watch-side timeout fires.
function sendMoveReply(moveRow, moveCol, isPass) {
    console.log('pkjs: sending result back to watch...');
    try {
        Pebble.sendAppMessage({
            0: 1,
            1: moveRow,
            2: moveCol,
            3: isPass
        }, function() {
            console.log('pkjs: result sent OK');
        }, function() {
            console.log('pkjs: result send FAILED');
        });
    } catch (e) {
        console.log('pkjs: sendAppMessage threw: ' + (e && e.message));
    }
}

// Copy a byte-array payload (Uint8Array, ArrayBuffer, or plain Array) into
// a plain JS array of length `len`. Returns false when the payload is
// missing, short, or non-numeric — caller then replies pass instead of
// running MCTS on garbage.
function copyBytesFromPayload(data, len, dst) {
    var src = data;
    if (src instanceof ArrayBuffer) {
        src = new Uint8Array(src);
    }
    if (!src || typeof src.length !== 'number' || src.length < len) {
        return false;
    }
    for (var i = 0; i < len; i++) {
        var v = src[i];
        if (typeof v !== 'number' || !(v >= 0 && v <= 255)) {
            return false;
        }
        dst[i] = v | 0;
    }
    return true;
}

Pebble.addEventListener('ready', function() {
    console.log('pkjs: ready');
    for (var i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        gBoard[i] = 0;
        gKoBoard[i] = 0;
    }
    gKoActive = false;
});

// ---- Pebble app message handler ----

Pebble.addEventListener('appmessage', function(e) {
    try {
        handleAiRequest(e && e.payload);
    } catch (err) {
        // Last-resort guarantee: any unexpected throw still unblocks the
        // watch (it treats the pass as a normal pass, local ko/suicide rules
        // still apply on its side).
        console.log('pkjs: handler threw, replying pass: ' + (err && err.message));
        sendMoveReply(0, 0, 1);
    }
});

function handleAiRequest(payload) {
    var type = payload ? payload[0] : undefined;
    console.log('pkjs: appmessage received, type=' + type);
    if (type !== 0) {
        console.log('pkjs: ignoring type=' + type);
        return;
    }

    console.log('pkjs: parsing board data...');
    if (!copyBytesFromPayload(payload[5], 81, gBoard)) {
        console.log('pkjs: invalid board payload, replying pass');
        sendMoveReply(0, 0, 1);
        return;
    }

    var koRaw = payload[6];
    var koSrc = (koRaw instanceof ArrayBuffer) ? new Uint8Array(koRaw) : koRaw;
    if (!copyBytesFromPayload(koSrc, 81, gKoBoard)) {
        console.log('pkjs: invalid ko payload, replying pass');
        sendMoveReply(0, 0, 1);
        return;
    }
    gKoActive = (koSrc[81] | 0) !== 0;

    var currentPlayer = payload[1] | 0;
    var lastRow = payload[2] | 0;
    var lastCol = payload[3] | 0;
    var consecutivePasses = payload[4] | 0;
    if (currentPlayer !== BLACK && currentPlayer !== WHITE) {
        console.log('pkjs: invalid player=' + payload[1] + ', replying pass');
        sendMoveReply(0, 0, 1);
        return;
    }
    console.log('pkjs: player=' + currentPlayer + ' last=(' + lastRow + ',' + lastCol + ') passes=' + consecutivePasses);

    console.log('pkjs: running MCTS with up to ' + MCTS_ITERATIONS + ' iterations...');
    var startTime = Date.now();
    mctsRun(MCTS_ITERATIONS, currentPlayer, lastRow, lastCol, consecutivePasses);
    var elapsed = Date.now() - startTime;
    console.log('pkjs: MCTS finished in ' + elapsed + 'ms');

    var best = mctsGetBestMove();
    console.log('pkjs: best node index=' + best);

    var moveRow, moveCol, isPass;
    if (best === MCTS_NO_NODE) {
        console.log('pkjs: no best move, passing');
        isPass = 1;
        moveRow = 0;
        moveCol = 0;
    } else {
        var node = nodePool[best];
        moveRow = node.moveRow;
        moveCol = node.moveCol;
        isPass = (moveRow === MCTS_PASS_ROW && moveCol === MCTS_PASS_COL) ? 1 : 0;
        console.log('pkjs: best move=(' + moveRow + ',' + moveCol + ') visits=' + node.visits + ' wins=' + node.wins + ' pass=' + isPass);
    }

    sendMoveReply(moveRow, moveCol, isPass);
}
