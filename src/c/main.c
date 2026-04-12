#include <pebble.h>

#define BOARD_SIZE 9
#define EMPTY 0
#define BLACK 1
#define WHITE 2

#define CELL_SIZE 20
#define BOARD_ORIGIN_X 28
#define BOARD_ORIGIN_Y 22
#define STONE_RADIUS 7

// Colors
#define COLOR_BOARD GColorWhite
#define COLOR_GRID GColorBlack
#define COLOR_BLACK_STONE GColorBlack
#define COLOR_WHITE_STONE GColorWhite
#define COLOR_CURSOR GColorRed
#define COLOR_BG GColorWhite
#define COLOR_STATUS_BG GColorBlue
#define COLOR_TEXT GColorWhite

// Game state
static uint8_t board[BOARD_SIZE * BOARD_SIZE];
static uint8_t current_player = BLACK;
static uint16_t black_captures = 0;
static uint16_t white_captures = 0;
static int selected_row = 0;
static int selected_col = 0;

// UI state
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

    // Switch player
    current_player = (current_player == BLACK) ? WHITE : BLACK;

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
    graphics_draw_text(ctx,
        current_player == BLACK ? "Black" : "White",
        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(5, 2, 190, 20),
        GTextOverflowModeWordWrap,
        GTextAlignmentLeft,
        NULL);

    // Draw board grid
    graphics_context_set_stroke_color(ctx, COLOR_GRID);
    graphics_context_set_fill_color(ctx, COLOR_BOARD);
    graphics_fill_rect(ctx, GRect(BOARD_ORIGIN_X - 2, BOARD_ORIGIN_Y - 2,
                                   BOARD_SIZE * CELL_SIZE + 4,
                                   BOARD_SIZE * CELL_SIZE + 4), 0, GCornerNone);

    // Draw grid lines
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

    // Draw cursor
    int cursor_x = BOARD_ORIGIN_X + selected_col * CELL_SIZE;
    int cursor_y = BOARD_ORIGIN_Y + selected_row * CELL_SIZE;
    graphics_context_set_stroke_color(ctx, COLOR_CURSOR);
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_circle(ctx, GPoint(cursor_x, cursor_y), STONE_RADIUS + 3);
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

    switch (button) {
        case BUTTON_ID_UP:
            if (selected_row > 0) selected_row--;
            break;
        case BUTTON_ID_DOWN:
            if (selected_row < BOARD_SIZE - 1) selected_row++;
            break;
        case BUTTON_ID_SELECT:
            try_place_stone(selected_row, selected_col);
            break;
        case BUTTON_ID_BACK:
            if (selected_col > 0) selected_col--;
            break;
        default:
            break;
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
