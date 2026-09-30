#include "game_state.h"
#include "logic/board.h"
#include <string.h>

uint8_t current_player = BLACK;
int consecutive_passes = 0;
int moves_made = 0;
int black_score = 0;
int white_score = 0;
// Server score estimate (type-2 message): valid only while the game state
// still matches the (moves, passes) it was computed for.
int server_score_10x = 0;
int server_score_pct = 50;
int server_score_moves = -1;
int server_score_passes = -1;
// Ownership map from /score: Black-relative -100..100 per point, valid
// only together with the score above (same freshness keys).
static int8_t server_own[BOARD_SIZE * BOARD_SIZE];
static bool server_own_valid = false;
// Set when the latest estimate attempt for the current position failed
// (all retries exhausted): render "-" instead of the "..." loading mark.
// Cleared by any success, new demand, or position change.
bool server_score_failed = false;
UIState ui_state = VIEW;
GameMode game_mode = MODE_WHITE_AI;
int last_move_row = 4;
int last_move_col = 4;
bool last_move_placed = false;
bool terr_estimate_on = false;
// AI engine setting (Settings menu, persisted, default MCTS). Applies to
// new companion requests; not reset by New Game.
int ai_engine = AI_ENGINE_MCTS;
// Katago level (Settings, persisted, default 12k): index into the
// rank-profile table below. Only used with AI_ENGINE_KATAGO.
int katago_level = 0;

static const char *const katago_profiles[] = {
    "rank_12k", "rank_10k", "rank_8k",
};

const char *katago_profile(void) {
    int n = (int)(sizeof(katago_profiles) / sizeof(katago_profiles[0]));
    if (katago_level < 0 || katago_level >= n)
        katago_level = 0;
    return katago_profiles[katago_level];
}

int katago_level_count(void) {
    return (int)(sizeof(katago_profiles) / sizeof(katago_profiles[0]));
}

// Move history for Undo: 0-80 stone position, -1 pass, RAM-only. Stones
// recorded on placement, passes on pass. Replay rebuilds captures/ko
// exactly (same commit order as play), on top of the session base below.
#define MOVE_HIST_MAX 300
static int8_t move_hist[MOVE_HIST_MAX];
static int move_hist_len = 0;
// False only after a recording overflow: replay would resurrect a wrong
// position, so Undo refuses instead of corrupting the board.
static bool hist_complete = true;
// Session base: the position the current session started from (empty on
// new game, loaded stones on a restore). Only session moves are
// retractable; older stones are never touched.
static uint8_t base_board[BOARD_SIZE * BOARD_SIZE];
static uint8_t base_ko[BOARD_SIZE * BOARD_SIZE];
static bool base_ko_active = false;
static uint8_t base_player = BLACK;
static int base_passes = 0;
static int base_moves = 0;
static int base_last_row = 4;
static int base_last_col = 4;
static bool base_last_placed = false;

void hist_snapshot(void) {
    memcpy(base_board, board, sizeof(board));
    memcpy(base_ko, ko_board, sizeof(ko_board));
    base_ko_active = ko_active;
    base_player = current_player;
    base_passes = consecutive_passes;
    base_moves = moves_made;
    base_last_row = last_move_row;
    base_last_col = last_move_col;
    base_last_placed = last_move_placed;
    move_hist_len = 0;
    hist_complete = true;
}

void hist_record(int pos) {
    if (move_hist_len < MOVE_HIST_MAX) {
        move_hist[move_hist_len++] = (int8_t)pos;
    } else {
        hist_complete = false;
    }
}

int hist_len(void) {
    return move_hist_len;
}

bool hist_can_undo(void) {
    return hist_complete && move_hist_len > 0;
}

static void rebuild_plies(int n);

void undo_to_len(int keep) {
    if (keep < 0)
        keep = 0;
    if (keep > move_hist_len)
        keep = move_hist_len;
    move_hist_len = keep;
    rebuild_plies(keep);
}

