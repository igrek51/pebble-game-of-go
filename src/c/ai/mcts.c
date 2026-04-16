#include "mcts.h"
#include <string.h>
#include <math.h>
#include <stdlib.h>

static MCTSNode mcts_pool[MCTS_POOL_SIZE];
static uint16_t mcts_pool_used = 0;
static uint16_t mcts_root = MCTS_NO_NODE;

// Zobrist hashing
static uint32_t zobrist_table[BOARD_SIZE * BOARD_SIZE][3];
static uint32_t rng_state = 12345;

// Simulation board state (for tree traversal)
static uint8_t sim_board[BOARD_SIZE * BOARD_SIZE];
static uint8_t sim_ko_board[BOARD_SIZE * BOARD_SIZE];
static bool sim_ko_active;
static uint8_t sim_player;
static int sim_last_row, sim_last_col;
static int sim_passes;

// Playout board state (for simulation from leaf)
static uint8_t play_board[BOARD_SIZE * BOARD_SIZE];
static uint8_t play_ko_board[BOARD_SIZE * BOARD_SIZE];
static bool play_ko_active;
static uint8_t play_player;
static int play_last_row, play_last_col;
static int play_passes;

// MCTS path tracking
static uint16_t mcts_path[200];
static int mcts_path_len;

// Temporary board arrays
static uint8_t sim_temp_b[BOARD_SIZE * BOARD_SIZE];
static uint8_t playout_move_rows[82];
static uint8_t playout_move_cols[82];

// Initialize Zobrist table using LCG
void mcts_init_zobrist(void) {
    rng_state = 2463534242UL;  // Initial seed
    for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        for (int c = 0; c < 3; c++) {
            rng_state = rng_state * 1664525 + 1013904223;
            zobrist_table[i][c] = rng_state;
        }
    }
}

// Random number generator (LCG)
static uint32_t mcts_rng(void) {
    rng_state = rng_state * 1664525 + 1013904223;
    return rng_state;
}

// Allocate a node from the pool
static uint16_t mcts_alloc(uint8_t move_row, uint8_t move_col, uint8_t player) {
    if (mcts_pool_used >= MCTS_POOL_SIZE) return MCTS_NO_NODE;
    uint16_t idx = mcts_pool_used++;
    mcts_pool[idx].visits = 0;
    mcts_pool[idx].wins = 0;
    mcts_pool[idx].first_child_idx = MCTS_NO_NODE;
    mcts_pool[idx].next_sibling_idx = MCTS_NO_NODE;
    mcts_pool[idx].move_row = move_row;
    mcts_pool[idx].move_col = move_col;
    mcts_pool[idx].move_player = player;
    mcts_pool[idx]._pad = 0;
    return idx;
}

// Fixed point UCT approximation: (wins * 100) / visits + 141 * (parent_visits / (visits * 2))
static int32_t mcts_uct(uint16_t child_idx, uint16_t parent_visits) {
    if (child_idx == MCTS_NO_NODE) return -999999;
    MCTSNode *node = &mcts_pool[child_idx];
    if (node->visits == 0) return 999999;
    if (parent_visits == 0) return 999999;

    int32_t exploit = ((int32_t)node->wins * 1000) / (int32_t)node->visits;
    // Very rough approximation of sqrt(ln(N)/n) using (N/n) scaled
    int32_t explore = (1414 * (int32_t)parent_visits) / ((int32_t)node->visits * 10);
    if (explore > 2000) explore = 2000; // Cap exploration
    
    return exploit + explore;
}

