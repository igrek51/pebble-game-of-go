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

void test_mcts_init() {
    printf("  Testing MCTS init...\n");
    mcts_init_zobrist();
    // No crash means success for now
}

void test_mcts_basic_move() {
    printf("  Testing MCTS basic move...\n");
    init_board_logic();
    
    // Run MCTS on empty board
    mcts_run(20, BLACK, 4, 4, 0);
    uint16_t best = mcts_get_best_move();
    ASSERT(best != MCTS_NO_NODE);
    
    int r, c;
    mcts_get_move_coords(best, &r, &c);
    ASSERT(r >= 0 && r < 9);
    ASSERT(c >= 0 && c < 9);
}

void test_hint_logic() {
    printf("  Testing hint logic...\n");
    init_board_logic();
    set_stone(4, 4, BLACK);
    
    int r, c;
    suggest_hint_logic(WHITE, 4, 4, &r, &c);
    ASSERT(r != -1 && c != -1);
    ASSERT(get_stone(r, c) == EMPTY);
}

int main() {
    printf("Running AI logic tests...\n");
    test_mcts_init();
    test_mcts_basic_move();
    test_hint_logic();
    printf("All AI logic tests passed!\n");
    return 0;
}
