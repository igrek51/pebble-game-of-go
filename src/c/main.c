#include "ai/mcts.h"
#include "comm/comm.h"
#include "game_state.h"
#include "logic/board.h"
#include "ui/board_layer.h"
#include "ui/dialogs.h"
#include "ui/estimate_view.h"
#include <pebble.h>

static int selected_row = 0;
static int selected_col = 0;

static AppTimer *ai_move_timer = NULL;

// AI request epoch: every new pkjs request stamps s_req_epoch; any game
// event that makes a pending reply stale (pass, stone, new game, estimate
// pause) bumps s_ai_epoch. A reply whose epoch mismatches is ignored, so an
// AI move computed for an older turn can never steal a newer one. This is
// what allows the menu (PASS/EXIT/...) during AI thinking.
static int s_ai_epoch = 0;
static int s_req_epoch = 0;

static Window *s_main_window;
static Layer *s_canvas_layer;

static Window *s_menu_window = NULL;
static SimpleMenuLayer *s_menu_layer = NULL;
static SimpleMenuSection menu_sections[1];
static Window *s_mode_window = NULL;
static SimpleMenuLayer *s_mode_layer = NULL;
static SimpleMenuSection mode_sections[1];
static Window *s_errmenu_window = NULL;
static SimpleMenuLayer *s_errmenu_layer = NULL;
static SimpleMenuSection errmenu_sections[1];
static SimpleMenuItem errmenu_items[2];

static void init_board_full(void);
static void ai_move_callback(void *data);
static void on_pkjs_move(int row, int col, int is_pass);
static void after_move_played(void);
static bool next_is_ai_turn(void);
static void ai_unavailable(void);
static void request_ai_move(void);
static void show_ai_error_menu(const char *reason);
static void hide_ai_error_menu(void);
static void think_timer_start(void);
static void think_timer_stop(void);
static void pause_ai_for_estimate(void);
static void resume_ai_after_estimate(void);
static void canvas_update_proc(Layer *layer, GContext *ctx);
static void handle_click(ClickRecognizerRef recognizer, void *context);
static void show_menu(void);
static void hide_menu(void);
static void show_mode_select(void);
static void hide_mode_select(void);

// ---- persisted game state ----
// Auto-saved after every move/pass/mode change and on exit; auto-loaded on
// open. New Game (or game-over dismiss) persists the fresh board, so a
// reopen never resurrects a finished game.
// Passing is strictly prohibited before this many moves have been made
// (i.e. passes are possible starting with the 41st move). Mirrored in
// pebble-js-app.js (PKJS_PASS_MIN_MOVES); the watch re-checks every reply.
#define AI_PASS_MIN_MOVES 40
#define SAVE_MAGIC 0x474F3939
#define SAVE_VERSION 1
enum {
    PKEY_MAGIC = 1,
    PKEY_VERSION,
    PKEY_BOARD,
    PKEY_KO,
    PKEY_CURRENT_PLAYER,
    PKEY_PASSES,
    PKEY_MOVES,
    PKEY_MODE,
    PKEY_LAST_ROW,
    PKEY_LAST_COL,
    PKEY_LAST_PLACED,
    PKEY_BLACK_SCORE,
    PKEY_WHITE_SCORE,
    PKEY_UI_STATE,
    PKEY_KO_ACTIVE,
};