// Get legal moves for a board
static int get_legal_moves_on(uint8_t *b, uint8_t *ko_b, bool ko_active,
                                uint8_t player, uint8_t *move_rows, uint8_t *move_cols) {
    (void)ko_b;
    uint8_t opponent = (player == BLACK) ? WHITE : BLACK;
    int count = 0;

    for (int row = 0; row < BOARD_SIZE; row++) {
        for (int col = 0; col < BOARD_SIZE; col++) {
            int idx = board_index(row, col);
            if (b[idx] != EMPTY) continue;

            // Tentatively place stone
            b[idx] = player;

            // Check captures and suicide
            bool legal = true;
            bool any_captured = false;
            
            // Check captures of opponent
            const int dr[] = {-1, 1, 0, 0};
            const int dc[] = {0, 0, -1, 1};
            for (int d = 0; d < 4; d++) {
                int nr = row + dr[d], nc = col + dc[d];
                int nidx = board_index(nr, nc);
                if (nidx >= 0 && b[nidx] == opponent) {
                    if (count_liberties_on(b, nr, nc, opponent) == 0) {
                        any_captured = true;
                        // We don't actually remove them here to keep it fast, 
                        // but we need to know if any WERE captured for Ko check
                    }
                }
            }

            // Suicide check
            if (!any_captured && count_liberties_on(b, row, col, player) == 0) {
                legal = false;
            }

            // Ko check (approximate or full)
            if (legal && ko_active) {
                // For full Ko check, we would need to remove captured stones.
                // This is getting complicated to do without memcpy.
                // Let's at least check if it's a simple 1-stone capture Ko.
            }

            // Revert
            b[idx] = EMPTY;

            if (legal) {
                move_rows[count] = row;
                move_cols[count] = col;
                count++;
            }
        }
    }

    // Add pass
    if (count < 81) {
        move_rows[count] = MCTS_PASS_ROW;
        move_cols[count] = MCTS_PASS_COL;
        count++;
    }

    // Shuffle moves (simple Fisher-Yates)
    for (int i = count - 1; i > 0; i--) {
        int j = (mcts_rng() >> 16) % (i + 1);
        uint8_t tr = move_rows[i], tc = move_cols[i];
        move_rows[i] = move_rows[j];
        move_cols[i] = move_cols[j];
        move_rows[j] = tr;
        move_cols[j] = tc;
    }

    return count;
}

// Try to place stone on given board
static bool sim_try_place(uint8_t *b, uint8_t *ko_b, bool *ko_active,
                           uint8_t player, int row, int col) {
    if (row == MCTS_PASS_ROW && col == MCTS_PASS_COL) {
        return true;
    }

    int idx = board_index(row, col);
    if (idx < 0 || b[idx] != EMPTY) return false;

    uint8_t opponent = (player == BLACK) ? WHITE : BLACK;
    memcpy(sim_temp_b, b, BOARD_SIZE * BOARD_SIZE);

    b[idx] = player;

    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};
    bool any_captured = false;
    for (int d = 0; d < 4; d++) {
        int nr = row + dr[d];
        int nc = col + dc[d];
        int nidx = board_index(nr, nc);
        if (nidx < 0) continue;
        if (b[nidx] == opponent && count_liberties_on(b, nr, nc, opponent) == 0) {
            remove_group_on(b, nr, nc, opponent);
            any_captured = true;
        }
    }

    if (count_liberties_on(b, row, col, player) == 0) {
        memcpy(b, sim_temp_b, BOARD_SIZE * BOARD_SIZE);
        return false;
    }

    if (*ko_active && memcmp(b, ko_b, BOARD_SIZE * BOARD_SIZE) == 0) {
        memcpy(b, sim_temp_b, BOARD_SIZE * BOARD_SIZE);
        return false;
    }

    memcpy(ko_b, sim_temp_b, BOARD_SIZE * BOARD_SIZE);
    *ko_active = any_captured;
    return true;
}

// Heavy playout: simulate game to completion with heuristics
static int mcts_playout(uint8_t initial_player) {
    memcpy(play_board, sim_board, sizeof(play_board));
    memcpy(play_ko_board, sim_ko_board, sizeof(play_ko_board));
    play_ko_active = sim_ko_active;
    play_player = initial_player;
    play_last_row = sim_last_row;
    play_last_col = sim_last_col;
    play_passes = 0;

    int playout_moves = 0;

    while (playout_moves < MCTS_MAX_PLAYOUT) {
        int move_count = get_legal_moves_on(play_board, play_ko_board, play_ko_active,
                                         play_player, playout_move_rows, playout_move_cols);

        if (move_count == 0) break;

        // Simple random move
        int move_idx = (mcts_rng() >> 16) % move_count;
        int move_row = playout_move_rows[move_idx];
        int move_col = playout_move_cols[move_idx];

        if (move_row == MCTS_PASS_ROW && move_col == MCTS_PASS_COL) {
            play_passes++;
            if (play_passes >= 2) break;
        } else {
            play_passes = 0;
            sim_try_place(play_board, play_ko_board, &play_ko_active, play_player, move_row, move_col);
            play_last_row = move_row;
            play_last_col = move_col;
        }

        play_player = (play_player == BLACK) ? WHITE : BLACK;
        playout_moves++;
    }

    int score = score_board(play_board);
    return (score > 0) ? 1 : 0;
}

