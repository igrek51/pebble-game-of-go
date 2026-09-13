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

void find_unconditionally_alive(uint8_t *b, bool *alive_out);
int remove_dead_stones(uint8_t *b);
int score_board_smart_10x(uint8_t *b);

#endif
