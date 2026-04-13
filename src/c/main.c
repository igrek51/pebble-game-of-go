#include <pebble.h>

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

// Dialog windows
static Window *s_dialog_window = NULL;
static Window *s_gameover_dialog = NULL;
static Window *s_error_dialog = NULL;
static AppTimer *s_error_timer = NULL;

// Forward declarations
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
    last_row = 0;
    last_col = 0;
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

// Count liberties for a group using iterative DFS
static int count_liberties(int start_row, int start_col, uint8_t color) {
    static bool visited[BOARD_SIZE * BOARD_SIZE];
    static int stack_r[BOARD_SIZE * BOARD_SIZE];
    static int stack_c[BOARD_SIZE * BOARD_SIZE];

    memset(visited, 0, sizeof(visited));
    int liberties = 0;
    int top = 0;

    int start_idx = board_index(start_row, start_col);
    if (start_idx < 0 || board[start_idx] != color) return 0;

    stack_r[top] = start_row;
    stack_c[top] = start_col;
    top++;
    visited[start_idx] = true;

    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};

    while (top > 0) {
        top--;
        int r = stack_r[top];
        int c = stack_c[top];

        for (int d = 0; d < 4; d++) {
            int nr = r + dr[d];
            int nc = c + dc[d];
            int nidx = board_index(nr, nc);
            if (nidx < 0) continue;
            if (visited[nidx]) continue;

            uint8_t ns = board[nidx];
            if (ns == EMPTY) {
                liberties++;
                visited[nidx] = true;  // Mark to avoid double-counting
            } else if (ns == color) {
                visited[nidx] = true;
                stack_r[top] = nr;
                stack_c[top] = nc;
                top++;
            }
        }
    }
    return liberties;
}

// Remove captured group
static void remove_group(int start_row, int start_col, uint8_t color) {
    static bool visited[BOARD_SIZE * BOARD_SIZE];
    static int stack_r[BOARD_SIZE * BOARD_SIZE];
    static int stack_c[BOARD_SIZE * BOARD_SIZE];

    memset(visited, 0, sizeof(visited));
    int top = 0;

    stack_r[top] = start_row;
    stack_c[top] = start_col;
    top++;
    visited[board_index(start_row, start_col)] = true;

    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};

    while (top > 0) {
        top--;
        int r = stack_r[top];
        int c = stack_c[top];
        set_stone(r, c, EMPTY);

        for (int d = 0; d < 4; d++) {
            int nr = r + dr[d];
            int nc = c + dc[d];
            int nidx = board_index(nr, nc);
            if (nidx < 0) continue;
            if (visited[nidx]) continue;
            if (board[nidx] == color) {
                visited[nidx] = true;
                stack_r[top] = nr;
                stack_c[top] = nc;
                top++;
            }
        }
    }
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

    return true;
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

// Menu callbacks
static void menu_select_callback(int index, void *context) {
    if (index == 0) {
        // PASS selected
        do_pass();
    } else if (index == 1) {
        // NEW GAME selected
        init_board();
    }
    hide_menu();
}

// Show menu window
static void show_menu(void) {
    if (s_menu_window) return;  // Already open

    s_menu_window = window_create();

    Layer *window_layer = window_get_root_layer(s_menu_window);
    GRect bounds = layer_get_bounds(window_layer);

    // Set up menu items
    static SimpleMenuItem items[2];
    items[0].title = "PASS";
    items[0].callback = menu_select_callback;
    items[1].title = "NEW GAME";
    items[1].callback = menu_select_callback;

    menu_sections[0].num_items = 2;
    menu_sections[0].items = items;

    // Create menu layer with frame, window, sections, and section count
    s_menu_layer = simple_menu_layer_create(bounds, s_menu_window, menu_sections, 1, NULL);

    // Add to window
    layer_add_child(window_layer, simple_menu_layer_get_layer(s_menu_layer));

    window_stack_push(s_menu_window, true);
}

// Hide menu window
static void hide_menu(void) {
    if (!s_menu_window) return;
    window_stack_remove(s_menu_window, true);
    simple_menu_layer_destroy(s_menu_layer);
    window_destroy(s_menu_window);
    s_menu_window = NULL;
    s_menu_layer = NULL;
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

    // Determine winner
    bool black_wins = (2 * black_score) > (2 * white_score + 15);
    const char *winner = black_wins ? "Black wins!" : "White wins!";

    // Create and format message
    static char message[128];
    snprintf(message, sizeof(message), "%s\n\nB: %d  W: %d.5",
             winner, black_score, white_score);

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

    // Draw status bar
    graphics_context_set_fill_color(ctx, COLOR_STATUS_BG);
    graphics_fill_rect(ctx, GRect(0, 0, 200, 20), 0, GCornerNone);

    graphics_context_set_text_color(ctx, COLOR_TEXT);
    char status_text[32];
    if (ui_state == GAME_OVER) {
        snprintf(status_text, sizeof(status_text), "GAME OVER");
    } else {
        snprintf(status_text, sizeof(status_text), "%s",
            current_player == BLACK ? "Black" : "White");
    }

    graphics_draw_text(ctx, status_text,
        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(5, 2, 190, 20),
        GTextOverflowModeWordWrap,
        GTextAlignmentLeft,
        NULL);

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
            GRect(5, y - 7, 10, 14),
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
static void handle_long_click(ClickRecognizerRef recognizer, void *context) {
    show_menu();
}

// Button click handlers
static void click_config_provider(Window *window) {
    window_single_click_subscribe(BUTTON_ID_UP, handle_click);
    window_long_click_subscribe(BUTTON_ID_UP, 750, handle_long_click, NULL);
    window_single_click_subscribe(BUTTON_ID_DOWN, handle_click);
    window_long_click_subscribe(BUTTON_ID_DOWN, 750, handle_long_click, NULL);
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
                // Back in VIEW does nothing (already at top level)
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
                if (selected_col > 0) {
                    selected_col--;
                } else {
                    selected_col = BOARD_SIZE - 1;  // Cycle to last column
                }
                break;
            case BUTTON_ID_DOWN:
                if (selected_col < BOARD_SIZE - 1) {
                    selected_col++;
                } else {
                    selected_col = 0;  // Cycle to first column
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
