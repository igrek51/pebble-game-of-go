#include "game_state.h"
#include "logic/board.h"
#include <string.h>

uint8_t current_player = BLACK;
int consecutive_passes = 0;
int moves_made = 0;
int black_score = 0;
int white_score = 0;
// Server score estimate (type-2 message): valid only while the game state
// still matches the (moves, passes) it was computed for.
int server_score_10x = 0;
int server_score_pct = 50;
int server_score_moves = -1;
int server_score_passes = -1;
UIState ui_state = VIEW;
GameMode game_mode = MODE_WHITE_AI;
int last_move_row = 4;
int last_move_col = 4;
bool last_move_placed = false;

void init_board_logic(void) {
    memset(board, EMPTY, sizeof(board));
    memset(ko_board, EMPTY, sizeof(ko_board));
    current_player = BLACK;
    ko_active = false;
    consecutive_passes = 0;
    moves_made = 0;
    black_score = 0;
    white_score = 0;
    ui_state = VIEW;
    last_move_row = 4;
    last_move_col = 4;
    last_move_placed = false;
    server_score_10x = 0;
    server_score_pct = 50;
    server_score_moves = -1;
    server_score_passes = -1;
}

void server_score_set(int score_10x, int black_pct, int for_moves,
                      int for_passes) {
    server_score_10x = score_10x;
    server_score_pct = black_pct;
    server_score_moves = for_moves;
    server_score_passes = for_passes;
}

bool server_score_fresh(int *s10_out, int *pct_out) {
    if (server_score_moves == moves_made &&
        server_score_passes == consecutive_passes) {
        if (s10_out)
            *s10_out = server_score_10x;
        if (pct_out)
            *pct_out = server_score_pct;
        return true;
    }
    return false;
}