static void save_game_state(void) {
    persist_write_int(PKEY_MAGIC, SAVE_MAGIC);
    persist_write_int(PKEY_VERSION, SAVE_VERSION);
    persist_write_data(PKEY_BOARD, board, sizeof(board));
    persist_write_data(PKEY_KO, ko_board, sizeof(ko_board));
    persist_write_int(PKEY_CURRENT_PLAYER, current_player);
    persist_write_int(PKEY_PASSES, consecutive_passes);
    persist_write_int(PKEY_MOVES, moves_made);
    persist_write_int(PKEY_MODE, game_mode);
    persist_write_int(PKEY_LAST_ROW, last_move_row);
    persist_write_int(PKEY_LAST_COL, last_move_col);
    persist_write_int(PKEY_LAST_PLACED, last_move_placed ? 1 : 0);
    persist_write_int(PKEY_BLACK_SCORE, black_score);
    persist_write_int(PKEY_WHITE_SCORE, white_score);
    persist_write_int(PKEY_UI_STATE, ui_state);
    persist_write_int(PKEY_KO_ACTIVE, ko_active ? 1 : 0);
    APP_LOG(APP_LOG_LEVEL_INFO, "game: state saved (moves=%d)", moves_made);
}

static bool load_game_state(void) {
    if (!persist_exists(PKEY_MAGIC) ||
        persist_read_int(PKEY_MAGIC) != SAVE_MAGIC)
        return false;
    if (!persist_exists(PKEY_VERSION) ||
        persist_read_int(PKEY_VERSION) != SAVE_VERSION)
        return false;
    uint8_t btmp[BOARD_SIZE * BOARD_SIZE];
    uint8_t ktmp[BOARD_SIZE * BOARD_SIZE];
    if (persist_read_data(PKEY_BOARD, btmp, sizeof(btmp)) != sizeof(btmp))
        return false;
    if (persist_read_data(PKEY_KO, ktmp, sizeof(ktmp)) != sizeof(ktmp))
        return false;
    memcpy(board, btmp, sizeof(board));
    memcpy(ko_board, ktmp, sizeof(ko_board));
    current_player = (uint8_t)persist_read_int(PKEY_CURRENT_PLAYER);
    if (current_player != BLACK && current_player != WHITE)
        current_player = BLACK;
    consecutive_passes = persist_read_int(PKEY_PASSES);
    moves_made = persist_read_int(PKEY_MOVES);
    int loaded_mode = persist_read_int(PKEY_MODE);
    game_mode = (loaded_mode < MODE_PVP || loaded_mode > MODE_AI_AI)
                    ? MODE_WHITE_AI
                    : (GameMode)loaded_mode;
    last_move_row = persist_read_int(PKEY_LAST_ROW);
    last_move_col = persist_read_int(PKEY_LAST_COL);
    last_move_placed = persist_read_int(PKEY_LAST_PLACED) != 0;
    black_score = persist_read_int(PKEY_BLACK_SCORE);
    white_score = persist_read_int(PKEY_WHITE_SCORE);
    ui_state = (UIState)persist_read_int(PKEY_UI_STATE);
    ko_active = persist_exists(PKEY_KO_ACTIVE) &&
                persist_read_int(PKEY_KO_ACTIVE) != 0;
    // A thinking/cursor state means nothing after a restart (any other
    // value, including garbage, lands here too); an AI turn is re-armed
    // by the caller. A finished game is re-shown by the caller.
    if (ui_state != GAME_OVER_STATE)
        ui_state = VIEW;
    APP_LOG(APP_LOG_LEVEL_INFO,
            "game: state loaded (moves=%d, player=%d, mode=%d)", moves_made,
            current_player, game_mode);
    return true;
}

static void init_board_full(void) {
    init_board_logic();
    selected_row = 0;
    selected_col = 0;

    if (ai_move_timer) {
        app_timer_cancel(ai_move_timer);
        ai_move_timer = NULL;
    }
    comm_cancel();
    think_timer_stop();

    if (game_mode == MODE_BLACK_AI || game_mode == MODE_AI_AI) {
        ai_move_timer = app_timer_register(300, ai_move_callback, NULL);
    }
}

// The estimate overlay is a frozen snapshot: stop any pending AI work while
// it is open (an armed timer or an in-flight pkjs request), and restart it
// on close. Without this the game would advance behind the overlay and the
// preview would go stale.
static void pause_ai_for_estimate(void) {
    if (ai_move_timer) {
        app_timer_cancel(ai_move_timer);
        ai_move_timer = NULL;
    }
    comm_cancel();
    think_timer_stop();
    s_ai_epoch++; // abandon any in-flight AI reply
    if (ui_state == AI_THINKING)
        ui_state = VIEW;
    APP_LOG(APP_LOG_LEVEL_INFO, "game: AI paused for estimate");
}