// Shown-position rebuild for replay mode: same as undo but WITHOUT
// truncating the history, so stepping back and forth is lossless.
int replay_shown = 0;

void replay_show_len(int show) {
    if (show < 0)
        show = 0;
    if (show > move_hist_len)
        show = move_hist_len;
    replay_shown = show;
    rebuild_plies(show);
}

static void rebuild_plies(int n) {
    // Restart from the session base, then replay the retained session
    // moves (same commit order as play, so captures/ko rebuild exactly).
    memcpy(board, base_board, sizeof(board));
    memcpy(ko_board, base_ko, sizeof(ko_board));
    ko_active = base_ko_active;
    current_player = base_player;
    consecutive_passes = base_passes;
    moves_made = base_moves;
    last_move_row = base_last_row;
    last_move_col = base_last_col;
    last_move_placed = base_last_placed;
    server_score_moves = -1;
    server_score_failed = false;
    static const int dr[] = {-1, 1, 0, 0};
    static const int dc[] = {0, 0, -1, 1};
    uint8_t turn = current_player; // base side to move, restored above
    for (int i = 0; i < n; i++) {
        int pos = move_hist[i];
        if (pos < 0) {
            consecutive_passes++;
            last_move_placed = false;
        } else {
            uint8_t temp[BOARD_SIZE * BOARD_SIZE];
            memcpy(temp, board, sizeof(board));
            int row = pos / BOARD_SIZE, col = pos % BOARD_SIZE;
            uint8_t opp = (turn == BLACK) ? WHITE : BLACK;
            board[pos] = turn;
            bool any_captured = false;
            for (int d = 0; d < 4; d++) {
                int nr = row + dr[d], nc = col + dc[d];
                if (board_index(nr, nc) >= 0 &&
                    board[board_index(nr, nc)] == opp &&
                    count_liberties(nr, nc, opp) == 0) {
                    remove_group(nr, nc, opp);
                    any_captured = true;
                }
            }
            memcpy(ko_board, temp, sizeof(board));
            ko_active = any_captured;
            moves_made++;
            last_move_row = row;
            last_move_col = col;
            last_move_placed = true;
            consecutive_passes = 0;
        }
        turn = (turn == BLACK) ? WHITE : BLACK;
    }
    current_player = turn;
}

void init_board_logic(void) {
    memset(board, EMPTY, sizeof(board));
    memset(ko_board, EMPTY, sizeof(ko_board));
    current_player = BLACK;
    ko_active = false;
    consecutive_passes = 0;
    moves_made = 0;
    black_score = 0;
    white_score = 0;
    ui_state = VIEW;
    last_move_row = 4;
    last_move_col = 4;
    last_move_placed = false;
    move_hist_len = 0;
    hist_complete = true;
    hist_snapshot();
    server_score_10x = 0;
    server_score_pct = 50;
    server_score_moves = -1;
    server_score_passes = -1;
    server_score_failed = false;
}

void server_score_set(int score_10x, int black_pct, int for_moves,
                      int for_passes, const uint8_t *own_raw) {
    server_score_10x = score_10x;
    server_score_pct = black_pct;
    server_score_moves = for_moves;
    server_score_passes = for_passes;
    server_score_failed = false;
    if (own_raw) {
        for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
            server_own[i] = (int8_t)(own_raw[i] - 100);
        server_own_valid = true;
    } else {
        server_own_valid = false;
    }
}

bool server_score_fresh(int *s10_out, int *pct_out) {
    if (server_score_moves == moves_made &&
        server_score_passes == consecutive_passes) {
        if (s10_out)
            *s10_out = server_score_10x;
        if (pct_out)
            *pct_out = server_score_pct;
        return true;
    }
    return false;
}

// Server ownership map (Black-relative -100..100), or NULL when absent
// or stale. Callers threshold it (|v|>=20 owned) for tinting.
const int8_t *server_owner_map(void) {
    if (server_own_valid && server_score_moves == moves_made &&
        server_score_passes == consecutive_passes)
        return server_own;
    return NULL;
}
