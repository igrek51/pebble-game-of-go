#ifndef UI_BOARD_LAYER_H
#define UI_BOARD_LAYER_H

#include <pebble.h>
#include "../game_state.h"
#include "../ai/mcts.h"

#ifdef PBL_PLATFORM_GABBRO
#define CELL_SIZE 19
#define STONE_RADIUS 7
#define BOARD_ORIGIN_X 31
#define BOARD_ORIGIN_Y 57
#define COL_LABEL_Y_OFFSET 25
#else
#define CELL_SIZE 21
#define STONE_RADIUS 8
#define BOARD_ORIGIN_X 15
#define BOARD_ORIGIN_Y 46
#define COL_LABEL_Y_OFFSET 20
#endif
#define MENU_ROW 9

// Colors
#define COLOR_BOARD GColorChromeYellow
#define COLOR_GRID GColorBlack
#define COLOR_BLACK_STONE GColorBlack
#define COLOR_WHITE_STONE GColorWhite
#define COLOR_CURSOR_COL GColorIcterine
#define COLOR_HIGHLIGHT GColorIcterine
#define COLOR_BG GColorChromeYellow

void board_layer_update_proc(Layer *layer, GContext *ctx, int selected_row, int selected_col);

#endif
