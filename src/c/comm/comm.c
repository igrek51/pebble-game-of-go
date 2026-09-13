#include "comm.h"
#include "../ai/mcts.h"
#include "../logic/board.h"

static comm_ai_move_callback s_pending_callback = NULL;
static AppTimer *s_timeout_timer = NULL;
static bool s_request_active = false;

static void comm_trigger_fallback(void) {
    if (!s_request_active) {
        APP_LOG(APP_LOG_LEVEL_INFO, "comm: fallback skipped (no active request)");
        return;
    }
    s_request_active = false;
    if (s_timeout_timer) {
        app_timer_cancel(s_timeout_timer);
        s_timeout_timer = NULL;
    }
    APP_LOG(APP_LOG_LEVEL_INFO, "comm: FALLBACK to local MCTS (pkjs unavailable/timed out)");
    comm_ai_move_callback cb = s_pending_callback;
    s_pending_callback = NULL;
    cb(-1, -1, false);
}

// Never read t->value->int32 without a type check first: the union field is
// only valid for TUPLE_INT/TUPLE_UINT. Unchecked reads on cstring/byte-array
// tuples crash or misbehave (same class of bug as the timely-plus
// watchface strtol crash).
static bool tuple_get_int(const Tuple *t, int *out) {
    if (!t || !out)
        return false;
    if (t->type != TUPLE_INT && t->type != TUPLE_UINT)
        return false;
    *out = t->value->int32;
    return true;
}
static void comm_timeout_handler(void *data) {
    s_timeout_timer = NULL;
    APP_LOG(APP_LOG_LEVEL_INFO, "comm: TIMEOUT after %dms", COMM_TIMEOUT_MS);
    comm_trigger_fallback();
}

static void comm_inbox_handler(DictionaryIterator *iter, void *context) {
    if (!s_request_active) {
        APP_LOG(APP_LOG_LEVEL_DEBUG, "comm: inbox msg ignored (no active request)");
        return;
    }

    Tuple *type_tuple = dict_find(iter, 0);
    int msg_type = -1;
    if (!tuple_get_int(type_tuple, &msg_type) || msg_type != 1) {
        APP_LOG(APP_LOG_LEVEL_DEBUG, "comm: inbox msg ignored (type=%d)", msg_type);
        return;
    }

    if (s_timeout_timer) {
        app_timer_cancel(s_timeout_timer);
        s_timeout_timer = NULL;
    }

    Tuple *row_tuple = dict_find(iter, 1);
    Tuple *col_tuple = dict_find(iter, 2);
    Tuple *pass_tuple = dict_find(iter, 3);

    int row = 0, col = 0, pass_int = 0;
    tuple_get_int(pass_tuple, &pass_int);
    if (!tuple_get_int(row_tuple, &row) || !tuple_get_int(col_tuple, &col)) {
        // Malformed reply: fail fast to local MCTS instead of sitting in
        // AI_THINKING (buttons dead) until the 4s timeout fires.
        APP_LOG(APP_LOG_LEVEL_ERROR, "comm: inbox msg missing/invalid row/col, fallback");
        s_request_active = false;
        comm_ai_move_callback malformed_cb = s_pending_callback;
        s_pending_callback = NULL;
        malformed_cb(-1, -1, false);
        return;
    }

    s_request_active = false;
    comm_ai_move_callback cb = s_pending_callback;
    s_pending_callback = NULL;

    bool is_pass = (pass_int != 0);

    if (row == MCTS_PASS_ROW && col == MCTS_PASS_COL)
        is_pass = true;

    APP_LOG(APP_LOG_LEVEL_INFO, "comm: GOT MOVE from pkjs: (%d,%d) pass=%d", row, col, is_pass);
    cb(row, col, is_pass);
}

static void comm_outbox_sent_handler(DictionaryIterator *iter, void *context) {
    APP_LOG(APP_LOG_LEVEL_DEBUG, "comm: outbox sent OK");
}

