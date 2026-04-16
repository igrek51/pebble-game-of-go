#ifndef GAME_STATE_H
#define GAME_STATE_H

#include <stdint.h>
#include "logic/board.h"

typedef enum {
    VIEW,
    SELECTING_ROW,
    SELECTING_COL,
    GAME_OVER_STATE
} UIState;

typedef enum {
    MODE_PVP,
    MODE_BLACK_AI,
    MODE_WHITE_AI,
    MODE_AI_AI
} GameMode;

extern uint8_t current_player;
extern int consecutive_passes;
extern int black_score;
extern int white_score;
extern UIState ui_state;
extern GameMode game_mode;

void init_board_logic(void);

#endif
