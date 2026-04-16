#include "dialogs.h"
#include <pebble.h>
#include "../game_state.h"

// Static pointers for layers (memory safety)
static Layer *s_canvas_layer = NULL;

static Window *s_dialog_window = NULL;
static TextLayer *s_dialog_text_layer = NULL;
static const char *s_dialog_message = NULL;
static bool s_dialog_is_error = false;
static AppTimer *s_dialog_timer = NULL;

static Window *s_scroll_dialog_window = NULL;
static ScrollLayer *s_scroll_layer = NULL;
static TextLayer *s_scroll_text_layer = NULL;

static Window *s_gameover_dialog = NULL;
static TextLayer *s_gameover_text_layer = NULL;
static void (*s_gameover_dismiss_callback)(void) = NULL;

static Window *s_error_dialog = NULL;
static TextLayer *s_error_text_layer = NULL;
static AppTimer *s_error_timer = NULL;

void dialogs_init(Layer *canvas_layer) {
    s_canvas_layer = canvas_layer;
}

// Dialog Window Handlers
static void dialog_window_load(Window *window) {
    Layer *window_layer = window_get_root_layer(window);
    GRect bounds = layer_get_bounds(window_layer);

    s_dialog_text_layer = text_layer_create(bounds);
    text_layer_set_text(s_dialog_text_layer, s_dialog_message ? s_dialog_message : "Dialog");
    text_layer_set_text_alignment(s_dialog_text_layer, GTextAlignmentCenter);
    text_layer_set_font(s_dialog_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));

    if (s_dialog_is_error) {
        text_layer_set_background_color(s_dialog_text_layer, GColorRed);
        text_layer_set_text_color(s_dialog_text_layer, GColorWhite);
    } else {
        text_layer_set_background_color(s_dialog_text_layer, GColorWhite);
        text_layer_set_text_color(s_dialog_text_layer, GColorBlack);
    }

    layer_add_child(window_layer, text_layer_get_layer(s_dialog_text_layer));
}

static void dialog_window_unload(Window *window) {
    if (s_dialog_text_layer) {
        text_layer_destroy(s_dialog_text_layer);
        s_dialog_text_layer = NULL;
    }
}

static void dialog_click_config(void *context) {
    window_single_click_subscribe(BUTTON_ID_SELECT, (ClickHandler)hide_dialog);
    window_single_click_subscribe(BUTTON_ID_BACK, (ClickHandler)hide_dialog);
}

void show_dialog(const char *message) {
    if (s_dialog_window) return;
    s_dialog_message = message;
    s_dialog_is_error = false;
    s_dialog_window = window_create();
    window_set_window_handlers(s_dialog_window, (WindowHandlers) {
        .load = dialog_window_load,
        .unload = dialog_window_unload,
    });
    window_set_click_config_provider(s_dialog_window, dialog_click_config);
    window_stack_push(s_dialog_window, true);
    if (s_dialog_timer) app_timer_cancel(s_dialog_timer);
    s_dialog_timer = app_timer_register(3000, (AppTimerCallback)hide_dialog, NULL);
}

void show_ko_dialog(const char *message) {
    if (s_dialog_window) return;
    s_dialog_message = message;
    s_dialog_is_error = true;
    s_dialog_window = window_create();
    window_set_window_handlers(s_dialog_window, (WindowHandlers) {
        .load = dialog_window_load,
        .unload = dialog_window_unload,
    });
    window_set_click_config_provider(s_dialog_window, dialog_click_config);
    window_stack_push(s_dialog_window, true);
    if (s_dialog_timer) app_timer_cancel(s_dialog_timer);
    s_dialog_timer = app_timer_register(2000, (AppTimerCallback)hide_dialog, NULL);
}

void hide_dialog(void) {
    if (!s_dialog_window) return;
    if (s_dialog_timer) {
        app_timer_cancel(s_dialog_timer);
        s_dialog_timer = NULL;
    }
    window_stack_remove(s_dialog_window, true);
    window_destroy(s_dialog_window);
    s_dialog_window = NULL;
    if (s_canvas_layer) layer_mark_dirty(s_canvas_layer);
}