static void resume_ai_after_estimate(void) {
    APP_LOG(APP_LOG_LEVEL_INFO, "game: AI resumed after estimate");
    layer_mark_dirty(s_canvas_layer);
    after_move_played(); // re-arms the AI timer iff it is an AI turn
}

// Elapsed-time thinking banner: while AI_THINKING, a 1s timer repaints the
// canvas so the status bar counts up ("White is thinking…5s"). The tick
// stops itself whenever the state is no longer AI_THINKING.
static AppTimer *think_timer = NULL;
static time_t s_think_start = 0;

int think_elapsed_sec(void) {
    if (ui_state != AI_THINKING || s_think_start == 0)
        return 0;
    time_t now = time(NULL);
    return (now >= s_think_start) ? (int)(now - s_think_start) : 0;
}

static void think_tick(void *data) {
    (void)data;
    think_timer = NULL;
    if (ui_state != AI_THINKING)
        return;
    layer_mark_dirty(s_canvas_layer);
    think_timer = app_timer_register(1000, think_tick, NULL);
}

static void think_timer_start(void) {
    if (think_timer) {
        app_timer_cancel(think_timer);
        think_timer = NULL;
    }
    // Backdate one second so the banner shows 1s immediately, then 2s, ...
    s_think_start = time(NULL) - 1;
    think_timer = app_timer_register(1000, think_tick, NULL);
}

static void think_timer_stop(void) {
    if (think_timer) {
        app_timer_cancel(think_timer);
        think_timer = NULL;
    }
    s_think_start = 0;
}

static void do_pass_ui(void) {
    consecutive_passes++;
    ko_active = false;
    last_move_placed = false;
    // A pass during AI thinking (via the menu) retires the pending request:
    // its late reply must not play afterward.
    s_ai_epoch++;
    comm_cancel();

    if (consecutive_passes >= 2) {
        ui_state = GAME_OVER_STATE;
        compute_chinese_score();
        save_game_state();
        show_gameover_dialog(init_board_full);
        return;
    }

    current_player = (current_player == BLACK) ? WHITE : BLACK;
    ui_state = VIEW;
    save_game_state();
    after_move_played();
}

