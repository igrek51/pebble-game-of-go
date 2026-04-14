#include <pebble.h>
#include <math.h>

#define BOARD_SIZE 9
#define EMPTY 0
#define BLACK 1
#define WHITE 2

#define CELL_SIZE 19
#define STONE_RADIUS 6

// Bigger board with breathing room from coordinates: 9 * 19 = 171px
// Space for row labels on left + gap, space for column labels on top + gap
#define BOARD_ORIGIN_X 22  // Moved right to separate from row numbers
#define BOARD_ORIGIN_Y 48  // Moved down to separate from column letters
#define MENU_ROW 9         // Virtual row index for the "..." pass/menu row

// UI States
typedef enum {
    VIEW,           // Just viewing board, no selection
    SELECTING_ROW,  // Selecting row (0-8 = board, 9 = menu)
    SELECTING_COL,  // Selecting column
    GAME_OVER       // Score display
} UIState;

// Colors
#define COLOR_BOARD GColorChromeYellow      // Golden tan (wooden board appearance)
#define COLOR_GRID GColorDarkGray           // Dark gray for grid, hoshi, and labels
#define COLOR_BLACK_STONE GColorBlack
#define COLOR_WHITE_STONE GColorWhite
#define COLOR_CURSOR_COL GColorWhite    // Very light square for column selection (matches row highlight)
#define COLOR_HIGHLIGHT GColorWhite     // Very light highlight
#define COLOR_BG GColorChromeYellow         // Match board color
#define COLOR_STATUS_BG GColorBlue
#define COLOR_TEXT GColorWhite

// Game mode
typedef enum {
    MODE_PVP,      // Player vs Player
    MODE_BLACK_AI, // Black is AI
    MODE_WHITE_AI, // White is AI
    MODE_AI_AI     // AI vs AI
} GameMode;

static GameMode game_mode = MODE_WHITE_AI;  // Default: Black (human) vs AI (White)
static AppTimer *ai_move_timer = NULL;

// Game state
static uint8_t board[BOARD_SIZE * BOARD_SIZE];
static uint8_t current_player = BLACK;

// UI state
static int selected_row = 0;
static int selected_col = 0;
static int last_row = 0;  // Remember the last row used for a move
static int last_col = 0;  // Remember the last column used for a move
static UIState ui_state = VIEW;
static UIState previous_state = VIEW;

// Ko rule
static uint8_t ko_board[BOARD_SIZE * BOARD_SIZE];
static bool ko_active = false;

// Pass tracking
static int consecutive_passes = 0;

// Game over scores
static int black_score = 0;
static int white_score = 0;

// Ko message overlay
static AppTimer *ko_timer = NULL;
static bool show_ko_msg = false;

// Window & layer
static Window *s_main_window;
static Layer *s_canvas_layer;

// Menu window and layer
static Window *s_menu_window = NULL;
static SimpleMenuLayer *s_menu_layer = NULL;
static SimpleMenuSection menu_sections[1];

// Mode selection menu
static Window *s_mode_window = NULL;
static SimpleMenuLayer *s_mode_layer = NULL;
static SimpleMenuSection mode_sections[1];

// Dialog windows
static Window *s_dialog_window = NULL;
static Window *s_gameover_dialog = NULL;
static Window *s_error_dialog = NULL;
static AppTimer *s_error_timer = NULL;

// ============================================================
// MCTS AI Implementation
// ============================================================

// MCTS node structure (12 bytes)
typedef struct {
    uint16_t visits;
    uint16_t wins;
    uint16_t first_child_idx;   // 0xFFFF = no children
    uint16_t next_sibling_idx;  // 0xFFFF = no sibling
    uint8_t move_row;           // 9 = pass
    uint8_t move_col;           // 9 = pass
    uint8_t move_player;        // BLACK or WHITE
    uint8_t _pad;
} MCTSNode;

#define MCTS_POOL_SIZE 800          // Increased from 300 for deeper search tree
#define MCTS_NO_NODE 0xFFFF
#define MCTS_PASS_ROW 9
#define MCTS_PASS_COL 9
#define MCTS_ITERATIONS 80          // Increased from 20 for more thorough search
#define MCTS_MAX_PLAYOUT 150        // Increased from 100 for deeper simulations

static MCTSNode mcts_pool[MCTS_POOL_SIZE];
static uint16_t mcts_pool_used = 0;

// Zobrist hashing
static uint32_t zobrist_table[BOARD_SIZE * BOARD_SIZE][3];
static uint32_t rng_state = 12345;

// Simulation board state (for tree traversal)
static uint8_t sim_board[BOARD_SIZE * BOARD_SIZE];
static uint8_t sim_ko_board[BOARD_SIZE * BOARD_SIZE];
static bool sim_ko_active;
static uint8_t sim_player;
static int sim_last_row, sim_last_col;
static int sim_passes;

// Playout board state (for simulation from leaf)
static uint8_t play_board[BOARD_SIZE * BOARD_SIZE];
static uint8_t play_ko_board[BOARD_SIZE * BOARD_SIZE];
static bool play_ko_active;
static uint8_t play_player;
static int play_last_row, play_last_col;
static int play_passes;

// Forward declarations
static void mcts_init_zobrist(void);
static void canvas_update_proc(Layer *layer, GContext *ctx);
static void handle_click(ClickRecognizerRef recognizer, void *context);
static void handle_long_click(ClickRecognizerRef recognizer, void *context);
static void compute_chinese_score(void);
static void do_pass(void);
static int count_liberties(int start_row, int start_col, uint8_t color);
static void remove_group(int start_row, int start_col, uint8_t color);
static void show_menu(void);
static void hide_menu(void);
static void menu_select_callback(int index, void *context);
static void show_mode_select(void);
static void hide_mode_select(void);
static void mode_select_callback(int index, void *context);
static void try_make_ai_move(void);
static void ai_move_callback(void *data);
static void show_dialog(const char *message);
static void hide_dialog(void);
static void show_gameover_dialog(void);
static void hide_gameover_dialog(void);
static void show_error_dialog(const char *message);
static void hide_error_dialog(void);

// Initialize board
static void init_board(void) {
    memset(board, EMPTY, sizeof(board));
    memset(ko_board, EMPTY, sizeof(ko_board));
    current_player = BLACK;
    selected_row = 0;
    selected_col = 0;
    last_row = 4;  // Center of board for AI to consider
    last_col = 4;
    ui_state = VIEW;
    previous_state = VIEW;
    ko_active = false;
    consecutive_passes = 0;
    black_score = 0;
    white_score = 0;
    show_ko_msg = false;
    if (ko_timer) {
        app_timer_cancel(ko_timer);
        ko_timer = NULL;
    }
    if (ai_move_timer) {
        app_timer_cancel(ai_move_timer);
        ai_move_timer = NULL;
    }

    // Start AI move if Black is AI or in AI vs AI mode
    if (game_mode == MODE_BLACK_AI || game_mode == MODE_AI_AI) {
        ai_move_timer = app_timer_register(500, ai_move_callback, NULL);
    }
}

// Get/set stone
static inline int board_index(int row, int col) {
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
        return -1;
    }
    return row * BOARD_SIZE + col;
}

static uint8_t get_stone(int row, int col) {
    int idx = board_index(row, col);
    if (idx < 0) return -1;
    return board[idx];
}

static void set_stone(int row, int col, uint8_t color) {
    int idx = board_index(row, col);
    if (idx >= 0) {
        board[idx] = color;
    }
}

// Shared DFS arrays for liberty counting (reused by multiple functions)
static bool _dfs_visited[BOARD_SIZE * BOARD_SIZE];
static int _dfs_stack_r[BOARD_SIZE * BOARD_SIZE];
static int _dfs_stack_c[BOARD_SIZE * BOARD_SIZE];

