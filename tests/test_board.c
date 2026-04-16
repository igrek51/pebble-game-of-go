#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "logic/board.h"
#include "game_state.h"

#define ASSERT(cond) do { \
    if (!(cond)) { \
        printf("Assertion failed: %s at %s:%d\n", #cond, __FILE__, __LINE__); \
        exit(1); \
    } \
} while(0)

void test_liberties() {
    printf("  Testing liberties...\n");
    init_board_logic();
    set_stone(4, 4, BLACK);
    ASSERT(count_liberties(4, 4, BLACK) == 4);
    
    set_stone(4, 5, BLACK);
    ASSERT(count_liberties(4, 4, BLACK) == 6);
    
    set_stone(0, 0, WHITE);
    ASSERT(count_liberties(0, 0, WHITE) == 2);
}

void test_capture() {
    printf("  Testing capture...\n");
    init_board_logic();
    set_stone(4, 4, BLACK);
    set_stone(3, 4, WHITE);
    set_stone(5, 4, WHITE);
    set_stone(4, 3, WHITE);
    set_stone(4, 5, WHITE);
    
    ASSERT(count_liberties(4, 4, BLACK) == 0);
    remove_group(4, 4, BLACK);
    ASSERT(get_stone(4, 4) == EMPTY);
}

int main() {
    printf("Running board logic tests...\n");
    test_liberties();
    test_capture();
    printf("All board logic tests passed!\n");
    return 0;
}