static bool try_place_stone_ui(int row, int col) {
    int idx = board_index(row, col);
    if (idx < 0)
        return false;
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
        if (board_index(nr, nc) >= 0 &&
            board[board_index(nr, nc)] == opponent) {
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
    last_move_row = row;
    last_move_col = col;
    last_move_placed = true;
    consecutive_passes = 0;
    current_player = opponent;
    ui_state = VIEW;
    s_ai_epoch++; // a placed stone retires any pending AI reply
    comm_cancel();
    save_game_state();
    return true;
}

static void after_move_played(void) {
    APP_LOG(APP_LOG_LEVEL_INFO, "game: after_move_played -> next is %s, player=%d",
            next_is_ai_turn() ? "AI" : "human", current_player);
    layer_mark_dirty(s_canvas_layer);

    if (next_is_ai_turn()) {
        if (ai_move_timer)
            app_timer_cancel(ai_move_timer);
        ai_move_timer = app_timer_register(300, ai_move_callback, NULL);
    }
}

// True when the side to move is driven by the companion AI.
static bool next_is_ai_turn(void) {
    return (game_mode == MODE_BLACK_AI && current_player == BLACK) ||
           (game_mode == MODE_WHITE_AI && current_player == WHITE) ||
           (game_mode == MODE_AI_AI);
}

// The companion is the only AI engine: when it delivers nothing (timeout,
// failed send, no Bluetooth), offer choices instead of a vanishing toast.
// BACK dismisses (any action button retries from the banner afterwards).
static void ai_unavailable(void) {
    APP_LOG(APP_LOG_LEVEL_INFO, "game: AI unavailable, offering choices");
    ui_state = VIEW;
    layer_mark_dirty(s_canvas_layer);
    show_ai_error_menu("AI unavailable");
}

static void on_pkjs_move(int row, int col, int is_pass) {
    APP_LOG(APP_LOG_LEVEL_INFO, "game: pkjs responded: (%d,%d) pass=%d", row, col, is_pass);
    if (s_req_epoch != s_ai_epoch) {
        // Stale reply: the game moved on while the AI was thinking (e.g.
        // the user passed via the menu). Never apply it.
        APP_LOG(APP_LOG_LEVEL_INFO, "game: stale pkjs reply ignored");
        return;
    }
    ui_state = VIEW;
    think_timer_stop();

    if (row < 0) {
        // Transport failure (or no Bluetooth): no local engine anymore,
        // surface it and let the user retry.
        APP_LOG(APP_LOG_LEVEL_INFO, "game: pkjs unavailable, showing error");
        if (!can_make_legal_move(current_player)) {
            do_pass_ui();
            return;
        }
        ai_unavailable();
        return;
    }

    if (is_pass == 2) {
        // The companion found no move: offer choices, don't silently pass.
        APP_LOG(APP_LOG_LEVEL_ERROR, "game: pkjs reports no move");
        layer_mark_dirty(s_canvas_layer);
        show_ai_error_menu("AI found no move");
        return;
    }

    if (is_pass || (row == MCTS_PASS_ROW && col == MCTS_PASS_COL)) {
        if (moves_made < AI_PASS_MIN_MOVES) {
            // Early passes are prohibited (defense in depth: pkjs enforces
            // the same rule, but a stale/foreign reply must not end the
            // opening either). Stay on the AI turn for a retry.
            APP_LOG(APP_LOG_LEVEL_ERROR,
                    "game: refusing early pkjs pass (moves=%d)", moves_made);
            layer_mark_dirty(s_canvas_layer);
            show_ai_error_menu("AI must not pass yet");
            return;
        }
        APP_LOG(APP_LOG_LEVEL_INFO, "game: pkjs chose PASS");
        do_pass_ui();
        layer_mark_dirty(s_canvas_layer);
        return;
    }

    APP_LOG(APP_LOG_LEVEL_INFO, "game: playing pkjs move at (%d,%d)", row, col);
    try_place_stone_ui(row, col);
    after_move_played();
}

static void ai_move_callback(void *data) {
    ai_move_timer = NULL;
    APP_LOG(APP_LOG_LEVEL_INFO, "game: ai_move_callback (player=%d, ui_state=%d)",
            current_player, ui_state);
    if (ui_state != VIEW)
        return;
    comm_cancel(); // retrying supersedes any stray in-flight request

    if (!can_make_legal_move(current_player)) {
        APP_LOG(APP_LOG_LEVEL_INFO, "game: no legal moves, passing");
        do_pass_ui();
        layer_mark_dirty(s_canvas_layer);
        return;
    }

    if (moves_made == 0 && current_player == BLACK &&
        get_stone(4, 3) == EMPTY) {
        APP_LOG(APP_LOG_LEVEL_INFO, "game: first move D5");
        try_place_stone_ui(4, 3);
        after_move_played();
        return;
    }

    if (comm_is_connected()) {
        APP_LOG(APP_LOG_LEVEL_INFO, "game: trying pkjs...");
        ui_state = AI_THINKING;
        layer_mark_dirty(s_canvas_layer);
        think_timer_start();
        s_req_epoch = ++s_ai_epoch;
        comm_request_ai_move(current_player, last_move_row, last_move_col,
                             consecutive_passes, moves_made, on_pkjs_move);
    } else {
        APP_LOG(APP_LOG_LEVEL_INFO, "game: BT disconnected, AI unavailable");
        ai_unavailable();
    }
}

// (Re)starts the AI request path; safe to call as a retry (cancels any
// armed timer first so a second request can never overlap the first).
static void request_ai_move(void) {
    if (ai_move_timer) {
        app_timer_cancel(ai_move_timer);
        ai_move_timer = NULL;
    }
    ai_move_callback(NULL);
}

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

    // Stone placement stays locked while the AI works (placing as the AI's
    // color would corrupt the turn order), but BACK always opens the menu
    // so the game never feels hung: PASS/EXIT/etc. stay available.
    if (ui_state == AI_THINKING) {
        if (button == BUTTON_ID_BACK)
            show_menu();
        return;
    }

    if (ui_state == VIEW) {
        if (button == BUTTON_ID_BACK) {
            show_menu();
        } else if (next_is_ai_turn()) {
            // AI's turn (e.g. after a failed request): any action button
            // retries the companion request.
            request_ai_move();
        } else {
            ui_state = SELECTING_ROW;
            selected_row = last_move_row;
            if (button == BUTTON_ID_UP && selected_row > 0)
                selected_row--;
            if (button == BUTTON_ID_DOWN && selected_row < MENU_ROW)
                selected_row++;
        }
    } else if (ui_state == SELECTING_ROW) {
        if (button == BUTTON_ID_UP)
            selected_row = (selected_row > 0) ? selected_row - 1 : MENU_ROW;
        else if (button == BUTTON_ID_DOWN)
            selected_row = (selected_row < MENU_ROW) ? selected_row + 1 : 0;
        else if (button == BUTTON_ID_SELECT) {
            if (selected_row == MENU_ROW)
                show_menu();
            else {
                ui_state = SELECTING_COL;
                selected_col = last_move_col;
            }
        } else if (button == BUTTON_ID_BACK)
            ui_state = VIEW;
    } else if (ui_state == SELECTING_COL) {
        if (button == BUTTON_ID_UP)
            selected_col =
                (selected_col > 0) ? selected_col - 1 : BOARD_SIZE - 1;
        else if (button == BUTTON_ID_DOWN)
            selected_col =
                (selected_col < BOARD_SIZE - 1) ? selected_col + 1 : 0;
        else if (button == BUTTON_ID_SELECT) {
            // Human placed a stone: arm the AI timer (if next is AI) exactly
            // like every other move path does. Only on success — an illegal
            // move leaves the cursor in SELECTING_COL for a retry.
            if (try_place_stone_ui(selected_row, selected_col))
                after_move_played();
        } else if (button == BUTTON_ID_BACK)
            ui_state = SELECTING_ROW;
    } else if (ui_state == GAME_OVER_STATE) {
        if (button == BUTTON_ID_SELECT || button == BUTTON_ID_BACK) {
            init_board_full();
            save_game_state(); // finished game must not resurrect on reopen
        }
    }
    layer_mark_dirty(s_canvas_layer);
}

