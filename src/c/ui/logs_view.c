#include "logs_view.h"
#include "think_log.h"
#include <pebble.h>
#include <stdio.h>

static Window *s_window = NULL;
static Layer *s_title_layer = NULL;
static ScrollLayer *s_scroll_layer = NULL;
static TextLayer *s_text_layer = NULL;
static char s_buf[1024];

static void title_update_proc(Layer *layer, GContext *ctx) {
    GRect bounds = layer_get_bounds(layer);
    graphics_context_set_fill_color(ctx, GColorBlue);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
    graphics_context_set_text_color(ctx, GColorWhite);
    graphics_draw_text(ctx, "Logs", fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                       bounds, GTextOverflowModeWordWrap, GTextAlignmentCenter,
                       NULL);
}

static void logs_window_load(Window *window) {
    GRect bounds = layer_get_bounds(window_get_root_layer(window));
    s_title_layer = layer_create(GRect(0, 0, bounds.size.w, 25));
    layer_set_update_proc(s_title_layer, title_update_proc);
    layer_add_child(window_get_root_layer(window), s_title_layer);
    GRect scroll_bounds = GRect(0, 25, bounds.size.w, bounds.size.h - 25);
    s_scroll_layer = scroll_layer_create(scroll_bounds);
    s_text_layer = text_layer_create(GRect(0, 0, scroll_bounds.size.w, 2000));
    text_layer_set_text(s_text_layer, s_buf);
    text_layer_set_font(s_text_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
    text_layer_set_overflow_mode(s_text_layer,
                                 GTextOverflowModeWordWrap);
    text_layer_set_background_color(s_text_layer, GColorWhite);
    text_layer_set_text_color(s_text_layer, GColorBlack);
    GSize text_size = graphics_text_layout_get_content_size(
        s_buf, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(0, 0, scroll_bounds.size.w - 4, 2000),
        GTextOverflowModeWordWrap, GTextAlignmentLeft);
    layer_set_bounds(text_layer_get_layer(s_text_layer),
                     GRect(0, 0, scroll_bounds.size.w, text_size.h + 10));
    scroll_layer_add_child(s_scroll_layer,
                           text_layer_get_layer(s_text_layer));
    scroll_layer_set_content_size(s_scroll_layer,
                                  GSize(scroll_bounds.size.w, text_size.h + 20));
    scroll_layer_set_click_config_onto_window(s_scroll_layer, window);
    layer_add_child(window_get_root_layer(window),
                    scroll_layer_get_layer(s_scroll_layer));
}

static void logs_window_unload(Window *window) {
    (void)window;
    if (s_text_layer) {
        text_layer_destroy(s_text_layer);
        s_text_layer = NULL;
    }
    if (s_scroll_layer) {
        scroll_layer_destroy(s_scroll_layer);
        s_scroll_layer = NULL;
    }
    if (s_title_layer) {
        layer_destroy(s_title_layer);
        s_title_layer = NULL;
    }
    window_destroy(window);
    s_window = NULL;
}

void logs_view_show(void) {
    int n = think_log_count();
    if (n == 0) {
        snprintf(s_buf, sizeof(s_buf), "No moves yet");
    } else {
        s_buf[0] = '\0';
        size_t off = 0;
        for (int i = 0; i < n; i++) {
            const char *line = think_log_at(i);
            if (!line)
                continue;
            int w = snprintf(s_buf + off, sizeof(s_buf) - off, "%s\n", line);
            if (w < 0)
                break;
            off += (size_t)w;
            if (off >= sizeof(s_buf) - 1)
                break;
        }
    }
    if (!s_window) {
        s_window = window_create();
        window_set_window_handlers(
            s_window, (WindowHandlers){.load = logs_window_load,
                                       .unload = logs_window_unload});
    }
    window_stack_push(s_window, true);
}
