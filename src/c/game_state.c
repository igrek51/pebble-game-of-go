#include "game_state.h"
#include <string.h>
#include "logic/board.h"

uint8_t current_player = BLACK;
int consecutive_passes = 0;
int moves_made = 0;
int black_score = 0;
int white_score = 0;
UIState ui_state = VIEW;
GameMode game_mode = MODE_WHITE_AI;

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
}