static void menu_select_callback(int index, void *context) {
    if (index == 0)
        do_pass_ui();
    else if (index == 1) {
        hide_menu();
        show_mode_select();
        return;
    } else if (index == 2) {
        // Hints are for the human side only: suggesting (and then placing)
        // as the AI's color would corrupt the turn order. Blocked both
        // while thinking and on any AI turn.
        if (ui_state == AI_THINKING || next_is_ai_turn()) {
            hide_menu();
            show_error_dialog("Busy: AI thinking");
            return;
        }
        suggest_hint_logic(current_player, last_move_row, last_move_col, &selected_row,
                           &selected_col);
        if (selected_row >= 0)
            ui_state = SELECTING_COL;
    } else if (index == 3) {
        pause_ai_for_estimate();
        hide_menu();
        estimate_view_show(resume_ai_after_estimate);
        return;
    } else if (index == 4) {
        hide_menu();
        show_scroll_dialog(
            "Rules of Go:\n"
            "Go is a two-player, turn-based board game played on a grid, where "
            "the "
            "goal is to control more territory than the opponent.\n"
            "Black moves first, alternating turns by placing one stone on an "
            "intersection.\n"
            "Stones are captured by surrounding them, and the game ends with 2 "
            "consecutive passed turns, scoring by occupied area.\n\n"
            "• Players take turns placing a single stone on an empty "
            "intersection. "
            "Stones cannot be moved.\n"
            "• Capture (Liberties): A stone or group must have adjacent (not "
            "diagonally) empty points (liberties) to remain on the board.\n"
            "If all liberties are blocked by opponent stones, the group is "
            "removed.\n"
            "• Illegal Suicide Move: You cannot place a stone where it has no "
            "liberties unless it captures an opponent's stone(s).\n"
            "• The Ko rule prohibits immediately re-capturing a single stone "
            "if it "
            "repeats a previous board position.\n"
            "• Ending the Game: The game ends when both players pass "
            "consecutively. Passing is allowed at any time.\n"
            "• Scoring (Goal): The winner is the player with the most occupied "
            "area: territory (empty points surrounded) plus stones on board.\n"
            "• Compensation: White receives extra 7.5 points (komi) to "
            "compensate "
            "for going second.\n");
        return;
    } else if (index == 5) {
        hide_menu();
        window_stack_pop_all(true);
        return;
    }
    hide_menu();
    layer_mark_dirty(s_canvas_layer);
}

