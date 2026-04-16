#include <pebble.h>
#include "game_state.h"
#include "logic/board.h"
#include "ai/mcts.h"
#include "ui/dialogs.h"
#include "ui/board_layer.h"

// UI state
static int selected_row = 0;
static int selected_col = 0;
static int last_row = 4;
static int last_col = 4;

static AppTimer *ai_move_timer = NULL;

// Window & layer
static Window *s_main_window;
static Layer *s_canvas_layer;

// Menus
static Window *s_menu_window = NULL;
static SimpleMenuLayer *s_menu_layer = NULL;
static SimpleMenuSection menu_sections[1];
static Window *s_mode_window = NULL;
static SimpleMenuLayer *s_mode_layer = NULL;
static SimpleMenuSection mode_sections[1];

// Forward declarations
static void init_board_full(void);
static void ai_move_callback(void *data);
static void canvas_update_proc(Layer *layer, GContext *ctx);
static void handle_click(ClickRecognizerRef recognizer, void *context);
static void show_menu(void);
static void hide_menu(void);
static void show_mode_select(void);
static void hide_mode_select(void);

// Initialize everything
static void init_board_full(void) {
    init_board_logic();
    selected_row = 0;
    selected_col = 0;
    last_row = 4;
    last_col = 4;

    if (ai_move_timer) {
        app_timer_cancel(ai_move_timer);
        ai_move_timer = NULL;
    }

    if (game_mode == MODE_BLACK_AI || game_mode == MODE_AI_AI) {
        ai_move_timer = app_timer_register(500, ai_move_callback, NULL);
    }
}

// Pass action
static void do_pass_ui(void) {
    consecutive_passes++;
    ko_active = false;

    if (consecutive_passes >= 2) {
        ui_state = GAME_OVER_STATE;
        compute_chinese_score();
        show_gameover_dialog(init_board_full);
        return;
    }

    current_player = (current_player == BLACK) ? WHITE : BLACK;
    ui_state = VIEW;

    bool next_is_ai = (game_mode == MODE_BLACK_AI && current_player == BLACK) ||
                      (game_mode == MODE_WHITE_AI && current_player == WHITE) ||
                      (game_mode == MODE_AI_AI);
    if (next_is_ai) {
        if (ai_move_timer) app_timer_cancel(ai_move_timer);
        ai_move_timer = app_timer_register(500, ai_move_callback, NULL);
    }
}

static bool try_place_stone_ui(int row, int col) {
    int idx = board_index(row, col);
    if (idx < 0) return false;
    if (board[idx] != EMPTY) {
        show_error_dialog("Cell occupied!");
        return false;
    }

    uint8_t opponent = (current_player == BLACK) ? WHITE : BLACK;
    uint8_t temp_board[BOARD_SIZE * BOARD_SIZE];
    memcpy(temp_board, board, sizeof(board));

    board[idx] = current_player;

    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};
    bool any_captured = false;
    for (int d = 0; d < 4; d++) {
        int nr = row + dr[d], nc = col + dc[d];
        if (board_index(nr, nc) >= 0 && board[board_index(nr, nc)] == opponent) {
            if (count_liberties(nr, nc, opponent) == 0) {
                remove_group(nr, nc, opponent);
                any_captured = true;
            }
        }
    }

    if (count_liberties(row, col, current_player) == 0) {
        memcpy(board, temp_board, sizeof(board));
        show_error_dialog("Suicide! Illegal move");
        return false;
    }

    if (ko_active && memcmp(board, ko_board, sizeof(board)) == 0) {
        memcpy(board, temp_board, sizeof(board));
        show_ko_dialog("Ko rule! Illegal move");
        return false;
    }

    memcpy(ko_board, temp_board, sizeof(board));
    ko_active = any_captured;

    moves_made++;
    last_row = row;
    last_col = col;
    consecutive_passes = 0;
    current_player = opponent;
    ui_state = VIEW;

    bool next_is_ai = (game_mode == MODE_BLACK_AI && current_player == BLACK) ||
                      (game_mode == MODE_WHITE_AI && current_player == WHITE) ||
                      (game_mode == MODE_AI_AI);
    if (next_is_ai) {
        if (ai_move_timer) app_timer_cancel(ai_move_timer);
        ai_move_timer = app_timer_register(500, ai_move_callback, NULL);
    }

    return true;
}

