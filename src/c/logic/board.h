#ifndef BOARD_LOGIC_H
#define BOARD_LOGIC_H

#include <stdint.h>
#include <stdbool.h>

#define BOARD_SIZE 9
#define EMPTY 0
#define BLACK 1
#define WHITE 2

// Board state
extern uint8_t board[BOARD_SIZE * BOARD_SIZE];
extern uint8_t ko_board[BOARD_SIZE * BOARD_SIZE];
extern bool ko_active;

// Logic functions
int board_index(int row, int col);
uint8_t get_stone(int row, int col);
void set_stone(int row, int col, uint8_t color);

int count_liberties_on(uint8_t *b, int start_row, int start_col, uint8_t color);
void remove_group_on(uint8_t *b, int start_row, int start_col, uint8_t color);

int count_liberties(int start_row, int start_col, uint8_t color);
void remove_group(int start_row, int start_col, uint8_t color);

int score_board(uint8_t *b);
void compute_chinese_score(void);
bool can_make_legal_move(uint8_t player);

#endif