static void show_menu(void) {
    if (!s_menu_window) {
        s_menu_window = window_create();
        static SimpleMenuItem items[6];
        items[0] =
            (SimpleMenuItem){.title = "PASS", .callback = menu_select_callback};
        items[1] = (SimpleMenuItem){.title = "NEW GAME",
                                    .callback = menu_select_callback};
        items[2] =
            (SimpleMenuItem){.title = "HINT", .callback = menu_select_callback};
        items[3] = (SimpleMenuItem){.title = "ESTIMATE",
                                    .callback = menu_select_callback};
        items[4] = (SimpleMenuItem){.title = "RULES",
                                    .callback = menu_select_callback};
        items[5] =
            (SimpleMenuItem){.title = "EXIT", .callback = menu_select_callback};
        menu_sections[0] = (SimpleMenuSection){.num_items = 6, .items = items};
        s_menu_layer = simple_menu_layer_create(
            layer_get_bounds(window_get_root_layer(s_menu_window)),
            s_menu_window, menu_sections, 1, NULL);
        layer_add_child(window_get_root_layer(s_menu_window),
                        simple_menu_layer_get_layer(s_menu_layer));
    }
    window_stack_push(s_menu_window, true);
}

static void hide_menu(void) {
    if (s_menu_window)
        window_stack_remove(s_menu_window, true);
}

// Error options menu: unlike the auto-dismissing error toast, this stays
// open until the user chooses. Retry sends a fresh companion request (a new
// RNG seed, so it explores different lines); Pass plays a pass for the
// current side so the game can always move on; BACK dismisses, leaving the
// turn banner (any action button retries from there).
static void errmsg_select_callback(int index, void *context) {
    (void)context;
    hide_ai_error_menu();
    if (index == 0) {
        APP_LOG(APP_LOG_LEVEL_INFO, "game: error menu -> retry");
        request_ai_move();
    } else {
        APP_LOG(APP_LOG_LEVEL_INFO, "game: error menu -> pass");
        do_pass_ui();
        layer_mark_dirty(s_canvas_layer);
    }
}

