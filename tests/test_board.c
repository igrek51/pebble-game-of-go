#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "logic/board.h"
#include "logic/life.h"
#include "game_state.h"

#define ASSERT(cond) do { \
    if (!(cond)) { \
        printf("Assertion failed: %s at %s:%d\n", #cond, __FILE__, __LINE__); \
        exit(1); \
    } \
} while(0)

// Load a 9-row diagram: '.' empty, 'X' black, 'O' white.
void load_diagram(const char *rows[9]) {
    init_board_logic();
    for (int r = 0; r < 9; r++)
        for (int c = 0; c < 9; c++)
            set_stone(r, c, rows[r][c] == 'X' ? BLACK :
                               rows[r][c] == 'O' ? WHITE : EMPTY);
}

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

void test_liberties(void);
void test_capture(void);
void test_benson_two_eyes_alive(void);
void test_dead_invasion_removed(void);
void test_contact_fight_kept(void);
void test_shared_region_kept(void);
void test_smart_score(void);
void test_score_preview(void);
void test_preview_open_board(void);
void test_influence_agrees_settled(void);
void test_influence_open_single(void);
void test_influence_walls_and_ties(void);
void test_influence_11_invariant(void);

int main() {    printf("Running board logic tests...\n");
    test_liberties();
    test_capture();
    test_benson_two_eyes_alive();
    test_dead_invasion_removed();
    test_contact_fight_kept();
    test_shared_region_kept();
    test_smart_score();
    test_score_preview();
    test_preview_open_board();
    test_influence_agrees_settled();
    test_influence_open_single();
    test_influence_walls_and_ties();
    test_influence_11_invariant();
    printf("All board logic tests passed!\n");
    return 0;
}

// Black wall with two separate one-point eyes -> unconditionally alive.
void test_benson_two_eyes_alive() {
    printf("  Testing Benson two-eye life...\n");
    const char *rows[9] = {
        "XXXXX....",
        "X.X.X....",
        "XXXXX....",
        "XXXXX....",
        ".........",
        ".........",
        ".........",
        ".........",
        "........O",
    };
    load_diagram(rows);
    bool alive[81];
    find_unconditionally_alive(board, alive);
    ASSERT(alive[board_index(0, 0)]);  // wall alive
    ASSERT(alive[board_index(1, 2)]);  // divider alive
    ASSERT(!alive[board_index(8, 8)]); // lone white stone, open board
    uint8_t copy[81];
    memcpy(copy, board, sizeof(copy));
    ASSERT(remove_dead_stones(copy) == 0); // nothing confined -> nothing removed
}

// White stone with no room inside a black ring -> dead and removed;
// interior becomes black territory.
void test_dead_invasion_removed() {
    printf("  Testing dead invasion removal...\n");
    init_board_logic();
    // 4x4 black ring, rows/cols 0..3
    for (int i = 0; i <= 3; i++) {
        set_stone(0, i, BLACK);
        set_stone(3, i, BLACK);
        set_stone(i, 0, BLACK);
        set_stone(i, 3, BLACK);
    }
    set_stone(1, 1, WHITE); // one eye only -> dead

    uint8_t copy[81];
    memcpy(copy, board, sizeof(copy));
    ASSERT(remove_dead_stones(copy) == 1);
    ASSERT(copy[board_index(1, 1)] == EMPTY);
    ASSERT(copy[board_index(0, 0)] == BLACK);
    // Smart score: 12 black stones + 4 interior + 65 exterior points,
    // white removed, komi 7.5. (Old code scored 690 here: it counted the
    // white stone and left the interior neutral.)
    ASSERT(score_board_smart_10x(board) == (12 + 4 + 65) * 10 - 75);
    compute_chinese_score();
    ASSERT(black_score == 12 + 4 + 65);
    ASSERT(white_score == 0);
}

// Opposing blocks in contact with a shared open region -> nobody removed.
void test_contact_fight_kept() {
    printf("  Testing contact fight kept...\n");
    const char *rows[9] = {
        ".XO......",
        ".XO......",
        ".........",
        ".........",
        ".........",
        ".........",
        ".........",
        ".........",
        ".........",
    };
    load_diagram(rows);
    uint8_t copy[81];
    memcpy(copy, board, sizeof(copy));
    ASSERT(remove_dead_stones(copy) == 0);
    ASSERT(copy[board_index(0, 1)] == BLACK);
    ASSERT(copy[board_index(0, 2)] == WHITE);
}

// Opposing stones around a shared two-color region (the seki-critical
// case: the shared liberties touch both colors) -> nothing removed.
void test_shared_region_kept() {
    printf("  Testing shared region kept...\n");
    init_board_logic();
    set_stone(0, 1, BLACK);
    set_stone(1, 0, BLACK);
    set_stone(2, 1, BLACK);
    set_stone(0, 2, WHITE);
    set_stone(1, 3, WHITE);
    set_stone(2, 2, WHITE);
    // shared liberties (1,1) and (1,2)
    uint8_t copy[81];
    memcpy(copy, board, sizeof(copy));
    ASSERT(remove_dead_stones(copy) == 0);
    ASSERT(copy[board_index(1, 1)] == EMPTY);
}

// Empty board scores exactly minus komi; open lone stones count as alive.
void test_smart_score() {
    printf("  Testing smart score basics...\n");
    init_board_logic();
    ASSERT(score_board_smart_10x(board) == -75);
    set_stone(4, 4, BLACK);
    set_stone(0, 0, WHITE);
    // 1-1 stones, no territory either way
    ASSERT(score_board_smart_10x(board) == -75);
}