// Count liberties for a group on any board using iterative DFS
static int count_liberties_on(uint8_t *b, int start_row, int start_col, uint8_t color) {
    memset(_dfs_visited, 0, sizeof(_dfs_visited));
    int liberties = 0;
    int top = 0;

    int start_idx = board_index(start_row, start_col);
    if (start_idx < 0 || b[start_idx] != color) return 0;

    _dfs_stack_r[top] = start_row;
    _dfs_stack_c[top] = start_col;
    top++;
    _dfs_visited[start_idx] = true;

    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};

    while (top > 0) {
        top--;
        int r = _dfs_stack_r[top];
        int c = _dfs_stack_c[top];

        for (int d = 0; d < 4; d++) {
            int nr = r + dr[d];
            int nc = c + dc[d];
            int nidx = board_index(nr, nc);
            if (nidx < 0) continue;
            if (_dfs_visited[nidx]) continue;

            uint8_t ns = b[nidx];
            if (ns == EMPTY) {
                liberties++;
                _dfs_visited[nidx] = true;
            } else if (ns == color) {
                _dfs_visited[nidx] = true;
                _dfs_stack_r[top] = nr;
                _dfs_stack_c[top] = nc;
                top++;
            }
        }
    }
    return liberties;
}

// Wrapper for global board (backward compat)
static int count_liberties(int start_row, int start_col, uint8_t color) {
    return count_liberties_on(board, start_row, start_col, color);
}

// Remove captured group on any board
static void remove_group_on(uint8_t *b, int start_row, int start_col, uint8_t color) {
    memset(_dfs_visited, 0, sizeof(_dfs_visited));
    int top = 0;

    _dfs_stack_r[top] = start_row;
    _dfs_stack_c[top] = start_col;
    top++;
    _dfs_visited[board_index(start_row, start_col)] = true;

    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};

    while (top > 0) {
        top--;
        int r = _dfs_stack_r[top];
        int c = _dfs_stack_c[top];
        int idx = board_index(r, c);
        if (idx >= 0) b[idx] = EMPTY;

        for (int d = 0; d < 4; d++) {
            int nr = r + dr[d];
            int nc = c + dc[d];
            int nidx = board_index(nr, nc);
            if (nidx < 0) continue;
            if (_dfs_visited[nidx]) continue;
            if (b[nidx] == color) {
                _dfs_visited[nidx] = true;
                _dfs_stack_r[top] = nr;
                _dfs_stack_c[top] = nc;
                top++;
            }
        }
    }
}

// Wrapper for global board (backward compat)
static void remove_group(int start_row, int start_col, uint8_t color) {
    remove_group_on(board, start_row, start_col, color);
}

// Pass action
static void do_pass(void) {
    consecutive_passes++;
    ko_active = false;  // Pass clears Ko

    if (consecutive_passes >= 2) {
        // Two consecutive passes: compute score and show game over dialog
        compute_chinese_score();
        show_gameover_dialog();
        return;
    }

    // Switch player and return to view
    current_player = (current_player == BLACK) ? WHITE : BLACK;
    ui_state = VIEW;
}

// Try to place a stone with capture detection, suicide check, and Ko rule
static bool try_place_stone(int row, int col) {
    int idx = board_index(row, col);
    if (idx < 0) return false;
    if (board[idx] != EMPTY) {
        show_error_dialog("Cell occupied!");
        return false;
    }

    uint8_t opponent = (current_player == BLACK) ? WHITE : BLACK;

    // Save Ko snapshot before placing
    uint8_t temp_board[BOARD_SIZE * BOARD_SIZE];
    memcpy(temp_board, board, sizeof(board));

    // Place stone tentatively
    board[idx] = current_player;

    // Capture opponent groups with 0 liberties
    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};
    bool any_captured = false;
    for (int d = 0; d < 4; d++) {
        int nr = row + dr[d];
        int nc = col + dc[d];
        int nidx = board_index(nr, nc);
        if (nidx < 0) continue;
        if (board[nidx] == opponent) {
            if (count_liberties(nr, nc, opponent) == 0) {
                remove_group(nr, nc, opponent);
                any_captured = true;
            }
        }
    }

    // Suicide check: if our newly placed group has 0 liberties after captures
    if (count_liberties(row, col, current_player) == 0) {
        // Restore board (suicide is illegal)
        memcpy(board, temp_board, sizeof(board));
        return false;
    }

    // Ko check: does post-capture board equal the ko_board snapshot?
    if (ko_active && memcmp(board, ko_board, sizeof(board)) == 0) {
        // Ko violation — restore and show dialog
        memcpy(board, temp_board, sizeof(board));
        show_dialog("Ko! Illegal move");
        return false;
    }

    // Commit: save current board as new ko_board
    memcpy(ko_board, temp_board, sizeof(board));  // previous state = ko trigger candidate
    ko_active = any_captured;   // Ko only relevant if a capture occurred

    last_row = row;
    last_col = col;
    consecutive_passes = 0;
    current_player = opponent;
    previous_state = VIEW;
    ui_state = VIEW;
    selected_row = 0;
    selected_col = 0;

    // Schedule AI move if it's AI's turn
    bool next_is_ai = (game_mode == MODE_BLACK_AI && current_player == BLACK) ||
                      (game_mode == MODE_WHITE_AI && current_player == WHITE);
    if (next_is_ai) {
        if (ai_move_timer) app_timer_cancel(ai_move_timer);
        ai_move_timer = app_timer_register(500, ai_move_callback, NULL);
    }

    return true;
}

/// Calculate live score estimate using proximity heuristics
// Returns difference * 10 (positive = Black ahead, negative = White ahead)
// Avoids floating point: returns 75 instead of 7.5
static int estimate_score_10x(void) {
    int black_stones = 0, white_stones = 0;
    int black_territory_10x = 0, white_territory_10x = 0;

    // Count stones
    for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (board[i] == BLACK) black_stones++;
        else if (board[i] == WHITE) white_stones++;
    }

    // For each empty cell, determine weighted ownership by proximity
    for (int row = 0; row < BOARD_SIZE; row++) {
        for (int col = 0; col < BOARD_SIZE; col++) {
            int idx = board_index(row, col);
            if (board[idx] != EMPTY) continue;

            // Find nearest black and white stones using Manhattan distance
            int min_black_dist = 999;
            int min_white_dist = 999;

            for (int r = 0; r < BOARD_SIZE; r++) {
                for (int c = 0; c < BOARD_SIZE; c++) {
                    int stone_idx = board_index(r, c);
                    int dist = abs(row - r) + abs(col - c);

                    if (board[stone_idx] == BLACK && dist < min_black_dist) {
                        min_black_dist = dist;
                    }
                    if (board[stone_idx] == WHITE && dist < min_white_dist) {
                        min_white_dist = dist;
                    }
                }
            }

            // Calculate weighted territory value based on distance
            // Linear scale: distance 1 = 1.0, distance 9 = 0.2
            // value = 1.0 - (dist - 1) * 0.1, clamped to [0.2, 1.0]
            int black_value = (min_black_dist <= 0) ? 10 : (10 - (min_black_dist - 1));
            int white_value = (min_white_dist <= 0) ? 10 : (10 - (min_white_dist - 1));

            if (black_value < 2) black_value = 2;  // Minimum 0.2
            if (white_value < 2) white_value = 2;

            // Assign territory based on nearest stone (weighted by distance)
            if (min_black_dist < min_white_dist) {
                black_territory_10x += black_value;
            } else if (min_white_dist < min_black_dist) {
                white_territory_10x += white_value;
            }
            // If equidistant, neutral (not counted)
        }
    }

    // All calculations in 10x scale
    // Stones count as 10 (1.0), territory is already in 10x scale
    int black_score_10x = (black_stones * 10) + black_territory_10x;
    int white_score_10x = (white_stones * 10) + white_territory_10x + 75;

    return black_score_10x - white_score_10x;
}