static void show_ai_error_menu(const char *reason) {
    if (!s_errmenu_window) {
        s_errmenu_window = window_create();
        errmenu_items[0] = (SimpleMenuItem){.title = "Retry",
                                            .callback = errmsg_select_callback};
        errmenu_items[1] = (SimpleMenuItem){.title = "Pass",
                                            .subtitle = "Play pass instead",
                                            .callback = errmsg_select_callback};
        errmenu_sections[0] = (SimpleMenuSection){
            .num_items = 2, .items = errmenu_items};
        s_errmenu_layer = simple_menu_layer_create(
            layer_get_bounds(window_get_root_layer(s_errmenu_window)),
            s_errmenu_window, errmenu_sections, 1, NULL);
        layer_add_child(window_get_root_layer(s_errmenu_window),
                        simple_menu_layer_get_layer(s_errmenu_layer));
    }
    // Reason goes in the Retry subtitle: section headers don't render.
    errmenu_items[0].subtitle = reason;
    layer_mark_dirty(simple_menu_layer_get_layer(s_errmenu_layer));
    window_stack_push(s_errmenu_window, true);
}

static void hide_ai_error_menu(void) {
    if (s_errmenu_window)
        window_stack_remove(s_errmenu_window, true);
}

static void mode_select_callback(int index, void *context) {
    game_mode = (GameMode)index;
    init_board_full();
    save_game_state(); // persist the reset so reopen starts clean
    hide_mode_select();
}

static void show_mode_select(void) {
    if (!s_mode_window) {
        s_mode_window = window_create();
        static SimpleMenuItem items[4];
        items[0] = (SimpleMenuItem){.title = "Player vs Player",
                                    .callback = mode_select_callback};
        items[1] = (SimpleMenuItem){.title = "Black vs White AI",
                                    .callback = mode_select_callback};
        items[2] = (SimpleMenuItem){.title = "White vs Black AI",
                                    .callback = mode_select_callback};
        items[3] = (SimpleMenuItem){.title = "AI vs AI",
                                    .callback = mode_select_callback};
        mode_sections[0] = (SimpleMenuSection){.num_items = 4, .items = items};
        s_mode_layer = simple_menu_layer_create(
            layer_get_bounds(window_get_root_layer(s_mode_window)),
            s_mode_window, mode_sections, 1, NULL);
        layer_add_child(window_get_root_layer(s_mode_window),
                        simple_menu_layer_get_layer(s_mode_layer));
    }
    window_stack_push(s_mode_window, true);
}

static void hide_mode_select(void) {
    if (s_mode_window)
        window_stack_remove(s_mode_window, true);
}

static void window_load(Window *window) {
    s_canvas_layer =
        layer_create(layer_get_bounds(window_get_root_layer(window)));
    layer_set_update_proc(s_canvas_layer, canvas_update_proc);
    layer_add_child(window_get_root_layer(window), s_canvas_layer);
    window_set_click_config_provider(
        window, (ClickConfigProvider)click_config_provider);
    dialogs_init(s_canvas_layer);
}

static void window_unload(Window *window) { layer_destroy(s_canvas_layer); }

static void init(void) {
    mcts_init_zobrist();
    comm_init();
    init_board_full();
    s_main_window = window_create();
    window_set_window_handlers(
        s_main_window,
        (WindowHandlers){.load = window_load, .unload = window_unload});
    window_stack_push(s_main_window, true);
    if (load_game_state()) {
        layer_mark_dirty(s_canvas_layer);
        if (ui_state == GAME_OVER_STATE) {
            compute_chinese_score();
            show_gameover_dialog(init_board_full);
        } else {
            // ui_state is VIEW here (normalized by load); re-arm the AI
            // timer iff the restored turn belongs to the AI.
            after_move_played();
        }
    }
}

static void deinit(void) {
    // EXIT is reachable while the AI thinks: disarm everything first so
    // no timer/phone callback can fire on torn-down windows and layers.
    if (ai_move_timer) {
        app_timer_cancel(ai_move_timer);
        ai_move_timer = NULL;
    }
    think_timer_stop();
    comm_cancel();
    save_game_state();
    window_destroy(s_main_window);
}

int main(void) {
    init();
    app_event_loop();
    deinit();
    return 0;
}