static void comm_outbox_failed_handler(DictionaryIterator *iter,
                                       AppMessageResult reason, void *context) {
    APP_LOG(APP_LOG_LEVEL_INFO, "comm: outbox FAILED (reason=%d)", reason);
    comm_trigger_fallback();
}

static void comm_inbox_dropped_handler(AppMessageResult reason, void *context) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "comm: inbox DROPPED (reason=%d)", reason);
}

void comm_init(void) {
    APP_LOG(APP_LOG_LEVEL_INFO, "comm: init (buffers 1024/1024)");
    app_message_register_inbox_received(comm_inbox_handler);
    app_message_register_inbox_dropped(comm_inbox_dropped_handler);
    app_message_register_outbox_sent(comm_outbox_sent_handler);
    app_message_register_outbox_failed(comm_outbox_failed_handler);
    app_message_open(1024, 1024);
}

bool comm_is_connected(void) {
    bool bt = bluetooth_connection_service_peek();
    APP_LOG(APP_LOG_LEVEL_DEBUG, "comm: BT connected=%d", bt);
    return bt;
}

void comm_request_ai_move(uint8_t current_player, int last_row, int last_col,
                          int consecutive_passes,
                          comm_ai_move_callback callback) {
    APP_LOG(APP_LOG_LEVEL_INFO, "comm: request AI move (player=%d last=(%d,%d) passes=%d)",
            current_player, last_row, last_col, consecutive_passes);

    if (!bluetooth_connection_service_peek()) {
        APP_LOG(APP_LOG_LEVEL_INFO, "comm: no BT, immediate fallback");
        callback(-1, -1, false);
        return;
    }

    s_request_active = true;
    s_pending_callback = callback;

    DictionaryIterator *iter;
    AppMessageResult result = app_message_outbox_begin(&iter);
    if (result != APP_MSG_OK) {
        APP_LOG(APP_LOG_LEVEL_INFO, "comm: outbox_begin failed (%d), fallback", result);
        s_request_active = false;
        s_pending_callback = NULL;
        callback(-1, -1, false);
        return;
    }

    APP_LOG(APP_LOG_LEVEL_DEBUG, "comm: packing board state...");
    dict_write_int32(iter, 0, 0);
    dict_write_int32(iter, 1, current_player);
    dict_write_int32(iter, 2, last_row);
    dict_write_int32(iter, 3, last_col);
    dict_write_int32(iter, 4, consecutive_passes);

    dict_write_data(iter, 5, board, BOARD_SIZE * BOARD_SIZE);

    uint8_t ko_bytes[BOARD_SIZE * BOARD_SIZE + 1];
    memcpy(ko_bytes, ko_board, BOARD_SIZE * BOARD_SIZE);
    ko_bytes[BOARD_SIZE * BOARD_SIZE] = ko_active ? 1 : 0;
    dict_write_data(iter, 6, ko_bytes, sizeof(ko_bytes));

    result = app_message_outbox_send();
    if (result != APP_MSG_OK) {
        APP_LOG(APP_LOG_LEVEL_INFO, "comm: outbox_send failed (%d), fallback", result);
        s_request_active = false;
        s_pending_callback = NULL;
        callback(-1, -1, false);
        return;
    }

    APP_LOG(APP_LOG_LEVEL_DEBUG, "comm: msg sent, timeout in %dms", COMM_TIMEOUT_MS);
    s_timeout_timer =
        app_timer_register(COMM_TIMEOUT_MS, comm_timeout_handler, NULL);
}

void comm_cancel(void) {
    APP_LOG(APP_LOG_LEVEL_DEBUG, "comm: cancel");
    if (s_timeout_timer) {
        app_timer_cancel(s_timeout_timer);
        s_timeout_timer = NULL;
    }
    s_pending_callback = NULL;
    s_request_active = false;
}
