#include <pebble.h>

#define BOARD_SIZE 9
#define EMPTY 0
#define BLACK 1
#define WHITE 2

#define CELL_SIZE 21
#define STONE_RADIUS 7

// Bigger board with breathing room from coordinates: 9 * 21 = 189px
// Space for row labels on left + gap, space for column labels on top + gap
#define BOARD_ORIGIN_X 22  // Moved right to separate from row numbers
#define BOARD_ORIGIN_Y 48  // Moved down to separate from column letters

// UI States
typedef enum {
    VIEW,           // Just viewing board, no selection
    SELECTING_ROW,  // Selecting row
    SELECTING_COL   // Selecting column
} UIState;

// Colors
#define COLOR_BOARD GColorChromeYellow      // Golden tan (wooden board appearance)
#define COLOR_GRID GColorBlack
#define COLOR_BLACK_STONE GColorBlack
#define COLOR_WHITE_STONE GColorWhite
#define COLOR_CURSOR_COL GColorLightGray    // Gray square for column selection
#define COLOR_HIGHLIGHT GColorLightGray     // Gray row highlight
#define COLOR_BG GColorChromeYellow         // Match board color
#define COLOR_STATUS_BG GColorBlue
#define COLOR_TEXT GColorWhite

// Game state
static uint8_t board[BOARD_SIZE * BOARD_SIZE];
static uint8_t current_player = BLACK;
static uint16_t black_captures = 0;
static uint16_t white_captures = 0;

// UI state
static int selected_row = 0;
static int selected_col = 0;
static int last_row = 0;  // Remember the last row used for a move
static int last_col = 0;  // Remember the last column used for a move
static UIState ui_state = VIEW;
static UIState previous_state = VIEW;

// Window & layer
static Window *s_main_window;
static Layer *s_canvas_layer;

// Forward declarations
static void canvas_update_proc(Layer *layer, GContext *ctx);
static void handle_click(ClickRecognizerRef recognizer, void *context);

// Initialize board
static void init_board(void) {
    memset(board, EMPTY, sizeof(board));
    current_player = BLACK;
    black_captures = 0;
    white_captures = 0;
    selected_row = 0;
    selected_col = 0;
    ui_state = VIEW;
    previous_state = VIEW;
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

// Try to place a stone
static bool try_place_stone(int row, int col) {
    int idx = board_index(row, col);
    if (idx < 0) return false;
    if (board[idx] != EMPTY) return false;

    // Place stone
    set_stone(row, col, current_player);

    // Remember the row and column for next move
    last_row = row;
    last_col = col;

    // Switch player
    current_player = (current_player == BLACK) ? WHITE : BLACK;

    // Reset to view state after placing
    previous_state = VIEW;
    ui_state = VIEW;
    selected_row = 0;
    selected_col = 0;

    return true;
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
    snprintf(status_text, sizeof(status_text), "%s",
        current_player == BLACK ? "Black" : "White");

    graphics_draw_text(ctx, status_text,
        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(5, 2, 190, 20),
        GTextOverflowModeWordWrap,
        GTextAlignmentLeft,
        NULL);

    // Draw board background
    graphics_context_set_stroke_color(ctx, COLOR_GRID);
    graphics_context_set_fill_color(ctx, COLOR_BOARD);
    graphics_fill_rect(ctx, GRect(BOARD_ORIGIN_X - 1, BOARD_ORIGIN_Y - 1,
                                   BOARD_SIZE * CELL_SIZE + 2,
                                   BOARD_SIZE * CELL_SIZE + 2), 0, GCornerNone);

    // Highlight the selected row only during row selection
    if (ui_state == SELECTING_ROW) {
        int row_y = BOARD_ORIGIN_Y + selected_row * CELL_SIZE;
        graphics_context_set_fill_color(ctx, COLOR_HIGHLIGHT);
        // Extend highlight to the left by half a cell width
        graphics_fill_rect(ctx, GRect(BOARD_ORIGIN_X - CELL_SIZE/2, row_y - CELL_SIZE/2,
                                      BOARD_SIZE * CELL_SIZE + CELL_SIZE/2, CELL_SIZE),
                          0, GCornerNone);
    }

    // Draw cursor (behind grid and stones) only during column selection
    if (ui_state == SELECTING_COL) {
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
                if (button == BUTTON_ID_DOWN && selected_row < BOARD_SIZE - 1) selected_row++;
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
                    selected_row = BOARD_SIZE - 1;  // Cycle to last row
                }
                break;
            case BUTTON_ID_DOWN:
                if (selected_row < BOARD_SIZE - 1) {
                    selected_row++;
                } else {
                    selected_row = 0;  // Cycle to first row
                }
                break;
            case BUTTON_ID_SELECT:
                // Move to column selection, recall the last column used
                previous_state = SELECTING_ROW;
                selected_col = last_col;
                ui_state = SELECTING_COL;
                break;
            case BUTTON_ID_BACK:
                // Go back to view state
                ui_state = VIEW;
                break;
            default:
                break;
        }
    } else { // SELECTING_COL
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
