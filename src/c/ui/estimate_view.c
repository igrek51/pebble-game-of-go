#include "estimate_view.h"
#include "../game_state.h"
#include "../logic/board.h"
#include "../logic/life.h"
#include "board_layer.h"
#include <pebble.h>
#include <stdio.h>

static Window *s_window = NULL;
static Layer *s_layer = NULL;
static void (*s_on_close)(void) = NULL;

// Snapshot taken when the view opens (the game keeps running underneath).
static uint8_t s_owner[BOARD_SIZE * BOARD_SIZE];
static bool s_dead[BOARD_SIZE * BOARD_SIZE];
static int s_diff_10x = 0;

static void estimate_update_proc(Layer *layer, GContext *ctx) {
    GRect bounds = layer_get_bounds(layer);
    int width = bounds.size.w;
    int height = bounds.size.h;

    graphics_context_set_fill_color(ctx, COLOR_BG);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);

    // Banner: same status-bar geometry as the game, blue aux-view color.
    graphics_context_set_fill_color(ctx, GColorBlue);
    graphics_fill_rect(ctx, GRect(0, 0, width, 25), 0, GCornerNone);
    graphics_context_set_text_color(ctx, GColorWhite);
    graphics_draw_text(ctx, "Estimate",
                       fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                       GRect(5, 0, 110, 20), GTextOverflowModeWordWrap,
                       GTextAlignmentLeft, NULL);
    int abs_diff = s_diff_10x < 0 ? -s_diff_10x : s_diff_10x;
    char score[16];
    snprintf(score, sizeof(score), "B%c%d.%d", (s_diff_10x >= 0 ? '+' : '-'),
             abs_diff / 10, abs_diff % 10);
    graphics_draw_text(ctx, score,
                       fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                       GRect(width - 80, 0, 75, 20), GTextOverflowModeWordWrap,
                       GTextAlignmentRight, NULL);

    // Board background (same geometry as the game board).
    graphics_context_set_stroke_color(ctx, COLOR_GRID);
    graphics_context_set_fill_color(ctx, COLOR_BOARD);
    graphics_fill_rect(ctx,
                       GRect(BOARD_ORIGIN_X - 1, BOARD_ORIGIN_Y - 1,
                             BOARD_SIZE * CELL_SIZE + 2,
                             height - (BOARD_ORIGIN_Y - 1)),
                       0, GCornerNone);

    // Grid lines.
    for (int i = 0; i < BOARD_SIZE; i++) {
        int x = BOARD_ORIGIN_X + i * CELL_SIZE;
        graphics_draw_line(
            ctx, GPoint(x, BOARD_ORIGIN_Y),
            GPoint(x, BOARD_ORIGIN_Y + (BOARD_SIZE - 1) * CELL_SIZE));
        int y = BOARD_ORIGIN_Y + i * CELL_SIZE;
        graphics_draw_line(
            ctx, GPoint(BOARD_ORIGIN_X, y),
            GPoint(BOARD_ORIGIN_X + (BOARD_SIZE - 1) * CELL_SIZE, y));
    }

    // Territory tint: small filled squares on owned empty points.
    for (int row = 0; row < BOARD_SIZE; row++) {
        for (int col = 0; col < BOARD_SIZE; col++) {
            int idx = board_index(row, col);
            if (board[idx] != EMPTY)
                continue;
            uint8_t owner = s_owner[idx];
            if (owner != BLACK && owner != WHITE)
                continue;
            GPoint p = GPoint(BOARD_ORIGIN_X + col * CELL_SIZE,
                              BOARD_ORIGIN_Y + row * CELL_SIZE);
            graphics_context_set_fill_color(
                ctx, (owner == BLACK) ? COLOR_BLACK_STONE
                                      : COLOR_WHITE_STONE);
            graphics_fill_rect(ctx, GRect(p.x - 2, p.y - 2, 5, 5), 0,
                               GCornerNone);
        }
    }

    // All stones as they stand (dead ones included, marked below).
    for (int row = 0; row < BOARD_SIZE; row++) {
        for (int col = 0; col < BOARD_SIZE; col++) {
            uint8_t stone = get_stone(row, col);
            if (stone == EMPTY)
                continue;
            GPoint p = GPoint(BOARD_ORIGIN_X + col * CELL_SIZE,
                              BOARD_ORIGIN_Y + row * CELL_SIZE);
            if (stone == BLACK) {
                graphics_context_set_fill_color(ctx, COLOR_BLACK_STONE);
            } else {
                graphics_context_set_fill_color(ctx, COLOR_WHITE_STONE);
                graphics_context_set_stroke_color(ctx, COLOR_GRID);
            }
            graphics_fill_circle(ctx, p, STONE_RADIUS);
            if (stone == WHITE)
                graphics_draw_circle(ctx, p, STONE_RADIUS);
        }
    }

    // Dead marks: hollow squares in the opposite color on dead stones.
    for (int row = 0; row < BOARD_SIZE; row++) {
        for (int col = 0; col < BOARD_SIZE; col++) {
            int idx = board_index(row, col);
            if (!s_dead[idx])
                continue;
            uint8_t stone = get_stone(row, col);
            if (stone != BLACK && stone != WHITE)
                continue;
            GPoint p = GPoint(BOARD_ORIGIN_X + col * CELL_SIZE,
                              BOARD_ORIGIN_Y + row * CELL_SIZE);
            graphics_context_set_stroke_color(
                ctx, (stone == BLACK) ? COLOR_WHITE_STONE
                                      : COLOR_BLACK_STONE);
            graphics_draw_rect(ctx, GRect(p.x - 5, p.y - 5, 11, 11));
            graphics_draw_rect(ctx, GRect(p.x - 4, p.y - 4, 9, 9));
        }
    }
}

static void estimate_window_load(Window *window) {
    s_layer = layer_create(layer_get_bounds(window_get_root_layer(window)));
    layer_set_update_proc(s_layer, estimate_update_proc);
    layer_add_child(window_get_root_layer(window), s_layer);
}

static void estimate_window_unload(Window *window) {
    layer_destroy(s_layer);
    s_layer = NULL;
}

static void estimate_back_click(ClickRecognizerRef recognizer, void *context) {
    (void)recognizer;
    (void)context;
    void (*cb)(void) = s_on_close;
    s_on_close = NULL;
    estimate_view_hide();
    if (cb)
        cb();
}

static void estimate_click_config(Window *window) {
    window_single_click_subscribe(BUTTON_ID_BACK, estimate_back_click);
}

void estimate_view_show(void (*on_close)(void)) {
    // One shared influence map drives both the tint and the number, so the
    // view always agrees with itself 1:1. Dead marks come from the same
    // removal underneath.
    s_diff_10x = score_influence_10x(board, s_owner);
    find_dead_map(board, s_dead);
    s_on_close = on_close;
    if (!s_window) {
        s_window = window_create();
        window_set_window_handlers(
            s_window, (WindowHandlers){.load = estimate_window_load,
                                       .unload = estimate_window_unload});
        window_set_click_config_provider(
            s_window, (ClickConfigProvider)estimate_click_config);
    }
    if (s_layer)
        layer_mark_dirty(s_layer);
    window_stack_push(s_window, true);
}

void estimate_view_hide(void) {
    if (s_window)
        window_stack_remove(s_window, true);
}