// Preview map: dead stone flagged, interior owned, score consistent.
void test_score_preview() {
    printf("  Testing score preview map...\n");
    init_board_logic();
    for (int i = 0; i <= 3; i++) {
        set_stone(0, i, BLACK);
        set_stone(3, i, BLACK);
        set_stone(i, 0, BLACK);
        set_stone(i, 3, BLACK);
    }
    set_stone(1, 1, WHITE);
    uint8_t owner[81];
    bool dead[81];
    int diff = score_preview(board, owner, dead);
    ASSERT(diff == (12 + 4 + 65) * 10 - 75);
    ASSERT(dead[board_index(1, 1)]);          // the invader is dead
    ASSERT(!dead[board_index(0, 0)]);         // wall lives
    ASSERT(owner[board_index(1, 2)] == BLACK); // small interior is tinted
    ASSERT(owner[board_index(8, 8)] == EMPTY); // big open exterior stays neutral
    ASSERT(owner[board_index(1, 1)] == BLACK); // freed point counts as territory
}

// Open fighting boards get no tint wash: unsettled regions stay neutral.
void test_preview_open_board() {
    printf("  Testing preview on open board...\n");
    init_board_logic();
    set_stone(5, 4, BLACK);
    set_stone(4, 4, WHITE);
    set_stone(2, 4, BLACK);
    uint8_t owner[81];
    bool dead[81];
    int diff = score_preview(board, owner, dead);
    ASSERT(diff == (2 - 1) * 10 - 75);
    for (int i = 0; i < 81; i++) {
        ASSERT(!dead[i]);
        if (board[i] == EMPTY)
            ASSERT(owner[i] == EMPTY);
    }
}

// Influence agrees with flood where settled, but only reaches 5 points
// out: far unreachable exterior stays neutral instead of counted.
void test_influence_agrees_settled() {
    printf("  Testing influence agrees on settled board...\n");
    init_board_logic();
    for (int i = 0; i <= 3; i++) {
        set_stone(0, i, BLACK);
        set_stone(3, i, BLACK);
        set_stone(i, 0, BLACK);
        set_stone(i, 3, BLACK);
    }
    set_stone(1, 1, WHITE);
    uint8_t owner[81];
    int diff = score_influence_10x(board, owner);
    ASSERT(diff == 585); // 12 stones + 54 owned empties, komi 7.5
    ASSERT(owner[board_index(1, 2)] == BLACK); // sealed interior
    ASSERT(owner[board_index(4, 4)] == BLACK); // near exterior
    ASSERT(owner[board_index(8, 8)] == EMPTY); // too far, neutral
    // NULL map still returns the number (banner path).
    ASSERT(score_influence_10x(board, NULL) == diff);
}

// Single stone: diamond radius 5 clipped by edges (60 - 4 = 56 points).
void test_influence_open_single() {
    printf("  Testing influence around single stone...\n");
    init_board_logic();
    set_stone(4, 4, BLACK);
    uint8_t owner[81];
    int diff = score_influence_10x(board, owner);
    ASSERT(diff == (1 + 56) * 10 - 75);
    ASSERT(owner[board_index(4, 4)] == BLACK);
    ASSERT(owner[board_index(4, 0)] == BLACK);  // dist 4
    ASSERT(owner[board_index(0, 4)] == BLACK);  // dist 4
    ASSERT(owner[board_index(0, 0)] == EMPTY);  // dist 8, out of reach
    ASSERT(owner[board_index(4, 5)] == BLACK);  // dist 1
}

// Walls block influence; ties are neutral.
void test_influence_walls_and_ties() {
    printf("  Testing influence walls and ties...\n");
    init_board_logic();
    for (int c = 0; c < 9; c++)
        set_stone(4, c, BLACK);
    set_stone(0, 0, WHITE);
    uint8_t owner[81];
    score_influence_10x(board, owner);
    ASSERT(owner[board_index(2, 4)] == BLACK); // white 6 away, black 2
    ASSERT(owner[board_index(1, 0)] == WHITE); // white 1, black 3
    ASSERT(owner[board_index(0, 1)] == WHITE); // white 1, black 3

    init_board_logic();
    set_stone(4, 3, BLACK);
    set_stone(4, 5, WHITE);
    score_influence_10x(board, owner);
    ASSERT(owner[board_index(4, 4)] == EMPTY); // 1-1 tie, contested
    ASSERT(owner[board_index(4, 2)] == BLACK);
    ASSERT(owner[board_index(4, 6)] == WHITE);
}

// The 1:1 invariant: the number always equals the map sum (+komi).
static void check_invariant(void) {
    uint8_t owner[81];
    int diff = score_influence_10x(board, owner);
    int bs = 0, ws = 0;
    for (int i = 0; i < 81; i++) {
        if (board[i] == BLACK)
            bs++;
        else if (board[i] == WHITE)
            ws++;
        else if (owner[i] == BLACK)
            bs++;
        else if (owner[i] == WHITE)
            ws++;
    }
    ASSERT(diff == bs * 10 - (ws * 10 + 75));
}

void test_influence_11_invariant() {
    printf("  Testing influence 1:1 invariant...\n");
    init_board_logic();
    check_invariant(); // empty
    set_stone(4, 4, BLACK);
    set_stone(0, 0, WHITE);
    check_invariant(); // scattered
    set_stone(4, 3, BLACK);
    set_stone(4, 5, WHITE);
    set_stone(3, 4, BLACK);
    set_stone(5, 4, WHITE);
    check_invariant(); // cross fight, ties included
    for (int c = 0; c < 9; c++)
        set_stone(8, c, (c % 2) ? WHITE : BLACK);
    check_invariant(); // back rank + center
}
