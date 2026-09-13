#include "life.h"
#include <string.h>

// Only small enclosed regions count as evidence of death: a group next to a
// large open region can always fight or escape, so it must never be removed
// by static analysis. 8 points still covers all realistic eyespace on 9x9.
#define DEAD_REGION_MAX 8
// Removal is iterated because each removal can enclose (or expose) more.
#define DEAD_ROUNDS_MAX 10

static int16_t s_block[BOARD_SIZE * BOARD_SIZE];
static int16_t s_region[BOARD_SIZE * BOARD_SIZE];
static uint8_t s_nblocks;
static uint8_t s_nregions;
static uint8_t s_block_color[BOARD_SIZE * BOARD_SIZE];

static void bfs_label(uint8_t *b, int sr, int sc, int16_t *labels, int16_t id,
                      bool empty_target) {
    int16_t stack_r[BOARD_SIZE * BOARD_SIZE];
    int16_t stack_c[BOARD_SIZE * BOARD_SIZE];
    int top = 0;
    stack_r[top] = (int16_t)sr;
    stack_c[top] = (int16_t)sc;
    top++;
    labels[board_index(sr, sc)] = id;

    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};
    while (top > 0) {
        top--;
        int r = stack_r[top];
        int c = stack_c[top];
        for (int d = 0; d < 4; d++) {
            int nr = r + dr[d];
            int nc = c + dc[d];
            int nidx = board_index(nr, nc);
            if (nidx < 0 || labels[nidx] >= 0)
                continue;
            bool is_empty = (b[nidx] == EMPTY);
            if (is_empty != empty_target)
                continue;
            if (!empty_target && b[nidx] != b[board_index(sr, sc)])
                continue;
            labels[nidx] = id;
            stack_r[top] = (int16_t)nr;
            stack_c[top] = (int16_t)nc;
            top++;
        }
    }
}

static void label_all(uint8_t *b) {
    for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        s_block[i] = -1;
        s_region[i] = -1;
    }
    s_nblocks = 0;
    s_nregions = 0;
    for (int r = 0; r < BOARD_SIZE; r++) {
        for (int c = 0; c < BOARD_SIZE; c++) {
            int idx = board_index(r, c);
            if (b[idx] != EMPTY) {
                if (s_block[idx] < 0) {
                    bfs_label(b, r, c, s_block, (int16_t)s_nblocks, false);
                    s_block_color[s_nblocks] = b[idx];
                    s_nblocks++;
                }
            } else if (s_region[idx] < 0) {
                bfs_label(b, r, c, s_region, (int16_t)s_nregions, true);
                s_nregions++;
            }
        }
    }
}

// True if every stone touching region r has the given color (and at least
// one stone touches it).
static bool region_enclosed_by(uint8_t *b, int r, uint8_t color) {
    bool found = false;
    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};
    for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (s_region[i] != r)
            continue;
        int row = i / BOARD_SIZE, col = i % BOARD_SIZE;
        for (int d = 0; d < 4; d++) {
            int nidx = board_index(row + dr[d], col + dc[d]);
            if (nidx < 0 || b[nidx] == EMPTY)
                continue;
            if (b[nidx] != color)
                return false;
            found = true;
        }
    }
    return found;
}

// True if every stone touching region r belongs to a block still in X.
static bool region_supported(uint8_t *b, int r, const bool *X) {
    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};
    for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (s_region[i] != r)
            continue;
        int row = i / BOARD_SIZE, col = i % BOARD_SIZE;
        for (int d = 0; d < 4; d++) {
            int nidx = board_index(row + dr[d], col + dc[d]);
            if (nidx < 0 || b[nidx] == EMPTY)
                continue;
            if (!X[s_block[nidx]])
                return false;
        }
    }
    return true;
}

// True if every empty point of region r is a liberty of block blk.
static bool region_vital_for(uint8_t *b, int r, int blk) {
    (void)b;
    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};
    for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (s_region[i] != r)
            continue;
        int row = i / BOARD_SIZE, col = i % BOARD_SIZE;
        bool touches = false;
        for (int d = 0; d < 4; d++) {
            int nidx = board_index(row + dr[d], col + dc[d]);
            if (nidx >= 0 && s_block[nidx] == blk) {
                touches = true;
                break;
            }
        }
        if (!touches)
            return false;
    }
    return true;
}

