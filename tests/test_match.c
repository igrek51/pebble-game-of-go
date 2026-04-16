#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ai/mcts.h"
#include "logic/board.h"
#include "game_state.h"

#define ASSERT(cond) do { \
    if (!(cond)) { \
        printf("Assertion failed: %s at %s:%d\n", #cond, __FILE__, __LINE__); \
        exit(1); \
    } \
} while(0)

// Minimal logic for placing stone during simulation (no UI)
bool simulate_place_stone(int row, int col) {
    int idx = board_index(row, col);
    if (idx < 0 || board[idx] != EMPTY) return false;

    uint8_t opponent = (current_player == BLACK) ? WHITE : BLACK;
    uint8_t temp_board[BOARD_SIZE * BOARD_SIZE];
    memcpy(temp_board, board, sizeof(board));

    board[idx] = current_player;

    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};
    bool any_captured = false;
    for (int d = 0; d < 4; d++) {
        int nr = row + dr[d], nc = col + dc[d];
        int nidx = board_index(nr, nc);
        if (nidx >= 0 && board[nidx] == opponent) {
            if (count_liberties(nr, nc, opponent) == 0) {
                remove_group(nr, nc, opponent);
                any_captured = true;
            }
        }
    }

    if (count_liberties(row, col, current_player) == 0) {
        memcpy(board, temp_board, sizeof(board));
        return false;
    }

    if (ko_active && memcmp(board, ko_board, sizeof(board)) == 0) {
        memcpy(board, temp_board, sizeof(board));
        return false;
    }

    memcpy(ko_board, temp_board, sizeof(board));
    ko_active = any_captured;
    consecutive_passes = 0;
    current_player = opponent;
    return true;
}

void test_full_match() {
    printf("  Starting full AI vs AI match simulation...\n");
    init_board_logic();
    mcts_init_zobrist();
    
    int turn_limit = 300; // Safety limit
    int turns = 0;
    int last_r = 4, last_c = 4;

    while (consecutive_passes < 2 && turns < turn_limit) {
        mcts_run(20, current_player, last_r, last_c, consecutive_passes);
        uint16_t best = mcts_get_best_move();
        
        if (best == MCTS_NO_NODE) {
            consecutive_passes++;
            current_player = (current_player == BLACK) ? WHITE : BLACK;
        } else {
            int r, c;
            mcts_get_move_coords(best, &r, &c);
            if (r == MCTS_PASS_ROW && c == MCTS_PASS_COL) {
                consecutive_passes++;
                current_player = (current_player == BLACK) ? WHITE : BLACK;
            } else {
                bool ok = simulate_place_stone(r, c);
                if (ok) {
                    last_r = r; last_c = c;
                } else {
                    // AI picked illegal move? Should not happen often with MCTS
                    // but we must handle it to prevent infinite loop
                    consecutive_passes++;
                    current_player = (current_player == BLACK) ? WHITE : BLACK;
                }
            }
        }
        turns++;
        if (turns % 20 == 0) printf("    Turn %d...\n", turns);
    }

    printf("  Match finished in %d turns.\n", turns);
    compute_chinese_score();
    printf("  Final Score: B:%d W:%d (Komi 7.5 included in UI usually)\n", black_score, white_score);
    
    ASSERT(turns > 10); // Basic sanity check
}

int main() {
    printf("Running Full Match Stability Test...\n");
    test_full_match();
    printf("Full match test passed!\n");
    return 0;
}