// ============================================================
// MCTS Helper Functions
// ============================================================

// Initialize Zobrist table using LCG
static void mcts_init_zobrist(void) {
    rng_state = 2463534242UL;  // Initial seed
    for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        for (int c = 0; c < 3; c++) {
            rng_state = rng_state * 1664525 + 1013904223;
            zobrist_table[i][c] = rng_state;
        }
    }
}

// Random number generator (LCG)
static uint32_t mcts_rng(void) {
    rng_state = rng_state * 1664525 + 1013904223;
    return rng_state;
}

// Allocate a node from the pool
static uint16_t mcts_alloc(uint8_t move_row, uint8_t move_col, uint8_t player) {
    if (mcts_pool_used >= MCTS_POOL_SIZE) return MCTS_NO_NODE;
    uint16_t idx = mcts_pool_used++;
    mcts_pool[idx].visits = 0;
    mcts_pool[idx].wins = 0;
    mcts_pool[idx].first_child_idx = MCTS_NO_NODE;
    mcts_pool[idx].next_sibling_idx = MCTS_NO_NODE;
    mcts_pool[idx].move_row = move_row;
    mcts_pool[idx].move_col = move_col;
    mcts_pool[idx].move_player = player;
    mcts_pool[idx]._pad = 0;
    return idx;
}

// UCT score = wins/visits + C*sqrt(ln(parent_visits)/visits)
static float mcts_uct(uint16_t child_idx, uint16_t parent_visits) {
    if (child_idx == MCTS_NO_NODE) return -999999.0f;
    MCTSNode *node = &mcts_pool[child_idx];
    if (node->visits == 0) return 999999.0f;  // Unvisited children have highest priority

    float exploit = (float)node->wins / (float)node->visits;
    float explore = 1.414f * sqrtf(logf((float)parent_visits) / (float)node->visits);
    return exploit + explore;
}

// Get legal moves for a board (filled with all legal moves)
static int get_legal_moves_on(uint8_t *b, uint8_t *ko_b, bool ko_active,
                                uint8_t player, uint8_t *move_rows, uint8_t *move_cols) {
    uint8_t opponent = (player == BLACK) ? WHITE : BLACK;
    int count = 0;

    for (int row = 0; row < BOARD_SIZE; row++) {
        for (int col = 0; col < BOARD_SIZE; col++) {
            int idx = board_index(row, col);
            if (b[idx] != EMPTY) continue;

            // Try placing stone here
            uint8_t temp_b[BOARD_SIZE * BOARD_SIZE];
            memcpy(temp_b, b, sizeof(temp_b));
            temp_b[idx] = player;

            // Check captures
            const int dr[] = {-1, 1, 0, 0};
            const int dc[] = {0, 0, -1, 1};
            for (int d = 0; d < 4; d++) {
                int nr = row + dr[d];
                int nc = col + dc[d];
                int nidx = board_index(nr, nc);
                if (nidx < 0) continue;
                if (temp_b[nidx] == opponent && count_liberties_on(temp_b, nr, nc, opponent) == 0) {
                    remove_group_on(temp_b, nr, nc, opponent);
                }
            }

            // Check if legal (not suicide)
            if (count_liberties_on(temp_b, row, col, player) > 0) {
                // Check Ko
                if (ko_active && memcmp(temp_b, ko_b, sizeof(temp_b)) == 0) {
                    continue;  // Ko violation
                }
                move_rows[count] = row;
                move_cols[count] = col;
                count++;
            }
        }
    }

    // Add pass
    if (count < 81) {
        move_rows[count] = MCTS_PASS_ROW;
        move_cols[count] = MCTS_PASS_COL;
        count++;
    }

    // Shuffle moves (simple Fisher-Yates)
    for (int i = count - 1; i > 0; i--) {
        int j = (mcts_rng() >> 16) % (i + 1);
        uint8_t tr = move_rows[i], tc = move_cols[i];
        move_rows[i] = move_rows[j];
        move_cols[i] = move_cols[j];
        move_rows[j] = tr;
        move_cols[j] = tc;
    }

    return count;
}

// Try to place stone on given board, returns success
static bool sim_try_place(uint8_t *b, uint8_t *ko_b, bool *ko_active,
                           uint8_t player, int row, int col) {
    if (row == MCTS_PASS_ROW && col == MCTS_PASS_COL) {
        return true;  // Pass is always legal
    }

    int idx = board_index(row, col);
    if (idx < 0 || b[idx] != EMPTY) return false;

    uint8_t opponent = (player == BLACK) ? WHITE : BLACK;
    uint8_t temp_b[BOARD_SIZE * BOARD_SIZE];
    memcpy(temp_b, b, sizeof(temp_b));

    b[idx] = player;

    // Capture opponent groups
    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};
    bool any_captured = false;
    for (int d = 0; d < 4; d++) {
        int nr = row + dr[d];
        int nc = col + dc[d];
        int nidx = board_index(nr, nc);
        if (nidx < 0) continue;
        if (b[nidx] == opponent && count_liberties_on(b, nr, nc, opponent) == 0) {
            remove_group_on(b, nr, nc, opponent);
            any_captured = true;
        }
    }

    // Suicide check
    if (count_liberties_on(b, row, col, player) == 0) {
        memcpy(b, temp_b, sizeof(temp_b));
        return false;
    }

    // Ko check
    if (*ko_active && memcmp(b, ko_b, sizeof(temp_b)) == 0) {
        memcpy(b, temp_b, sizeof(temp_b));
        return false;
    }

    memcpy(ko_b, temp_b, sizeof(temp_b));
    *ko_active = any_captured;
    return true;
}

// Score a board using Chinese rules (for playout)
static int score_board(uint8_t *b) {
    static bool visited[BOARD_SIZE * BOARD_SIZE];
    static int queue_r[BOARD_SIZE * BOARD_SIZE];
    static int queue_c[BOARD_SIZE * BOARD_SIZE];

    memset(visited, 0, sizeof(visited));

    int b_territory = 0, w_territory = 0;
    int b_stones = 0, w_stones = 0;

    for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (b[i] == BLACK) b_stones++;
        else if (b[i] == WHITE) w_stones++;
    }

    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};

    for (int sr = 0; sr < BOARD_SIZE; sr++) {
        for (int sc = 0; sc < BOARD_SIZE; sc++) {
            int sidx = board_index(sr, sc);
            if (b[sidx] != EMPTY || visited[sidx]) continue;

            int head = 0, tail = 0;
            queue_r[tail] = sr;
            queue_c[tail] = sc;
            tail++;
            visited[sidx] = true;

            int region_size = 0;
            bool touches_black = false;
            bool touches_white = false;

            while (head < tail) {
                int r = queue_r[head];
                int c = queue_c[head];
                head++;
                region_size++;

                for (int d = 0; d < 4; d++) {
                    int nr = r + dr[d];
                    int nc = c + dc[d];
                    int nidx = board_index(nr, nc);
                    if (nidx < 0) continue;

                    uint8_t ns = b[nidx];
                    if (ns == BLACK) {
                        touches_black = true;
                    } else if (ns == WHITE) {
                        touches_white = true;
                    } else {
                        if (!visited[nidx]) {
                            visited[nidx] = true;
                            queue_r[tail] = nr;
                            queue_c[tail] = nc;
                            tail++;
                        }
                    }
                }
            }

            if (touches_black && !touches_white) {
                b_territory += region_size;
            } else if (touches_white && !touches_black) {
                w_territory += region_size;
            }
        }
    }

    int black_total = b_stones + b_territory;
    int white_total = w_stones + w_territory + 7;  // komi 7.5 (approximate)
    return black_total - white_total;
}

