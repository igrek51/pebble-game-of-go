#ifndef UI_BOARD_LAYER_H
#define UI_BOARD_LAYER_H

#include <pebble.h>
#include "../game_state.h"
#include "../ai/mcts.h"

#define CELL_SIZE 19
#define STONE_RADIUS 6
#define BOARD_ORIGIN_X 22
#define BOARD_ORIGIN_Y 48
#define MENU_ROW 9

// Colors
#define COLOR_BOARD GColorChromeYellow
#define COLOR_GRID GColorDarkGray
#define COLOR_BLACK_STONE GColorBlack
#define COLOR_WHITE_STONE GColorWhite
#define COLOR_CURSOR_COL GColorWhite
#define COLOR_HIGHLIGHT GColorWhite
#define COLOR_BG GColorChromeYellow

void board_layer_update_proc(Layer *layer, GContext *ctx, int selected_row, int selected_col);

#endif
