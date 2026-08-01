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

void test_fallback_after_moves() {
    printf("  Testing MCTS fallback after several moves...\n");
    init_board_logic();
    mcts_init_zobrist();

    set_stone(4, 4, BLACK);
    set_stone(3, 3, WHITE);
    set_stone(2, 2, BLACK);
    set_stone(5, 5, WHITE);
    current_player = BLACK;
    consecutive_passes = 0;

    mcts_run(20, BLACK, 5, 5, 0);
    uint16_t best = mcts_get_best_move();
    ASSERT(best != MCTS_NO_NODE);
    int r, c;
    mcts_get_move_coords(best, &r, &c);
    ASSERT(r >= 0 && r < 9 && c >= 0 && c < 9);
    ASSERT(get_stone(r, c) == EMPTY);
    printf("    Move: (%d, %d) - OK\n", r, c);
}

void test_fallback_can_find_pass() {
    printf("  Testing MCTS fallback finds pass when appropriate...\n");
    init_board_logic();
    mcts_init_zobrist();

    for (int r = 0; r < 9; r++)
        for (int c = 0; c < 9; c++)
            set_stone(r, c, BLACK);

    current_player = WHITE;
    mcts_run(20, WHITE, 4, 4, 0);
    uint16_t best = mcts_get_best_move();
    ASSERT(best != MCTS_NO_NODE);
    int r, c;
    mcts_get_move_coords(best, &r, &c);
    ASSERT(r == MCTS_PASS_ROW && c == MCTS_PASS_COL);
    printf("    No legal moves, correctly passes\n");
}

void test_fallback_legal_move_exists() {
    printf("  Testing MCTS finds a legal move when one exists...\n");
    init_board_logic();
    mcts_init_zobrist();

    set_stone(0, 0, BLACK);
    set_stone(0, 1, WHITE);

    mcts_run(20, BLACK, 0, 1, 0);
    uint16_t best = mcts_get_best_move();
    ASSERT(best != MCTS_NO_NODE);
    int r, c;
    mcts_get_move_coords(best, &r, &c);
    ASSERT(r >= 0 && r < 9 && c >= 0 && c < 9);
    ASSERT(get_stone(r, c) == EMPTY);
    printf("    Legal move found: (%d, %d)\n", r, c);
}

void test_fallback_consecutive_moves() {
    printf("  Testing MCTS fallback for consecutive AI moves...\n");
    mcts_init_zobrist();

    for (int move = 0; move < 10; move++) {
        init_board_logic();
        for (int i = 0; i < move; i++) {
            mcts_run(20, (i % 2 == 0) ? BLACK : WHITE, 4, 4, 0);
            uint16_t best = mcts_get_best_move();
            ASSERT(best != MCTS_NO_NODE);
            int r, c;
            mcts_get_move_coords(best, &r, &c);
            if (r == MCTS_PASS_ROW && c == MCTS_PASS_COL)
                continue;
            ASSERT(get_stone(r, c) == EMPTY);
            set_stone(r, c, (i % 2 == 0) ? BLACK : WHITE);
        }
    }
    printf("    10 consecutive AI moves without error\n");
}

int main() {
    printf("Running fallback logic tests...\n");
    test_fallback_after_moves();
    test_fallback_can_find_pass();
    test_fallback_legal_move_exists();
    test_fallback_consecutive_moves();
    printf("All fallback logic tests passed!\n");
    return 0;
}