// Heavy playout: simulate game to completion with heuristics
static int mcts_playout(uint8_t initial_player) {
    memcpy(play_board, sim_board, sizeof(play_board));
    memcpy(play_ko_board, sim_ko_board, sizeof(play_ko_board));
    play_ko_active = sim_ko_active;
    play_player = initial_player;
    play_last_row = sim_last_row;
    play_last_col = sim_last_col;
    play_passes = 0;

    uint8_t moves_rows[82], moves_cols[82];
    int move_count = 0;
    int playout_moves = 0;

    while (playout_moves < MCTS_MAX_PLAYOUT) {
        move_count = get_legal_moves_on(play_board, play_ko_board, play_ko_active,
                                         play_player, moves_rows, moves_cols);

        if (move_count == 0) break;

        // Simple heuristic move selection
        int move_idx = 0;

        // Prefer moves near the last move and captures
        int best_score = -999999;
        for (int i = 0; i < move_count; i++) {
            int score = 0;

            // Don't pick pass if better moves available
            if (moves_rows[i] == MCTS_PASS_ROW) {
                score = -1;
            } else {
                // Bonus for being close to last move
                int dist = abs((int)moves_rows[i] - play_last_row) +
                          abs((int)moves_cols[i] - play_last_col);
                if (dist <= 2) score += 10;
                if (dist <= 4) score += 5;

                // Small random factor for variety
                score += (mcts_rng() >> 20) % 3;
            }

            if (score > best_score) {
                best_score = score;
                move_idx = i;
            }
        }

        // Fallback: if all negative, just use first move
        if (move_count > 0 && best_score < -900) {
            move_idx = 0;
        }

        int move_row = moves_rows[move_idx];
        int move_col = moves_cols[move_idx];

        if (move_row == MCTS_PASS_ROW && move_col == MCTS_PASS_COL) {
            play_passes++;
            if (play_passes >= 2) break;
        } else {
            play_passes = 0;
            sim_try_place(play_board, play_ko_board, &play_ko_active, play_player, move_row, move_col);
            play_last_row = move_row;
            play_last_col = move_col;
        }

        play_player = (play_player == BLACK) ? WHITE : BLACK;
        playout_moves++;
    }

    int score = score_board(play_board);
    return (score > 0) ? 1 : 0;  // Return win for Black if positive
}

// Simple AI: suggest the best move based on score estimation
static void suggest_hint(void) {
    if (ui_state == GAME_OVER) return;

    // Generate candidate moves around the last move
    int candidates[8][2] = {
        {last_row - 1, last_col}, {last_row + 1, last_col},  // up, down
        {last_row, last_col - 1}, {last_row, last_col + 1},  // left, right
        {last_row - 1, last_col - 1}, {last_row - 1, last_col + 1},  // diagonals
        {last_row + 1, last_col - 1}, {last_row + 1, last_col + 1}
    };

    int best_row = -1, best_col = -1;
    int best_score = -999999;  // We want highest score for current player

    // Evaluate each candidate move
    for (int i = 0; i < 8; i++) {
        int row = candidates[i][0];
        int col = candidates[i][1];
        int idx = board_index(row, col);

        // Skip invalid positions or occupied cells
        if (idx < 0 || board[idx] != EMPTY) continue;

        // Temporarily place the stone and evaluate
        uint8_t opponent = (current_player == BLACK) ? WHITE : BLACK;
        uint8_t temp_board[BOARD_SIZE * BOARD_SIZE];
        memcpy(temp_board, board, sizeof(board));

        // Place stone
        board[idx] = current_player;

        // Check for captures
        const int dr[] = {-1, 1, 0, 0};
        const int dc[] = {0, 0, -1, 1};
        for (int d = 0; d < 4; d++) {
            int nr = row + dr[d];
            int nc = col + dc[d];
            int nidx = board_index(nr, nc);
            if (nidx < 0) continue;
            if (board[nidx] == opponent && count_liberties(nr, nc, opponent) == 0) {
                remove_group(nr, nc, opponent);
            }
        }

        // Evaluate if move is legal (not suicide)
        bool is_legal = count_liberties(row, col, current_player) > 0;

        if (is_legal) {
            // Get score for this move
            int score_10x = estimate_score_10x();
            if (current_player == WHITE) {
                score_10x = -score_10x;  // White wants negative (wins by positive margin)
            }

            if (score_10x > best_score) {
                best_score = score_10x;
                best_row = row;
                best_col = col;
            }
        }

        // Restore board
        memcpy(board, temp_board, sizeof(board));
    }

    // Set selection to best move found
    if (best_row >= 0 && best_col >= 0) {
        selected_row = best_row;
        selected_col = best_col;
        ui_state = SELECTING_COL;  // Highlight the suggested cell
        layer_mark_dirty(s_canvas_layer);
    }
}

// Compute Chinese scoring: stones + territory, with komi 7.5 for White
static void compute_chinese_score(void) {
    static bool visited[BOARD_SIZE * BOARD_SIZE];
    static int queue_r[BOARD_SIZE * BOARD_SIZE];
    static int queue_c[BOARD_SIZE * BOARD_SIZE];

    memset(visited, 0, sizeof(visited));

    int b_territory = 0, w_territory = 0;
    int b_stones = 0, w_stones = 0;

    // Count stones on board
    for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (board[i] == BLACK) b_stones++;
        else if (board[i] == WHITE) w_stones++;
    }

    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};

    // BFS over unvisited empty cells to find territory regions
    for (int sr = 0; sr < BOARD_SIZE; sr++) {
        for (int sc = 0; sc < BOARD_SIZE; sc++) {
            int sidx = board_index(sr, sc);
            if (board[sidx] != EMPTY || visited[sidx]) continue;

            // BFS flood-fill this empty region
            int head = 0, tail = 0;
            queue_r[tail] = sr;
            queue_c[tail] = sc;
            tail++;
            visited[sidx] = true;

            int region_size = 0;
            bool touches_black = false;
            bool touches_white = false;

            while (head < tail) {
                int r = queue_r[head];
                int c = queue_c[head];
                head++;
                region_size++;

                for (int d = 0; d < 4; d++) {
                    int nr = r + dr[d];
                    int nc = c + dc[d];
                    int nidx = board_index(nr, nc);
                    if (nidx < 0) continue;

                    uint8_t ns = board[nidx];
                    if (ns == BLACK) {
                        touches_black = true;
                    } else if (ns == WHITE) {
                        touches_white = true;
                    } else { // EMPTY and unvisited
                        if (!visited[nidx]) {
                            visited[nidx] = true;
                            queue_r[tail] = nr;
                            queue_c[tail] = nc;
                            tail++;
                        }
                    }
                }
            }

            // Assign territory
            if (touches_black && !touches_white) {
                b_territory += region_size;
            } else if (touches_white && !touches_black) {
                w_territory += region_size;
            }
            // else: dame (neutral), counts for neither
        }
    }

    // Store final scores
    black_score = b_stones + b_territory;
    white_score = w_stones + w_territory;
    // Komi 7.5 handled in display (white score displayed with .5, compared as 2*white+15)
}

// Forward declare hint function
static void suggest_hint(void);

// Mode selection callback
static void mode_select_callback(int index, void *context) {
    if (index == 0) {
        game_mode = MODE_PVP;
    } else if (index == 1) {
        game_mode = MODE_WHITE_AI;  // Black vs AI = human Black vs AI White
    } else if (index == 2) {
        game_mode = MODE_BLACK_AI;  // White vs AI = human White vs AI Black
    } else if (index == 3) {
        game_mode = MODE_AI_AI;  // AI vs AI
    }
    init_board();
    hide_mode_select();
    layer_mark_dirty(s_canvas_layer);
}

// Menu callbacks
static void menu_select_callback(int index, void *context) {
    if (index == 0) {
        // PASS selected
        do_pass();
    } else if (index == 1) {
        // NEW GAME selected - show mode selection
        hide_menu();
        show_mode_select();
        return;
    } else if (index == 2) {
        // HINT selected - suggest a move
        suggest_hint();
        hide_menu();
        return;
    } else if (index == 3) {
        // EXIT selected
        hide_menu();
        window_stack_pop_all(true);
        return;
    }
    hide_menu();
}