// Scroll Dialog
static void scroll_dialog_window_load(Window *window) {
    Layer *window_layer = window_get_root_layer(window);
    GRect bounds = layer_get_bounds(window_layer);

    s_scroll_layer = scroll_layer_create(bounds);
    s_scroll_text_layer = text_layer_create(GRect(0, 0, bounds.size.w, 2000));
    text_layer_set_text(s_scroll_text_layer, s_dialog_message ? s_dialog_message : "");
    text_layer_set_font(s_scroll_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
    text_layer_set_text_alignment(s_scroll_text_layer, GTextAlignmentCenter);
    text_layer_set_overflow_mode(s_scroll_text_layer, GTextOverflowModeWordWrap);
    text_layer_set_background_color(s_scroll_text_layer, GColorWhite);
    text_layer_set_text_color(s_scroll_text_layer, GColorBlack);

    GSize text_size = graphics_text_layout_get_content_size(
        s_dialog_message ? s_dialog_message : "",
        fonts_get_system_font(FONT_KEY_GOTHIC_18),
        GRect(0, 0, bounds.size.w - 4, 2000),
        GTextOverflowModeWordWrap,
        GTextAlignmentCenter
    );

    layer_set_bounds(text_layer_get_layer(s_scroll_text_layer), GRect(0, 0, bounds.size.w, text_size.h + 10));
    scroll_layer_add_child(s_scroll_layer, text_layer_get_layer(s_scroll_text_layer));
    scroll_layer_set_content_size(s_scroll_layer, GSize(bounds.size.w, text_size.h + 20));
    scroll_layer_set_click_config_onto_window(s_scroll_layer, window);
    layer_add_child(window_layer, scroll_layer_get_layer(s_scroll_layer));
}

static void scroll_dialog_window_unload(Window *window) {
    if (s_scroll_text_layer) {
        text_layer_destroy(s_scroll_text_layer);
        s_scroll_text_layer = NULL;
    }
    if (s_scroll_layer) {
        scroll_layer_destroy(s_scroll_layer);
        s_scroll_layer = NULL;
    }
}

static void scroll_dialog_click_config(void *context) {
    window_single_click_subscribe(BUTTON_ID_BACK, (ClickHandler)hide_scroll_dialog);
}

void show_scroll_dialog(const char *message) {
    if (s_scroll_dialog_window) return;
    s_dialog_message = message;
    s_scroll_dialog_window = window_create();
    window_set_window_handlers(s_scroll_dialog_window, (WindowHandlers) {
        .load = scroll_dialog_window_load,
        .unload = scroll_dialog_window_unload,
    });
    window_set_click_config_provider(s_scroll_dialog_window, scroll_dialog_click_config);
    window_stack_push(s_scroll_dialog_window, true);
}

void hide_scroll_dialog(void) {
    if (!s_scroll_dialog_window) return;
    window_stack_remove(s_scroll_dialog_window, true);
    window_destroy(s_scroll_dialog_window);
    s_scroll_dialog_window = NULL;
    if (s_canvas_layer) layer_mark_dirty(s_canvas_layer);
}

// Game Over Dialog
static void gameover_window_load(Window *window) {
    Layer *window_layer = window_get_root_layer(window);
    GRect bounds = layer_get_bounds(window_layer);

    int black_total_10x = black_score * 10;
    int white_total_10x = white_score * 10 + 75;
    bool black_wins = black_total_10x > white_total_10x;
    const char *winner = black_wins ? "Black wins!" : "White wins!";

    static char message[128];
    snprintf(message, sizeof(message), "%s\n\nB: %d.%d  W: %d.%d",
             winner, black_total_10x / 10, black_total_10x % 10,
             white_total_10x / 10, white_total_10x % 10);

    s_gameover_text_layer = text_layer_create(bounds);
    text_layer_set_text(s_gameover_text_layer, message);
    text_layer_set_text_alignment(s_gameover_text_layer, GTextAlignmentCenter);
    text_layer_set_font(s_gameover_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
    text_layer_set_background_color(s_gameover_text_layer, GColorBlack);
    text_layer_set_text_color(s_gameover_text_layer, GColorWhite);

    layer_add_child(window_layer, text_layer_get_layer(s_gameover_text_layer));
}

static void gameover_window_unload(Window *window) {
    if (s_gameover_text_layer) {
        text_layer_destroy(s_gameover_text_layer);
        s_gameover_text_layer = NULL;
    }
}

static void gameover_click_config(void *context) {
    window_single_click_subscribe(BUTTON_ID_SELECT, (ClickHandler)hide_gameover_dialog);
    window_single_click_subscribe(BUTTON_ID_BACK, (ClickHandler)hide_gameover_dialog);
}

void show_gameover_dialog(void (*on_dismiss)(void)) {
    if (s_gameover_dialog) return;
    s_gameover_dismiss_callback = on_dismiss;
    s_gameover_dialog = window_create();
    window_set_window_handlers(s_gameover_dialog, (WindowHandlers) {
        .load = gameover_window_load,
        .unload = gameover_window_unload,
    });
    window_set_click_config_provider(s_gameover_dialog, gameover_click_config);
    window_stack_push(s_gameover_dialog, true);
}

void hide_gameover_dialog(void) {
    if (!s_gameover_dialog) return;
    window_stack_remove(s_gameover_dialog, true);
    window_destroy(s_gameover_dialog);
    s_gameover_dialog = NULL;
    if (s_gameover_dismiss_callback) s_gameover_dismiss_callback();
    if (s_canvas_layer) layer_mark_dirty(s_canvas_layer);
}

// Error Dialog
static void error_window_load(Window *window) {
    Layer *window_layer = window_get_root_layer(window);
    GRect bounds = layer_get_bounds(window_layer);

    s_error_text_layer = text_layer_create(bounds);
    text_layer_set_text(s_error_text_layer, s_dialog_message ? s_dialog_message : "Error");
    text_layer_set_text_alignment(s_error_text_layer, GTextAlignmentCenter);
    text_layer_set_font(s_error_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
    text_layer_set_background_color(s_error_text_layer, GColorRed);
    text_layer_set_text_color(s_error_text_layer, GColorWhite);

    layer_add_child(window_layer, text_layer_get_layer(s_error_text_layer));
}

static void error_window_unload(Window *window) {
    if (s_error_text_layer) {
        text_layer_destroy(s_error_text_layer);
        s_error_text_layer = NULL;
    }
}

static void error_click_config(void *context) {
    window_single_click_subscribe(BUTTON_ID_SELECT, (ClickHandler)hide_error_dialog);
    window_single_click_subscribe(BUTTON_ID_BACK, (ClickHandler)hide_error_dialog);
}

void show_error_dialog(const char *message) {
    if (s_error_dialog) return;
    s_dialog_message = message;
    s_error_dialog = window_create();
    window_set_window_handlers(s_error_dialog, (WindowHandlers) {
        .load = error_window_load,
        .unload = error_window_unload,
    });
    window_set_click_config_provider(s_error_dialog, error_click_config);
    window_stack_push(s_error_dialog, true);
    if (s_error_timer) app_timer_cancel(s_error_timer);
    s_error_timer = app_timer_register(1500, (AppTimerCallback)hide_error_dialog, NULL);
}

void hide_error_dialog(void) {
    if (!s_error_dialog) return;
    if (s_error_timer) {
        app_timer_cancel(s_error_timer);
        s_error_timer = NULL;
    }
    window_stack_remove(s_error_dialog, true);
    window_destroy(s_error_dialog);
    s_error_dialog = NULL;
    if (s_canvas_layer) layer_mark_dirty(s_canvas_layer);
}