static void ai_move_callback(void *data) {
    ai_move_timer = NULL;
    if (ui_state != VIEW) return;

    if (!can_make_legal_move(current_player)) {
        do_pass_ui();
        layer_mark_dirty(s_canvas_layer);
        return;
    }

    // First move D5 (only if no moves made yet)
    if (moves_made == 0 && current_player == BLACK && get_stone(4, 3) == EMPTY) {
        try_place_stone_ui(4, 3);
    } else {
        mcts_run(MCTS_ITERATIONS, current_player, last_row, last_col, consecutive_passes);
        uint16_t best_child = mcts_get_best_move();
        if (best_child == MCTS_NO_NODE) {
            do_pass_ui();
        } else {
            int r, c;
            mcts_get_move_coords(best_child, &r, &c);
            if (r == MCTS_PASS_ROW && c == MCTS_PASS_COL) {
                do_pass_ui();
            } else {
                try_place_stone_ui(r, c);
            }
        }
    }
    layer_mark_dirty(s_canvas_layer);
}

// Helper needed in mcts.c
// void mcts_get_move_coords(uint16_t node_idx, int *r, int *c);

// I'll update mcts.c/h later. For now, let's continue main.c

static void canvas_update_proc(Layer *layer, GContext *ctx) {
    board_layer_update_proc(layer, ctx, selected_row, selected_col);
}

static void click_config_provider(Window *window) {
    window_single_click_subscribe(BUTTON_ID_UP, handle_click);
    window_single_click_subscribe(BUTTON_ID_DOWN, handle_click);
    window_single_click_subscribe(BUTTON_ID_SELECT, handle_click);
    window_single_click_subscribe(BUTTON_ID_BACK, handle_click);
}

static void handle_click(ClickRecognizerRef recognizer, void *context) {
    ButtonId button = click_recognizer_get_button_id(recognizer);

    if (ui_state == VIEW) {
        if (button == BUTTON_ID_BACK) show_menu();
        else {
            ui_state = SELECTING_ROW;
            selected_row = last_row;
            if (button == BUTTON_ID_UP && selected_row > 0) selected_row--;
            if (button == BUTTON_ID_DOWN && selected_row < MENU_ROW) selected_row++;
        }
    } else if (ui_state == SELECTING_ROW) {
        if (button == BUTTON_ID_UP) selected_row = (selected_row > 0) ? selected_row - 1 : MENU_ROW;
        else if (button == BUTTON_ID_DOWN) selected_row = (selected_row < MENU_ROW) ? selected_row + 1 : 0;
        else if (button == BUTTON_ID_SELECT) {
            if (selected_row == MENU_ROW) show_menu();
            else { ui_state = SELECTING_COL; selected_col = last_col; }
        } else if (button == BUTTON_ID_BACK) ui_state = VIEW;
    } else if (ui_state == SELECTING_COL) {
        if (button == BUTTON_ID_UP) selected_col = (selected_col > 0) ? selected_col - 1 : BOARD_SIZE - 1;
        else if (button == BUTTON_ID_DOWN) selected_col = (selected_col < BOARD_SIZE - 1) ? selected_col + 1 : 0;
        else if (button == BUTTON_ID_SELECT) try_place_stone_ui(selected_row, selected_col);
        else if (button == BUTTON_ID_BACK) ui_state = SELECTING_ROW;
    } else if (ui_state == GAME_OVER_STATE) {
        if (button == BUTTON_ID_SELECT || button == BUTTON_ID_BACK) init_board_full();
    }
    layer_mark_dirty(s_canvas_layer);
}