// Show menu window
static void show_menu(void) {
    // Create menu window only once
    if (!s_menu_window) {
        s_menu_window = window_create();
        Layer *window_layer = window_get_root_layer(s_menu_window);
        GRect bounds = layer_get_bounds(window_layer);

        // Set up menu items
        static SimpleMenuItem items[4];
        items[0].title = "PASS";
        items[0].callback = menu_select_callback;
        items[1].title = "NEW GAME";
        items[1].callback = menu_select_callback;
        items[2].title = "HINT";
        items[2].callback = menu_select_callback;
        items[3].title = "EXIT";
        items[3].callback = menu_select_callback;

        menu_sections[0].num_items = 4;
        menu_sections[0].items = items;

        // Create menu layer
        s_menu_layer = simple_menu_layer_create(bounds, s_menu_window, menu_sections, 1, NULL);
        layer_add_child(window_layer, simple_menu_layer_get_layer(s_menu_layer));
    }

    // Just push it on the stack
    window_stack_push(s_menu_window, true);
}

// Hide menu window
static void hide_menu(void) {
    if (!s_menu_window) return;
    window_stack_remove(s_menu_window, true);
    layer_mark_dirty(s_canvas_layer);
}

// Show mode selection window
static void show_mode_select(void) {
    // Create mode window only once
    if (!s_mode_window) {
        s_mode_window = window_create();

        Layer *window_layer = window_get_root_layer(s_mode_window);
        GRect bounds = layer_get_bounds(window_layer);

        // Set up mode selection items
        static SimpleMenuItem mode_items[4];
        mode_items[0].title = "Player vs Player";
        mode_items[0].callback = mode_select_callback;
        mode_items[1].title = "Black vs AI";
        mode_items[1].callback = mode_select_callback;
        mode_items[2].title = "White vs AI";
        mode_items[2].callback = mode_select_callback;
        mode_items[3].title = "AI vs AI";
        mode_items[3].callback = mode_select_callback;

        mode_sections[0].num_items = 4;
        mode_sections[0].items = mode_items;

        // Create mode menu layer
        s_mode_layer = simple_menu_layer_create(bounds, s_mode_window, mode_sections, 1, NULL);
        layer_add_child(window_layer, simple_menu_layer_get_layer(s_mode_layer));
    }

    // Just push it on the stack
    window_stack_push(s_mode_window, true);
}

// Hide mode selection window
static void hide_mode_select(void) {
    if (!s_mode_window) return;
    window_stack_remove(s_mode_window, true);
    layer_mark_dirty(s_canvas_layer);
}

// Check if any legal move exists anywhere on the board
static bool can_make_legal_move(void) {
    uint8_t opponent = (current_player == BLACK) ? WHITE : BLACK;

    for (int row = 0; row < BOARD_SIZE; row++) {
        for (int col = 0; col < BOARD_SIZE; col++) {
            int idx = board_index(row, col);
            if (board[idx] != EMPTY) continue;

            // Try placing a stone
            uint8_t temp_board[BOARD_SIZE * BOARD_SIZE];
            memcpy(temp_board, board, sizeof(board));

            board[idx] = current_player;

            // Check for captures
            const int dr[] = {-1, 1, 0, 0};
            const int dc[] = {0, 0, -1, 1};
            for (int d = 0; d < 4; d++) {
                int nr = row + dr[d];
                int nc = col + dc[d];
                int nidx = board_index(nr, nc);
                if (nidx < 0) continue;
                if (board[nidx] == opponent && count_liberties(nr, nc, opponent) == 0) {
                    remove_group(nr, nc, opponent);
                }
            }

            // Check if this move is legal (not suicide)
            bool legal = count_liberties(row, col, current_player) > 0;

            memcpy(board, temp_board, sizeof(board));

            if (legal) return true;
        }
    }

    return false;
}

// AI move timer callback - make the AI move
static void ai_move_callback(void *data) {
    ai_move_timer = NULL;
    try_make_ai_move();
}

// MCTS: Selection, Expansion, Simulation, Backpropagation
static uint16_t mcts_root = MCTS_NO_NODE;

static void mcts_run(int iterations) {
    // Reset pool and create root node (represent current position)
    mcts_pool_used = 0;
    mcts_root = mcts_alloc(MCTS_PASS_ROW, MCTS_PASS_COL, EMPTY);  // root has no "move"

    for (int iter = 0; iter < iterations; iter++) {
        // Selection: traverse tree from root using UCT
        uint16_t path[200];
        int path_len = 0;
        uint16_t node = mcts_root;
        memcpy(sim_board, board, sizeof(board));
        memcpy(sim_ko_board, ko_board, sizeof(ko_board));
        sim_ko_active = ko_active;
        sim_player = current_player;
        sim_last_row = last_row;
        sim_last_col = last_col;
        sim_passes = consecutive_passes;

        path[path_len++] = node;

        // Select until we find a node we can expand
        while (path_len < 200 && node < MCTS_POOL_SIZE) {
            MCTSNode *n = &mcts_pool[node];
            uint16_t child = n->first_child_idx;

            // If no children, break (need expansion)
            if (child == MCTS_NO_NODE) break;

            // Count visited and total children
            uint16_t best_child = MCTS_NO_NODE;
            float best_uct = -999999.0f;

            while (child != MCTS_NO_NODE && child < MCTS_POOL_SIZE) {
                float uct = mcts_uct(child, n->visits);
                if (uct > best_uct) {
                    best_uct = uct;
                    best_child = child;
                }
                child = mcts_pool[child].next_sibling_idx;
            }

            if (best_child == MCTS_NO_NODE) break;

            // Apply move to sim_board
            MCTSNode *bc = &mcts_pool[best_child];
            if (bc->move_row == MCTS_PASS_ROW) {
                sim_passes++;
            } else {
                sim_passes = 0;
                sim_try_place(sim_board, sim_ko_board, &sim_ko_active, sim_player,
                              bc->move_row, bc->move_col);
                sim_last_row = bc->move_row;
                sim_last_col = bc->move_col;
            }
            sim_player = (sim_player == BLACK) ? WHITE : BLACK;

            path[path_len++] = best_child;
            node = best_child;
        }

        // Expansion: try to add a new child if node is not fully expanded
        MCTSNode *leaf = &mcts_pool[node];
        uint8_t move_rows[82], move_cols[82];
        int legal_move_count = get_legal_moves_on(sim_board, sim_ko_board, sim_ko_active,
                                                   sim_player, move_rows, move_cols);

        // Find first move not yet as a child
        int unexpanded_idx = -1;
        for (int m = 0; m < legal_move_count; m++) {
            bool found = false;
            uint16_t child = leaf->first_child_idx;
            while (child != MCTS_NO_NODE && child < MCTS_POOL_SIZE) {
                MCTSNode *c = &mcts_pool[child];
                if (c->move_row == move_rows[m] && c->move_col == move_cols[m]) {
                    found = true;
                    break;
                }
                child = c->next_sibling_idx;
            }
            if (!found) {
                unexpanded_idx = m;
                break;
            }
        }

        // If found unexpanded move, expand it
        if (unexpanded_idx >= 0) {
            uint16_t new_child = mcts_alloc(move_rows[unexpanded_idx], move_cols[unexpanded_idx],
                                             sim_player);
            if (new_child != MCTS_NO_NODE) {
                // Link as child
                if (leaf->first_child_idx == MCTS_NO_NODE) {
                    leaf->first_child_idx = new_child;
                } else {
                    // Add as sibling
                    uint16_t sib = leaf->first_child_idx;
                    while (mcts_pool[sib].next_sibling_idx != MCTS_NO_NODE) {
                        sib = mcts_pool[sib].next_sibling_idx;
                    }
                    mcts_pool[sib].next_sibling_idx = new_child;
                }

                // Apply the new move
                if (move_rows[unexpanded_idx] == MCTS_PASS_ROW) {
                    sim_passes++;
                } else {
                    sim_passes = 0;
                    sim_try_place(sim_board, sim_ko_board, &sim_ko_active, sim_player,
                                  move_rows[unexpanded_idx], move_cols[unexpanded_idx]);
                    sim_last_row = move_rows[unexpanded_idx];
                    sim_last_col = move_cols[unexpanded_idx];
                }
                sim_player = (sim_player == BLACK) ? WHITE : BLACK;

                path[path_len++] = new_child;
                node = new_child;
            }
        }

        // Simulation: playout from current position
        int result = mcts_playout(sim_player);

        // Backpropagation: update path with result
        for (int i = path_len - 1; i >= 0; i--) {
            MCTSNode *n = &mcts_pool[path[i]];
            n->visits++;
            // Increment wins based on who made this move and the result
            // Result is 1 if Black wins, 0 if Black loses (from Black perspective)
            if (n->move_player == BLACK && result == 1) {
                n->wins++;
            } else if (n->move_player == WHITE && result == 0) {
                n->wins++;
            }
            // Root node (move_player == EMPTY) never gets wins
        }
    }
}

