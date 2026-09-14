#ifndef LIFE_H
#define LIFE_H

#include <stdint.h>
#include <stdbool.h>
#include "board.h"

// Static life/death analysis for score estimation (Tier 1).
//
// find_unconditionally_alive: Benson's algorithm. Marks stones that are safe
//   even if their owner passes forever. Conservative: seki groups, fighting
//   groups and groups with false eyes are NOT marked (that is correct —
//   "not alive" here never means "dead").
// remove_dead_stones: removes provably-dead stones in place, to a fixpoint.
//   A non-alive block is removed only if every adjacent empty region is
//   small (no room to live or escape) and enclosed purely by opponent stones.
//   Shared regions (seki), open areas and big dragons are always kept.
//   Returns the number of stones removed.
// score_board_smart_10x: Tromp-Taylor-like area score after dead removal,
//   scaled by 10 with exact 7.5 komi: (black area)*10 - (white area)*10 - 75.
// score_preview: full per-point breakdown for the estimate overlay (see
//   below). Returns the same diff*10 score.

void find_unconditionally_alive(uint8_t *b, bool *alive_out);
int remove_dead_stones(uint8_t *b);
int score_board_smart_10x(uint8_t *b);

// owner_out[i]: surviving stone color; empty points in settled (small)
// regions carry the owning color, large open frameworks stay EMPTY even
// though the score counts them — tint shows settled areas only.
// dead_out[i]: true only for removed stones.
int score_preview(uint8_t *b, uint8_t *owner_out, bool *dead_out);

// Lightweight dead-stone map for the overlay: removes dead stones on a copy
// and flags positions that held a stone before but don't after.
void find_dead_map(uint8_t *b, bool *dead_out);

// Influence ownership for OPEN positions (display paths: live banner and
// estimate overlay). After dead removal, per-color BFS distances over empty
// points (stones block, cap INFLUENCE_DIST_MAX); each empty point is owned
// by the nearer color, ties and out-of-reach points are neutral. Stones
// count for their color. owner_out (nullable) receives stone colors and
// empty-point owners (EMPTY = neutral). Returns (black area)*10 -
// (white area)*10 - 75, computed from the SAME map, so map and number
// always agree 1:1. On settled positions this matches the flood scorer.
int score_influence_10x(uint8_t *b, uint8_t *owner_out);

#endif
