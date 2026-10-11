#ifndef UI_DIALOGS_H
#define UI_DIALOGS_H

#include <pebble.h>
#include "../game_state.h"

// Dialog functions
void show_dialog(const char *message);
void show_ko_dialog(const char *message);
void hide_dialog(void);

void show_scroll_dialog(const char *message);

void show_gameover_dialog(void (*on_dismiss)(void));
void hide_gameover_dialog(void);
// Rebuild the game-over text if the dialog is open (server final lands
// after the dialog shows).
void gameover_refresh(void);

void show_error_dialog(const char *message);
void hide_error_dialog(void);

// Pass the canvas layer for marking dirty
void dialogs_init(Layer *canvas_layer);

#endif