// Try to make an AI move using MCTS
static void try_make_ai_move(void) {
    if (ui_state != VIEW) return;

    bool is_black_ai = (game_mode == MODE_BLACK_AI && current_player == BLACK);
    bool is_white_ai = (game_mode == MODE_WHITE_AI && current_player == WHITE);
    bool is_ai_ai = (game_mode == MODE_AI_AI);

    if (!is_black_ai && !is_white_ai && !is_ai_ai) return;

    // Check if any legal move exists
    if (!can_make_legal_move()) {
        do_pass();
        layer_mark_dirty(s_canvas_layer);
        if (game_mode == MODE_AI_AI && ui_state == VIEW) {
            ai_move_timer = app_timer_register(1000, ai_move_callback, NULL);
        }
        return;
    }

    // Special case: first move as Black should be exactly D5 (row 4, col 3)
    if (current_player == BLACK && last_row == 4 && last_col == 4) {
        // Always play D5 as first move
        try_place_stone(4, 3);
        if (ui_state == VIEW) {
            ai_move_timer = app_timer_register(1000, ai_move_callback, NULL);
        }
        layer_mark_dirty(s_canvas_layer);
        return;
    }

    // Use simple heuristic-based AI (safer than MCTS)
    uint8_t moves_rows[82], moves_cols[82];
    int move_count = get_legal_moves_on(board, ko_board, ko_active, current_player,
                                         moves_rows, moves_cols);

    if (move_count == 0) {
        do_pass();
        return;
    }

    // Score each legal move
    int best_move_idx = 0;
    int best_score = -999999;
    uint8_t opponent = (current_player == BLACK) ? WHITE : BLACK;

    for (int i = 0; i < move_count; i++) {
        if (moves_rows[i] == MCTS_PASS_ROW) {
            // Pass gets lowest score
            if (-100 > best_score) {
                best_score = -100;
                best_move_idx = i;
            }
            continue;
        }

        int score = 0;

        // Check for captures (high value)
        const int dr[] = {-1, 1, 0, 0};
        const int dc[] = {0, 0, -1, 1};
        for (int d = 0; d < 4; d++) {
            int nr = moves_rows[i] + dr[d];
            int nc = moves_cols[i] + dc[d];
            int nidx = board_index(nr, nc);
            if (nidx < 0 || board[nidx] != opponent) continue;

            // Check if opponent group would be captured
            if (count_liberties(nr, nc, opponent) == 1) {
                score += 50;  // Capture is very valuable
                break;
            }
        }

        // Prefer moves near the last move (local play)
        if (last_row < 9) {
            int dist = abs(moves_rows[i] - last_row) + abs(moves_cols[i] - last_col);
            if (dist <= 2) score += 20;
            else if (dist <= 3) score += 10;
            else if (dist <= 4) score += 5;
        }

        // Small random factor for variety
        score += (mcts_rng() >> 20) % 5;

        if (score > best_score) {
            best_score = score;
            best_move_idx = i;
        }
    }

    // Play the best move
    if (moves_rows[best_move_idx] == MCTS_PASS_ROW) {
        do_pass();
    } else {
        try_place_stone(moves_rows[best_move_idx], moves_cols[best_move_idx]);
    }

    // Schedule next AI move if needed
    if (ui_state == VIEW) {
        bool next_is_ai = (game_mode == MODE_BLACK_AI && current_player == BLACK) ||
                          (game_mode == MODE_WHITE_AI && current_player == WHITE) ||
                          (game_mode == MODE_AI_AI);
        if (next_is_ai) {
            ai_move_timer = app_timer_register(1000, ai_move_callback, NULL);
        }
    }

    layer_mark_dirty(s_canvas_layer);
}

// Dialog window handlers
static void dialog_click_config(void *context) {
    window_single_click_subscribe(BUTTON_ID_SELECT, (ClickHandler)hide_dialog);
    window_single_click_subscribe(BUTTON_ID_BACK, (ClickHandler)hide_dialog);
}

