#ifndef COMM_H
#define COMM_H

#include <pebble.h>
#include <stdint.h>
#include <stdbool.h>

#define COMM_TIMEOUT_MS 72000

typedef void (*comm_ai_move_callback)(int row, int col, int is_pass);

// Server score estimate (type-2 message, arrives after the move reply):
// Black-relative score in 0.1pt units, Black winrate 0-100, the
// (moves_made, consecutive_passes) the estimate was computed for, and the
// ownership map (81 bytes, 0..200 offset = Black-relative -100..100) or
// NULL when absent.
typedef void (*comm_score_callback)(int score_10x, int black_pct, int for_moves, int for_passes, const uint8_t *ownership);

void comm_init(void);
bool comm_is_connected(void);
void comm_request_ai_move(uint8_t current_player, int last_row, int last_col, int consecutive_passes, int moves_made, int ai_engine, const char *katago_profile, comm_ai_move_callback callback);
void comm_set_score_callback(comm_score_callback callback);
void comm_cancel(void);

#endif