// Menu callbacks
static void menu_select_callback(int index, void *context) {
    if (index == 0) do_pass_ui();
    else if (index == 1) { hide_menu(); show_mode_select(); return; }
    else if (index == 2) {
        suggest_hint_logic(current_player, last_row, last_col, &selected_row, &selected_col);
        if (selected_row >= 0) ui_state = SELECTING_COL;
    }
    else if (index == 3) {
        hide_menu();
        show_scroll_dialog(
            "Rules of Go:\n"
            "Go is a two-player, turn-based board game played on a grid, where the goal is to control more territory than the opponent.\n"
            "Black moves first, alternating turns by placing one stone on an intersection.\n"
            "Stones are captured by surrounding them, and the game ends with 2 consecutive passed turns, scoring by occupied area.\n\n"
            "• Players take turns placing a single stone on an empty intersection. Stones cannot be moved.\n"
            "• Capture (Liberties): A stone or group must have adjacent (not diagonally) empty points (liberties) to remain on the board.\n"
            "If all liberties are blocked by opponent stones, the group is removed.\n"
            "• Illegal Suicide Move: You cannot place a stone where it has no liberties unless it captures an opponent's stone(s).\n"
            "• The Ko rule prohibits immediately re-capturing a single stone if it repeats a previous board position.\n"
            "• Ending the Game: The game ends when both players pass consecutively. Passing is allowed at any time.\n"
            "• Scoring (Goal): The winner is the player with the most occupied area: territory (empty points surrounded) plus stones on board.\n"
            "• Compensation: White receives extra 7.5 points (komi) to compensate for going second.\n"
        );
        return;
    }
    else if (index == 4) { hide_menu(); window_stack_pop_all(true); return; }
    hide_menu();
    layer_mark_dirty(s_canvas_layer);
}

static void show_menu(void) {
    if (!s_menu_window) {
        s_menu_window = window_create();
        static SimpleMenuItem items[5];
        items[0] = (SimpleMenuItem){ .title = "PASS", .callback = menu_select_callback };
        items[1] = (SimpleMenuItem){ .title = "NEW GAME", .callback = menu_select_callback };
        items[2] = (SimpleMenuItem){ .title = "HINT", .callback = menu_select_callback };
        items[3] = (SimpleMenuItem){ .title = "RULES", .callback = menu_select_callback };
        items[4] = (SimpleMenuItem){ .title = "EXIT", .callback = menu_select_callback };
        menu_sections[0] = (SimpleMenuSection){ .num_items = 5, .items = items };
        s_menu_layer = simple_menu_layer_create(layer_get_bounds(window_get_root_layer(s_menu_window)), s_menu_window, menu_sections, 1, NULL);
        layer_add_child(window_get_root_layer(s_menu_window), simple_menu_layer_get_layer(s_menu_layer));
    }
    window_stack_push(s_menu_window, true);
}

static void hide_menu(void) { if (s_menu_window) window_stack_remove(s_menu_window, true); }

static void mode_select_callback(int index, void *context) {
    game_mode = (GameMode)index;
    init_board_full();
    hide_mode_select();
}

static void show_mode_select(void) {
    if (!s_mode_window) {
        s_mode_window = window_create();
        static SimpleMenuItem items[4];
        items[0] = (SimpleMenuItem){ .title = "Player vs Player", .callback = mode_select_callback };
        items[1] = (SimpleMenuItem){ .title = "Black vs AI", .callback = mode_select_callback };
        items[2] = (SimpleMenuItem){ .title = "White vs AI", .callback = mode_select_callback };
        items[3] = (SimpleMenuItem){ .title = "AI vs AI", .callback = mode_select_callback };
        mode_sections[0] = (SimpleMenuSection){ .num_items = 4, .items = items };
        s_mode_layer = simple_menu_layer_create(layer_get_bounds(window_get_root_layer(s_mode_window)), s_mode_window, mode_sections, 1, NULL);
        layer_add_child(window_get_root_layer(s_mode_window), simple_menu_layer_get_layer(s_mode_layer));
    }
    window_stack_push(s_mode_window, true);
}

static void hide_mode_select(void) { if (s_mode_window) window_stack_remove(s_mode_window, true); }

static void window_load(Window *window) {
    s_canvas_layer = layer_create(layer_get_bounds(window_get_root_layer(window)));
    layer_set_update_proc(s_canvas_layer, canvas_update_proc);
    layer_add_child(window_get_root_layer(window), s_canvas_layer);
    window_set_click_config_provider(window, (ClickConfigProvider) click_config_provider);
    dialogs_init(s_canvas_layer);
}

static void window_unload(Window *window) { layer_destroy(s_canvas_layer); }

static void init(void) {
    mcts_init_zobrist();
    init_board_full();
    s_main_window = window_create();
    window_set_window_handlers(s_main_window, (WindowHandlers) { .load = window_load, .unload = window_unload });
    window_stack_push(s_main_window, true);
}

static void deinit(void) { window_destroy(s_main_window); }

int main(void) {
    init();
    app_event_loop();
    deinit();
    return 0;
}