static void dialog_window_load(Window *window) {
    Layer *window_layer = window_get_root_layer(window);
    GRect bounds = layer_get_bounds(window_layer);

    // Create text layer for message
    TextLayer *text_layer = text_layer_create(bounds);
    text_layer_set_text(text_layer, "Ko! Illegal move");
    text_layer_set_text_alignment(text_layer, GTextAlignmentCenter);
    text_layer_set_font(text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
    text_layer_set_background_color(text_layer, GColorRed);
    text_layer_set_text_color(text_layer, GColorWhite);

    layer_add_child(window_layer, text_layer_get_layer(text_layer));
}

static void dialog_window_unload(Window *window) {
    // Clean up
}

// Show dialog window
static void show_dialog(const char *message) {
    if (s_dialog_window) return;  // Already open

    s_dialog_window = window_create();
    window_set_window_handlers(s_dialog_window, (WindowHandlers) {
        .load = dialog_window_load,
        .unload = dialog_window_unload,
    });
    window_set_click_config_provider(s_dialog_window, dialog_click_config);

    window_stack_push(s_dialog_window, true);

    // Auto-dismiss after 2 seconds
    if (ko_timer) app_timer_cancel(ko_timer);
    ko_timer = app_timer_register(2000, (AppTimerCallback)hide_dialog, NULL);
}

// Hide dialog window
static void hide_dialog(void) {
    if (!s_dialog_window) return;
    window_stack_remove(s_dialog_window, true);
    window_destroy(s_dialog_window);
    s_dialog_window = NULL;
    layer_mark_dirty(s_canvas_layer);
}

// Game Over dialog window load
static void gameover_window_load(Window *window) {
    Layer *window_layer = window_get_root_layer(window);
    GRect bounds = layer_get_bounds(window_layer);

    // Calculate scores with komi (using 10x scale for precision)
    int black_total_10x = black_score * 10;
    int white_total_10x = white_score * 10 + 75;  // Add komi 7.5 * 10

    // Determine winner
    bool black_wins = black_total_10x > white_total_10x;
    const char *winner = black_wins ? "Black wins!" : "White wins!";

    // Format scores: extract integer and fractional parts
    int b_int = black_total_10x / 10;
    int b_frac = black_total_10x % 10;
    int w_int = white_total_10x / 10;
    int w_frac = white_total_10x % 10;

    // Create and format message
    static char message[128];
    snprintf(message, sizeof(message), "%s\n\nB: %d.%d  W: %d.%d",
             winner, b_int, b_frac, w_int, w_frac);

    // Create text layer for message
    TextLayer *text_layer = text_layer_create(bounds);
    text_layer_set_text(text_layer, message);
    text_layer_set_text_alignment(text_layer, GTextAlignmentCenter);
    text_layer_set_font(text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
    text_layer_set_background_color(text_layer, GColorBlack);
    text_layer_set_text_color(text_layer, GColorWhite);

    layer_add_child(window_layer, text_layer_get_layer(text_layer));
}

static void gameover_window_unload(Window *window) {
    // Clean up
}

static void gameover_click_config(void *context) {
    window_single_click_subscribe(BUTTON_ID_SELECT, (ClickHandler)hide_gameover_dialog);
    window_single_click_subscribe(BUTTON_ID_BACK, (ClickHandler)hide_gameover_dialog);
}

// Show game over dialog
static void show_gameover_dialog(void) {
    if (s_gameover_dialog) return;  // Already open

    s_gameover_dialog = window_create();
    window_set_window_handlers(s_gameover_dialog, (WindowHandlers) {
        .load = gameover_window_load,
        .unload = gameover_window_unload,
    });
    window_set_click_config_provider(s_gameover_dialog, gameover_click_config);

    window_stack_push(s_gameover_dialog, true);
}

// Hide game over dialog
static void hide_gameover_dialog(void) {
    if (!s_gameover_dialog) return;
    window_stack_remove(s_gameover_dialog, true);
    window_destroy(s_gameover_dialog);
    s_gameover_dialog = NULL;
    init_board();  // Reset board when closing game over dialog
    layer_mark_dirty(s_canvas_layer);
}

// Error dialog window load
static void error_window_load(Window *window) {
    Layer *window_layer = window_get_root_layer(window);
    GRect bounds = layer_get_bounds(window_layer);

    // Create text layer for error message
    TextLayer *text_layer = text_layer_create(bounds);
    text_layer_set_text(text_layer, "Cell occupied!");
    text_layer_set_text_alignment(text_layer, GTextAlignmentCenter);
    text_layer_set_font(text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
    text_layer_set_background_color(text_layer, GColorRed);
    text_layer_set_text_color(text_layer, GColorWhite);

    layer_add_child(window_layer, text_layer_get_layer(text_layer));
}

static void error_window_unload(Window *window) {
    // Clean up
}

static void error_click_config(void *context) {
    window_single_click_subscribe(BUTTON_ID_SELECT, (ClickHandler)hide_error_dialog);
    window_single_click_subscribe(BUTTON_ID_BACK, (ClickHandler)hide_error_dialog);
}

// Show error dialog
static void show_error_dialog(const char *message) {
    if (s_error_dialog) return;  // Already open

    s_error_dialog = window_create();
    window_set_window_handlers(s_error_dialog, (WindowHandlers) {
        .load = error_window_load,
        .unload = error_window_unload,
    });
    window_set_click_config_provider(s_error_dialog, error_click_config);

    window_stack_push(s_error_dialog, true);

    // Auto-dismiss after 1.5 seconds
    if (s_error_timer) app_timer_cancel(s_error_timer);
    s_error_timer = app_timer_register(1500, (AppTimerCallback)hide_error_dialog, NULL);
}

// Hide error dialog
static void hide_error_dialog(void) {
    if (!s_error_dialog) return;
    window_stack_remove(s_error_dialog, true);
    window_destroy(s_error_dialog);
    s_error_dialog = NULL;
    if (s_error_timer) {
        app_timer_cancel(s_error_timer);
        s_error_timer = NULL;
    }
    layer_mark_dirty(s_canvas_layer);
}

// Draw callback
static void canvas_update_proc(Layer *layer, GContext *ctx) {
    // Clear background
    graphics_context_set_fill_color(ctx, COLOR_BG);
    graphics_fill_rect(ctx, layer_get_bounds(layer), 0, GCornerNone);

    // Draw status bar with dynamic colors based on whose turn it is
    GColor status_bg_color, status_text_color;

    if (ui_state == GAME_OVER) {
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

    // Left side: "X to move"
    char left_text[32];
    if (ui_state == GAME_OVER) {
        snprintf(left_text, sizeof(left_text), "GAME OVER");
    } else {
        snprintf(left_text, sizeof(left_text), "%s to move",
            current_player == BLACK ? "Black" : "White");
    }

    graphics_draw_text(ctx, left_text,
        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(5, 2, 120, 20),
        GTextOverflowModeWordWrap,
        GTextAlignmentLeft,
        NULL);

    // Right side: Score estimate (always from Black's perspective)
    char right_text[32];
    if (ui_state != GAME_OVER) {
        int diff_10x = estimate_score_10x();  // Positive = Black winning
        int abs_diff_10x = diff_10x < 0 ? -diff_10x : diff_10x;
        int diff_int = abs_diff_10x / 10;
        int diff_frac = abs_diff_10x % 10;

        if (diff_10x >= 0) {
            snprintf(right_text, sizeof(right_text), "B+%d.%d", diff_int, diff_frac);
        } else {
            snprintf(right_text, sizeof(right_text), "B-%d.%d", diff_int, diff_frac);
        }

        graphics_draw_text(ctx, right_text,
            fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
            GRect(120, 2, 75, 20),
            GTextOverflowModeWordWrap,
            GTextAlignmentRight,
            NULL);
    }

    // Draw board background (extends to bottom of screen to cover menu row area)
    graphics_context_set_stroke_color(ctx, COLOR_GRID);
    graphics_context_set_fill_color(ctx, COLOR_BOARD);
    graphics_fill_rect(ctx, GRect(BOARD_ORIGIN_X - 1, BOARD_ORIGIN_Y - 1,
                                   BOARD_SIZE * CELL_SIZE + 2,
                                   228 - (BOARD_ORIGIN_Y - 1)), 0, GCornerNone);

    // Highlight the selected row only during row selection
    if (ui_state == SELECTING_ROW) {
        int row_y = BOARD_ORIGIN_Y + selected_row * CELL_SIZE;
        graphics_context_set_fill_color(ctx, COLOR_HIGHLIGHT);
        // Extend highlight to the left by half a cell width
        graphics_fill_rect(ctx, GRect(BOARD_ORIGIN_X - CELL_SIZE/2, row_y - CELL_SIZE/2,
                                      BOARD_SIZE * CELL_SIZE + CELL_SIZE/2, CELL_SIZE),
                          0, GCornerNone);
    }

    // Draw cursor (behind grid and stones) only during column selection on board rows
    if (ui_state == SELECTING_COL && selected_row != MENU_ROW) {
        int cursor_x = BOARD_ORIGIN_X + selected_col * CELL_SIZE;
        int cursor_y = BOARD_ORIGIN_Y + selected_row * CELL_SIZE;
        graphics_context_set_fill_color(ctx, COLOR_CURSOR_COL);
        graphics_fill_rect(ctx, GRect(cursor_x - CELL_SIZE/2, cursor_y - CELL_SIZE/2,
                                      CELL_SIZE, CELL_SIZE), 0, GCornerNone);
    }

    // Draw grid lines
    graphics_context_set_stroke_color(ctx, COLOR_GRID);
    for (int i = 0; i < BOARD_SIZE; i++) {
        int x = BOARD_ORIGIN_X + i * CELL_SIZE;
        int y_start = BOARD_ORIGIN_Y;
        int y_end = BOARD_ORIGIN_Y + (BOARD_SIZE - 1) * CELL_SIZE;
        graphics_draw_line(ctx, GPoint(x, y_start), GPoint(x, y_end));

        int y = BOARD_ORIGIN_Y + i * CELL_SIZE;
        int x_start = BOARD_ORIGIN_X;
        int x_end = BOARD_ORIGIN_X + (BOARD_SIZE - 1) * CELL_SIZE;
        graphics_draw_line(ctx, GPoint(x_start, y), GPoint(x_end, y));
    }

    // Draw column labels (A-H, J) at the top
    graphics_context_set_text_color(ctx, COLOR_GRID);
    const char col_labels[] = "ABCDEFGHJ";  // No I (standard Go convention)
    for (int col = 0; col < BOARD_SIZE; col++) {
        int x = BOARD_ORIGIN_X + col * CELL_SIZE;
        char label[2] = {col_labels[col], '\0'};
        graphics_draw_text(ctx, label,
            fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
            GRect(x - 6, BOARD_ORIGIN_Y - 25, 12, 14),
            GTextOverflowModeWordWrap,
            GTextAlignmentCenter,
            NULL);
    }

    // Draw row labels (9-1) on the left (9 at top, 1 at bottom - standard Go board)
    graphics_context_set_text_color(ctx, COLOR_GRID);
    for (int row = 0; row < BOARD_SIZE; row++) {
        int y = BOARD_ORIGIN_Y + row * CELL_SIZE;
        char label[2];
        snprintf(label, sizeof(label), "%d", BOARD_SIZE - row);  // 9 to 1
        graphics_draw_text(ctx, label,
            fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
            GRect(5, y - 10, 10, 14),
            GTextOverflowModeWordWrap,
            GTextAlignmentCenter,
            NULL);
    }

    // Draw "..." label for menu row
    int menu_y = BOARD_ORIGIN_Y + MENU_ROW * CELL_SIZE;
    graphics_draw_text(ctx, "...",
        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(BOARD_ORIGIN_X + CELL_SIZE * 4 - 6, menu_y - 7, 12, 14),
        GTextOverflowModeWordWrap,
        GTextAlignmentCenter,
        NULL);

    // Draw hoshi (handicap) points at 5 positions for 9x9: C3, C7, E5, G3, G7
    // In 0-indexed (row, col): (6,2), (2,2), (4,4), (6,6), (2,6)
    graphics_context_set_fill_color(ctx, COLOR_GRID);
    int hoshi_positions[5][2] = {
        {2, 2},   // C7
        {2, 6},   // G7
        {4, 4},   // E5 (center)
        {6, 2},   // C3
        {6, 6}    // G3
    };
    for (int i = 0; i < 5; i++) {
        int row = hoshi_positions[i][0];
        int col = hoshi_positions[i][1];
        int x = BOARD_ORIGIN_X + col * CELL_SIZE;
        int y = BOARD_ORIGIN_Y + row * CELL_SIZE;
        graphics_fill_circle(ctx, GPoint(x, y), 2);
    }

    // Draw stones
    for (int row = 0; row < BOARD_SIZE; row++) {
        for (int col = 0; col < BOARD_SIZE; col++) {
            uint8_t stone = get_stone(row, col);
            if (stone == EMPTY) continue;

            int x = BOARD_ORIGIN_X + col * CELL_SIZE;
            int y = BOARD_ORIGIN_Y + row * CELL_SIZE;

            if (stone == BLACK) {
                graphics_context_set_fill_color(ctx, COLOR_BLACK_STONE);
            } else {
                graphics_context_set_fill_color(ctx, COLOR_WHITE_STONE);
                graphics_context_set_stroke_color(ctx, COLOR_GRID);
            }

            graphics_fill_circle(ctx, GPoint(x, y), STONE_RADIUS);
            if (stone == WHITE) {
                graphics_draw_circle(ctx, GPoint(x, y), STONE_RADIUS);
            }
        }
    }
}

// Long-press UP/DOWN to open menu
// Button click handlers
static void click_config_provider(Window *window) {
    window_single_click_subscribe(BUTTON_ID_UP, handle_click);
    window_single_click_subscribe(BUTTON_ID_DOWN, handle_click);
    window_single_click_subscribe(BUTTON_ID_SELECT, handle_click);
    window_single_click_subscribe(BUTTON_ID_BACK, handle_click);
}

static void handle_click(ClickRecognizerRef recognizer, void *context) {
    ButtonId button = click_recognizer_get_button_id(recognizer);

    if (ui_state == VIEW) {
        // In view state, SELECT/UP/DOWN moves to row selection
        switch (button) {
            case BUTTON_ID_SELECT:
            case BUTTON_ID_UP:
            case BUTTON_ID_DOWN:
                previous_state = VIEW;
                ui_state = SELECTING_ROW;
                selected_row = last_row;  // Recall the last row used
                selected_col = 0;
                // UP/DOWN also change the row if in VIEW
                if (button == BUTTON_ID_UP && selected_row > 0) selected_row--;
                if (button == BUTTON_ID_DOWN && selected_row < MENU_ROW) selected_row++;
                break;
            case BUTTON_ID_BACK:
                // Back in VIEW opens the menu
                show_menu();
                break;
            default:
                break;
        }
    } else if (ui_state == SELECTING_ROW) {
        switch (button) {
            case BUTTON_ID_UP:
                if (selected_row > 0) {
                    selected_row--;
                } else {
                    selected_row = MENU_ROW;  // Cycle to menu row
                }
                break;
            case BUTTON_ID_DOWN:
                if (selected_row < MENU_ROW) {
                    selected_row++;
                } else {
                    selected_row = 0;  // Cycle to first row
                }
                break;
            case BUTTON_ID_SELECT:
                if (selected_row == MENU_ROW) {
                    // Open menu when selecting the "..." row
                    show_menu();
                } else {
                    // Move to column selection, recall the last column used
                    previous_state = SELECTING_ROW;
                    selected_col = last_col;
                    ui_state = SELECTING_COL;
                }
                break;
            case BUTTON_ID_BACK:
                // Go back to view state
                ui_state = VIEW;
                break;
            default:
                break;
        }
    } else if (ui_state == SELECTING_COL) {
        switch (button) {
            case BUTTON_ID_UP:
                // UP moves right (increase column)
                if (selected_col < BOARD_SIZE - 1) {
                    selected_col++;
                } else {
                    selected_col = 0;  // Cycle to first column
                }
                break;
            case BUTTON_ID_DOWN:
                // DOWN moves left (decrease column)
                if (selected_col > 0) {
                    selected_col--;
                } else {
                    selected_col = BOARD_SIZE - 1;  // Cycle to last column
                }
                break;
            case BUTTON_ID_SELECT:
                // Try to place stone
                try_place_stone(selected_row, selected_col);
                break;
            case BUTTON_ID_BACK:
                // Go back to row selection
                ui_state = SELECTING_ROW;
                break;
            default:
                break;
        }
    } else if (ui_state == GAME_OVER) {
        // Game over state: can only start new game or go back
        switch (button) {
            case BUTTON_ID_SELECT:
            case BUTTON_ID_BACK:
                init_board();
                break;
            default:
                break;
        }
    }

    layer_mark_dirty(s_canvas_layer);
}

// Window load
static void window_load(Window *window) {
    Layer *window_layer = window_get_root_layer(window);
    GRect bounds = layer_get_bounds(window_layer);

    s_canvas_layer = layer_create(bounds);
    layer_set_update_proc(s_canvas_layer, canvas_update_proc);
    layer_add_child(window_layer, s_canvas_layer);

    window_set_click_config_provider(window, (ClickConfigProvider) click_config_provider);
}

// Window unload
static void window_unload(Window *window) {
    layer_destroy(s_canvas_layer);
}

// Main app initialization
static void init(void) {
    mcts_init_zobrist();  // Initialize MCTS once at startup
    init_board();

    s_main_window = window_create();
    window_set_window_handlers(s_main_window, (WindowHandlers) {
        .load = window_load,
        .unload = window_unload,
    });

    window_stack_push(s_main_window, true);
}

// Main app deinit
static void deinit(void) {
    window_destroy(s_main_window);
}

// Main entry point
int main(void) {
    init();
    app_event_loop();
    deinit();
    return 0;
}
