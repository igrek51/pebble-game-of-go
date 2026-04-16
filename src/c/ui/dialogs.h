#ifndef UI_DIALOGS_H
#define UI_DIALOGS_H

#include <pebble.h>
#include "../game_state.h"

// Dialog functions
void show_dialog(const char *message);
void show_ko_dialog(const char *message);
void hide_dialog(void);

void show_scroll_dialog(const char *message);
void hide_scroll_dialog(void);

void show_gameover_dialog(void (*on_dismiss)(void));
void hide_gameover_dialog(void);

void show_error_dialog(const char *message);
void hide_error_dialog(void);

// Pass the canvas layer for marking dirty
void dialogs_init(Layer *canvas_layer);

#endif
