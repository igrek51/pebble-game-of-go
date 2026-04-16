#include "board_layer.h"
#include <pebble.h>
#include "../game_state.h"
#include "../logic/board.h"
#include "../ai/mcts.h"

void board_layer_update_proc(Layer *layer, GContext *ctx, int selected_row, int selected_col) {
    // Clear background
    graphics_context_set_fill_color(ctx, COLOR_BG);
    graphics_fill_rect(ctx, layer_get_bounds(layer), 0, GCornerNone);

    // Draw status bar
    GColor status_bg_color, status_text_color;
    if (ui_state == GAME_OVER_STATE) {
        status_bg_color = GColorBlue;
        status_text_color = GColorWhite;
    } else if (current_player == BLACK) {
        status_bg_color = GColorBlack;
        status_text_color = GColorWhite;
    } else {
        status_bg_color = GColorWhite;
        status_text_color = GColorBlack;
    }

    graphics_context_set_fill_color(ctx, status_bg_color);
    graphics_fill_rect(ctx, GRect(0, 0, 200, 20), 0, GCornerNone);
    graphics_context_set_text_color(ctx, status_text_color);

    char left_text[32];
    if (ui_state == GAME_OVER_STATE) {
        snprintf(left_text, sizeof(left_text), "%s", (black_score > white_score) ? "Black won" : "White won");
    } else {
        bool is_ai = ((game_mode == MODE_BLACK_AI && current_player == BLACK) ||
                      (game_mode == MODE_WHITE_AI && current_player == WHITE) ||
                      (game_mode == MODE_AI_AI));
        snprintf(left_text, sizeof(left_text), "%s %s",
            (current_player == BLACK ? "Black" : "White"),
            is_ai ? "is thinking" : "to move");
    }
    graphics_draw_text(ctx, left_text, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(5, 2, 120, 20), GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);

    char right_text[32];
    if (ui_state == GAME_OVER_STATE) {
        int diff_10x = (black_score * 10) - (white_score * 10 + 75);
        int abs_diff_10x = diff_10x < 0 ? -diff_10x : diff_10x;
        
        snprintf(right_text, sizeof(right_text), "%c%d.5", (diff_10x >= 0 ? 'B' : 'W'), abs_diff_10x / 10);
    } else {
        int diff_10x = estimate_score_10x_logic();
        int abs_diff_10x = diff_10x < 0 ? -diff_10x : diff_10x;
        snprintf(right_text, sizeof(right_text), "B%c%d.%d", (diff_10x >= 0 ? '+' : '-'), abs_diff_10x / 10, abs_diff_10x % 10);
    }
    graphics_draw_text(ctx, right_text, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(120, 2, 75, 20), GTextOverflowModeWordWrap, GTextAlignmentRight, NULL);

    // Board background
    graphics_context_set_stroke_color(ctx, COLOR_GRID);
    graphics_context_set_fill_color(ctx, COLOR_BOARD);
    graphics_fill_rect(ctx, GRect(BOARD_ORIGIN_X - 1, BOARD_ORIGIN_Y - 1,
                                   BOARD_SIZE * CELL_SIZE + 2, 228 - (BOARD_ORIGIN_Y - 1)), 0, GCornerNone);

    if (ui_state == SELECTING_ROW) {
        int row_y = BOARD_ORIGIN_Y + selected_row * CELL_SIZE;
        graphics_context_set_fill_color(ctx, COLOR_HIGHLIGHT);
        graphics_fill_rect(ctx, GRect(BOARD_ORIGIN_X - CELL_SIZE/2, row_y - CELL_SIZE/2,
                                      BOARD_SIZE * CELL_SIZE + CELL_SIZE/2, CELL_SIZE), 0, GCornerNone);
    }

    if (ui_state == SELECTING_COL && selected_row != MENU_ROW) {
        int cursor_x = BOARD_ORIGIN_X + selected_col * CELL_SIZE;
        int cursor_y = BOARD_ORIGIN_Y + selected_row * CELL_SIZE;
        graphics_context_set_fill_color(ctx, COLOR_CURSOR_COL);
        graphics_fill_rect(ctx, GRect(cursor_x - CELL_SIZE/2, cursor_y - CELL_SIZE/2, CELL_SIZE, CELL_SIZE), 0, GCornerNone);
    }

    // Grid lines
    graphics_context_set_stroke_color(ctx, COLOR_GRID);
    for (int i = 0; i < BOARD_SIZE; i++) {
        int x = BOARD_ORIGIN_X + i * CELL_SIZE;
        graphics_draw_line(ctx, GPoint(x, BOARD_ORIGIN_Y), GPoint(x, BOARD_ORIGIN_Y + (BOARD_SIZE - 1) * CELL_SIZE));
        int y = BOARD_ORIGIN_Y + i * CELL_SIZE;
        graphics_draw_line(ctx, GPoint(BOARD_ORIGIN_X, y), GPoint(BOARD_ORIGIN_X + (BOARD_SIZE - 1) * CELL_SIZE, y));
    }

    // Labels
    graphics_context_set_text_color(ctx, COLOR_GRID);
    const char col_labels[] = "ABCDEFGHJ";
    for (int col = 0; col < BOARD_SIZE; col++) {
        char label[2] = {col_labels[col], '\0'};
        graphics_draw_text(ctx, label, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
            GRect(BOARD_ORIGIN_X + col * CELL_SIZE - 6, BOARD_ORIGIN_Y - 25, 12, 14),
            GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    }
    for (int row = 0; row < BOARD_SIZE; row++) {
        char label[2];
        snprintf(label, sizeof(label), "%d", BOARD_SIZE - row);
        graphics_draw_text(ctx, label, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
            GRect(3, BOARD_ORIGIN_Y + row * CELL_SIZE - 9, 10, 14),
            GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    }

    graphics_draw_text(ctx, "...", fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(BOARD_ORIGIN_X + CELL_SIZE * 4 - 6, BOARD_ORIGIN_Y + MENU_ROW * CELL_SIZE - 7, 12, 14),
        GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);

    // Hoshi points
    graphics_context_set_fill_color(ctx, COLOR_GRID);
    int hoshi[5][2] = {{2,2}, {2,6}, {4,4}, {6,2}, {6,6}};
    for (int i = 0; i < 5; i++) {
        graphics_fill_circle(ctx, GPoint(BOARD_ORIGIN_X + hoshi[i][1] * CELL_SIZE, BOARD_ORIGIN_Y + hoshi[i][0] * CELL_SIZE), 2);
    }

    // Stones
    for (int row = 0; row < BOARD_SIZE; row++) {
        for (int col = 0; col < BOARD_SIZE; col++) {
            uint8_t stone = get_stone(row, col);
            if (stone == EMPTY) continue;
            GPoint p = GPoint(BOARD_ORIGIN_X + col * CELL_SIZE, BOARD_ORIGIN_Y + row * CELL_SIZE);
            if (stone == BLACK) {
                graphics_context_set_fill_color(ctx, COLOR_BLACK_STONE);
            } else {
                graphics_context_set_fill_color(ctx, COLOR_WHITE_STONE);
                graphics_context_set_stroke_color(ctx, COLOR_GRID);
            }
            graphics_fill_circle(ctx, p, STONE_RADIUS);
            if (stone == WHITE) graphics_draw_circle(ctx, p, STONE_RADIUS);
        }
    }
}