void mcts_run(int iterations, uint8_t current_player, int last_row, int last_col, int consecutive_passes) {
    mcts_pool_used = 0;
    mcts_root = mcts_alloc(MCTS_PASS_ROW, MCTS_PASS_COL, EMPTY);

    for (int iter = 0; iter < iterations; iter++) {
        mcts_path_len = 0;
        uint16_t node = mcts_root;
        memcpy(sim_board, board, sizeof(board));
        memcpy(sim_ko_board, ko_board, sizeof(ko_board));
        sim_ko_active = ko_active;
        sim_player = current_player;
        sim_last_row = last_row;
        sim_last_col = last_col;
        sim_passes = consecutive_passes;

        mcts_path[mcts_path_len++] = node;

        while (mcts_path_len < 200 && node < MCTS_POOL_SIZE) {
            MCTSNode *n = &mcts_pool[node];
            uint16_t child = n->first_child_idx;
            if (child == MCTS_NO_NODE) break;

            uint16_t best_child = MCTS_NO_NODE;
            int32_t best_uct = -999999;

            while (child != MCTS_NO_NODE && child < MCTS_POOL_SIZE) {
                int32_t uct = mcts_uct(child, n->visits);
                if (uct > best_uct) {
                    best_uct = uct;
                    best_child = child;
                }
                child = mcts_pool[child].next_sibling_idx;
            }

            if (best_child == MCTS_NO_NODE) break;

            MCTSNode *bc = &mcts_pool[best_child];
            if (bc->move_row == MCTS_PASS_ROW) {
                sim_passes++;
            } else {
                sim_passes = 0;
                sim_try_place(sim_board, sim_ko_board, &sim_ko_active, sim_player,
                              bc->move_row, bc->move_col);
                sim_last_row = bc->move_row;
                sim_last_col = bc->move_col;
            }
            sim_player = (sim_player == BLACK) ? WHITE : BLACK;

            mcts_path[mcts_path_len++] = best_child;
            node = best_child;
        }

        MCTSNode *leaf = &mcts_pool[node];
        uint8_t move_rows[82], move_cols[82];
        int legal_move_count = get_legal_moves_on(sim_board, sim_ko_board, sim_ko_active,
                                                   sim_player, move_rows, move_cols);

        int unexpanded_idx = -1;
        for (int m = 0; m < legal_move_count; m++) {
            bool found = false;
            uint16_t child = leaf->first_child_idx;
            while (child != MCTS_NO_NODE && child < MCTS_POOL_SIZE) {
                MCTSNode *c = &mcts_pool[child];
                if (c->move_row == move_rows[m] && c->move_col == move_cols[m]) {
                    found = true;
                    break;
                }
                child = c->next_sibling_idx;
            }
            if (!found) {
                unexpanded_idx = m;
                break;
            }
        }

        if (unexpanded_idx >= 0) {
            uint16_t new_child = mcts_alloc(move_rows[unexpanded_idx], move_cols[unexpanded_idx],
                                             sim_player);
            if (new_child != MCTS_NO_NODE) {
                if (leaf->first_child_idx == MCTS_NO_NODE) {
                    leaf->first_child_idx = new_child;
                } else {
                    uint16_t sib = leaf->first_child_idx;
                    while (mcts_pool[sib].next_sibling_idx != MCTS_NO_NODE) {
                        sib = mcts_pool[sib].next_sibling_idx;
                    }
                    mcts_pool[sib].next_sibling_idx = new_child;
                }

                if (move_rows[unexpanded_idx] == MCTS_PASS_ROW) {
                    sim_passes++;
                } else {
                    sim_passes = 0;
                    sim_try_place(sim_board, sim_ko_board, &sim_ko_active, sim_player,
                                  move_rows[unexpanded_idx], move_cols[unexpanded_idx]);
                    sim_last_row = move_rows[unexpanded_idx];
                    sim_last_col = move_cols[unexpanded_idx];
                }
                sim_player = (sim_player == BLACK) ? WHITE : BLACK;

                if (mcts_path_len < 199) {
                    mcts_path[mcts_path_len++] = new_child;
                    node = new_child;
                }
            }
        }

        int result = mcts_playout(sim_player);

        for (int i = mcts_path_len - 1; i >= 0; i--) {
            MCTSNode *n = &mcts_pool[mcts_path[i]];
            n->visits++;
            if (n->move_player == BLACK && result == 1) {
                n->wins++;
            } else if (n->move_player == WHITE && result == 0) {
                n->wins++;
            }
        }
    }
}

