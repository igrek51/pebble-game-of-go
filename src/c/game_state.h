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
// Live territory-estimate overlay on the board (Settings toggle,
// persisted, default off).
extern bool terr_estimate_on;
// Companion AI engine (Settings, persisted, default MCTS): the watch
// forwards the choice to pkjs, which plays locally or via KataGo.
#define AI_ENGINE_MCTS 0
#define AI_ENGINE_KATAGO 1
extern int ai_engine;
// Katago level index (default 0 = 12k). Profile string for the server,
// level count for cycling in Settings.
extern int katago_level;
const char *katago_profile(void);
int katago_level_count(void);

void init_board_logic(void);

// Undo history: record stone positions (row*9+col) and passes (-1);
// truncate to `keep` plies and rebuild the position by replay.
#define MOVE_HIST_MAX 300
void hist_record(int pos);
int hist_len(void);
// False after a recording overflow: Undo must refuse.
bool hist_can_undo(void);
// Snapshot the current position as the session base (new game, restore).
// Only moves recorded after it are retractable.
void hist_snapshot(void);
void undo_to_len(int keep);

// Snap a 0.1pt score to the nearest possible final margin (komi 7.5
// makes exact results always n+0.5): 54->55, 59->55, 61->65, -4->-5.
static inline int round_10x_to_half(int v) {
    int q = v - 5;
    int r = (q >= 0) ? (q + 5) / 10 : -((-q + 5) / 10);
    return r * 10 + 5;
}

// Server ownership (-100..100, Black-relative) helpers for tinting:
// |v|>=20 counts as owned; a stone is estimated dead only when its point
// is confidently the opponent's (|v|>=60), so live stones in contested
// areas are never marked.
#define SERVER_OWN_TINT 20
#define SERVER_OWN_DEAD 60
static inline uint8_t server_owner_color(int v) {
    if (v >= SERVER_OWN_TINT)
        return BLACK;
    if (v <= -SERVER_OWN_TINT)
        return WHITE;
    return EMPTY;
}
static inline bool server_stone_dead(int v, uint8_t stone) {
    return (stone == BLACK && v <= -SERVER_OWN_DEAD) ||
           (stone == WHITE && v >= SERVER_OWN_DEAD);
}

// Server score estimate (type-2 message from pkjs): set on arrival,
// fresh only while (moves_made, consecutive_passes) still match.
// score_10x and black_pct (Black winrate 0-100) are Black-relative.
void server_score_set(int score_10x, int black_pct, int for_moves,
                      int for_passes, const uint8_t *own_raw);
bool server_score_fresh(int *s10_out, int *pct_out);
const int8_t *server_owner_map(void);

// Seconds elapsed since the current AI thinking phase started (0 when not
// thinking). Implemented in main.c, rendered by the status bar.
int think_elapsed_sec(void);

#endif