static void benson_for_color(uint8_t *b, uint8_t color, bool *alive_out) {
    bool X[BOARD_SIZE * BOARD_SIZE];
    bool R[BOARD_SIZE * BOARD_SIZE];
    for (int i = 0; i < s_nblocks; i++)
        X[i] = (s_block_color[i] == color);
    for (int i = 0; i < s_nregions; i++)
        R[i] = region_enclosed_by(b, i, color);

    bool changed = true;
    while (changed) {
        changed = false;
        for (int blk = 0; blk < s_nblocks; blk++) {
            if (!X[blk])
                continue;
            int vital = 0;
            for (int r = 0; r < s_nregions; r++) {
                if (R[r] && region_vital_for(b, r, blk)) {
                    vital++;
                    if (vital >= 2)
                        break;
                }
            }
            if (vital < 2) {
                X[blk] = false;
                changed = true;
            }
        }
        for (int r = 0; r < s_nregions; r++) {
            if (R[r] && !region_supported(b, r, X)) {
                R[r] = false;
                changed = true;
            }
        }
    }

    for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (s_block[i] >= 0 && X[s_block[i]])
            alive_out[i] = true;
    }
}

void find_unconditionally_alive(uint8_t *b, bool *alive_out) {
    memset(alive_out, 0, BOARD_SIZE * BOARD_SIZE * sizeof(bool));
    label_all(b);
    benson_for_color(b, BLACK, alive_out);
    benson_for_color(b, WHITE, alive_out);
}

static int region_size(int r) {
    int n = 0;
    for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (s_region[i] == r)
            n++;
    }
    return n;
}

// A non-alive block is dead only if confined: every adjacent region is small
// and every stone around it (other than itself) is the opponent's. Shared
// regions (seki), open space and big groups always fail this test, so they
// are kept.
static bool block_confined_dead(uint8_t *b, int blk, uint8_t opp) {
    bool seen[BOARD_SIZE * BOARD_SIZE];
    memset(seen, 0, sizeof(seen));
    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};
    for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (s_block[i] != blk)
            continue;
        int row = i / BOARD_SIZE, col = i % BOARD_SIZE;
        for (int d = 0; d < 4; d++) {
            int nidx = board_index(row + dr[d], col + dc[d]);
            if (nidx < 0 || b[nidx] != EMPTY)
                continue;
            int r = s_region[nidx];
            if (seen[r])
                continue;
            seen[r] = true;
            if (region_size(r) > DEAD_REGION_MAX)
                return false;
            bool opp_found = false;
            for (int j = 0; j < BOARD_SIZE * BOARD_SIZE; j++) {
                if (s_region[j] != r)
                    continue;
                int jr = j / BOARD_SIZE, jc = j % BOARD_SIZE;
                for (int e = 0; e < 4; e++) {
                    int kidx = board_index(jr + dr[e], jc + dc[e]);
                    if (kidx < 0 || b[kidx] == EMPTY)
                        continue;
                    if (s_block[kidx] == blk)
                        continue;
                    if (b[kidx] != opp)
                        return false;
                    opp_found = true;
                }
            }
            if (!opp_found)
                return false;
        }
    }
    return true;
}

int remove_dead_stones(uint8_t *b) {
    uint8_t w[BOARD_SIZE * BOARD_SIZE];
    memcpy(w, b, sizeof(w));
    bool alive[BOARD_SIZE * BOARD_SIZE];
    int total = 0;

    for (int round = 0; round < DEAD_ROUNDS_MAX; round++) {
        find_unconditionally_alive(w, alive);
        // Two-phase: decide all kills on consistent labeling, then remove.
        bool kill[BOARD_SIZE * BOARD_SIZE];
        memset(kill, 0, sizeof(kill));
        int nkill = 0;
        for (int blk = 0; blk < s_nblocks; blk++) {
            bool is_alive = false;
            for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
                if (s_block[i] == blk && alive[i]) {
                    is_alive = true;
                    break;
                }
            }
            if (is_alive)
                continue;
            uint8_t opp = (s_block_color[blk] == BLACK) ? WHITE : BLACK;
            if (block_confined_dead(w, blk, opp)) {
                kill[blk] = true;
                nkill++;
            }
        }
        if (nkill == 0)
            break;
        for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
            if (s_block[i] >= 0 && kill[s_block[i]]) {
                w[i] = EMPTY;
                total++;
            }
        }
    }

    memcpy(b, w, sizeof(w));
    return total;
}

int score_board_smart_10x(uint8_t *b) {
    uint8_t w[BOARD_SIZE * BOARD_SIZE];
    memcpy(w, b, sizeof(w));
    remove_dead_stones(w);
    int bs = 0, bt = 0, ws = 0, wt = 0;
    board_area_parts(w, &bs, &bt, &ws, &wt);
    return (bs + bt) * 10 - ((ws + wt) * 10 + 75);
}