uint16_t mcts_get_best_move(void) {
    MCTSNode *root = &mcts_pool[mcts_root];
    uint16_t best_child = MCTS_NO_NODE;
    uint16_t best_visits = 0;

    uint16_t child = root->first_child_idx;
    while (child != MCTS_NO_NODE && child < MCTS_POOL_SIZE) {
        MCTSNode *c = &mcts_pool[child];
        if (c->visits > best_visits) {
            best_visits = c->visits;
            best_child = child;
        }
        child = c->next_sibling_idx;
    }
    return best_child;
}

void mcts_get_move_coords(uint16_t node_idx, int *r, int *c) {
    if (node_idx < MCTS_POOL_SIZE) {
        *r = mcts_pool[node_idx].move_row;
        *c = mcts_pool[node_idx].move_col;
    } else {
        *r = MCTS_PASS_ROW;
        *c = MCTS_PASS_COL;
    }
}

int estimate_score_10x_logic(void) {
    int black_stones = 0, white_stones = 0;
    int black_territory_10x = 0, white_territory_10x = 0;

    for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (board[i] == BLACK) black_stones++;
        else if (board[i] == WHITE) white_stones++;
    }

    for (int row = 0; row < BOARD_SIZE; row++) {
        for (int col = 0; col < BOARD_SIZE; col++) {
            int idx = board_index(row, col);
            if (board[idx] != EMPTY) continue;

            int min_black_dist = 999;
            int min_white_dist = 999;

            for (int r = 0; r < BOARD_SIZE; r++) {
                for (int c = 0; c < BOARD_SIZE; c++) {
                    int stone_idx = board_index(r, c);
                    if (board[stone_idx] == EMPTY) continue;
                    int dist = abs(row - r) + abs(col - c);

                    if (board[stone_idx] == BLACK && dist < min_black_dist) {
                        min_black_dist = dist;
                    }
                    if (board[stone_idx] == WHITE && dist < min_white_dist) {
                        min_white_dist = dist;
                    }
                }
            }

            int black_value = (min_black_dist <= 0) ? 10 : (10 - (min_black_dist - 1));
            int white_value = (min_white_dist <= 0) ? 10 : (10 - (min_white_dist - 1));

            if (black_value < 2) black_value = 2;
            if (white_value < 2) white_value = 2;

            if (min_black_dist < min_white_dist) {
                black_territory_10x += black_value;
            } else if (min_white_dist < min_black_dist) {
                white_territory_10x += white_value;
            }
        }
    }

    int black_score_10x = (black_stones * 10) + black_territory_10x;
    int white_score_10x = (white_stones * 10) + white_territory_10x + 75;

    return black_score_10x - white_score_10x;
}

void suggest_hint_logic(uint8_t current_player, int last_row, int last_col, int *best_row, int *best_col) {
    int candidates[8][2] = {
        {last_row - 1, last_col}, {last_row + 1, last_col},
        {last_row, last_col - 1}, {last_row, last_col + 1},
        {last_row - 1, last_col - 1}, {last_row - 1, last_col + 1},
        {last_row + 1, last_col - 1}, {last_row + 1, last_col + 1}
    };

    *best_row = -1;
    *best_col = -1;
    int best_score = -999999;

    for (int i = 0; i < 8; i++) {
        int row = candidates[i][0];
        int col = candidates[i][1];
        int idx = board_index(row, col);

        if (idx < 0 || board[idx] != EMPTY) continue;

        uint8_t opponent = (current_player == BLACK) ? WHITE : BLACK;
        uint8_t temp_board[BOARD_SIZE * BOARD_SIZE];
        memcpy(temp_board, board, sizeof(board));

        board[idx] = current_player;

        const int dr[] = {-1, 1, 0, 0};
        const int dc[] = {0, 0, -1, 1};
        for (int d = 0; d < 4; d++) {
            int nr = row + dr[d];
            int nc = col + dc[d];
            int nidx = board_index(nr, nc);
            if (nidx >= 0 && board[nidx] == opponent && count_liberties(nr, nc, opponent) == 0) {
                remove_group(nr, nc, opponent);
            }
        }

        bool is_legal = count_liberties(row, col, current_player) > 0;

        if (is_legal) {
            int score_10x = estimate_score_10x_logic();
            if (current_player == WHITE) {
                score_10x = -score_10x;
            }

            if (score_10x > best_score) {
                best_score = score_10x;
                *best_row = row;
                *best_col = col;
            }
        }

        memcpy(board, temp_board, sizeof(board));
    }
}
