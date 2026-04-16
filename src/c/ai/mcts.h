#ifndef MCTS_AI_H
#define MCTS_AI_H

#include <stdint.h>
#include <stdbool.h>
#include "../logic/board.h"

// MCTS node structure (12 bytes)
typedef struct {
    uint16_t visits;
    uint16_t wins;
    uint16_t first_child_idx;   // 0xFFFF = no children
    uint16_t next_sibling_idx;  // 0xFFFF = no sibling
    uint8_t move_row;           // 9 = pass
    uint8_t move_col;           // 9 = pass
    uint8_t move_player;        // BLACK or WHITE
    uint8_t _pad;
} MCTSNode;

#define MCTS_POOL_SIZE 800
#define MCTS_NO_NODE 0xFFFF
#define MCTS_PASS_ROW 9
#define MCTS_PASS_COL 9
#define MCTS_ITERATIONS 20
#define MCTS_MAX_PLAYOUT 50

// AI functions
void mcts_init_zobrist(void);
void mcts_run(int iterations, uint8_t current_player, int last_row, int last_col, int consecutive_passes);
uint16_t mcts_get_best_move(void);
void mcts_get_move_coords(uint16_t node_idx, int *r, int *c);

// Hint functions
void suggest_hint_logic(uint8_t current_player, int last_row, int last_col, int *best_row, int *best_col);
int estimate_score_10x_logic(void);

#endif
