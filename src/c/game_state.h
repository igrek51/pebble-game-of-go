#ifndef GAME_STATE_H
#define GAME_STATE_H

#include <stdint.h>
#include <stdbool.h>
#include "logic/board.h"

typedef enum {
    VIEW,
    SELECTING_ROW,
    SELECTING_COL,
    GAME_OVER_STATE,
    AI_THINKING // waiting on the phone companion (pkjs); the only AI engine
} UIState;

typedef enum {
    MODE_PVP,
    MODE_WHITE_AI, // Black vs AI
    MODE_BLACK_AI, // White vs AI
    MODE_AI_AI
} GameMode;

extern uint8_t current_player;
extern int consecutive_passes;
extern int moves_made;
extern int black_score;
extern int white_score;
extern UIState ui_state;
extern GameMode game_mode;
extern int last_move_row;
extern int last_move_col;
extern bool last_move_placed;

void init_board_logic(void);

// Server score estimate (type-2 message from pkjs): set on arrival,
// fresh only while (moves_made, consecutive_passes) still match.
// score_10x and black_pct (Black winrate 0-100) are Black-relative.
void server_score_set(int score_10x, int black_pct, int for_moves,
                      int for_passes);
bool server_score_fresh(int *s10_out, int *pct_out);

// Seconds elapsed since the current AI thinking phase started (0 when not
// thinking). Implemented in main.c, rendered by the status bar.
int think_elapsed_sec(void);

#endif
