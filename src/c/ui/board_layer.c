#include "board_layer.h"
#include "../ai/mcts.h"
#include "../game_state.h"
#include "../logic/board.h"
#include "../logic/life.h"
#include <pebble.h>

void board_layer_update_proc(Layer *layer, GContext *ctx, int selected_row,
                             int selected_col) {
    GRect bounds = layer_get_bounds(layer);
    int width = bounds.size.w;
    int height = bounds.size.h;

    graphics_context_set_fill_color(ctx, COLOR_BG);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);

    GColor status_bg_color, status_text_color;
    // While thinking, the banner takes the thinking side's colors (same as
    // its turn): white thinking = black text on white, and vice versa.
    if (ui_state == GAME_OVER_STATE) {
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
    graphics_fill_rect(ctx, GRect(0, 0, width, 25), 0, GCornerNone);
    graphics_context_set_text_color(ctx, status_text_color);

    char left_text[32];
    // One label system for every state: same font, same rect, same offset.
    // The thinking label keeps its live seconds; overflow ellipsizes exactly
    // like the regular turn label does.
    bool thinking = (ui_state == AI_THINKING);
    // Wide score slot whenever a fresh server estimate carries a winrate
    // (Katago mode: "W+12.5 100%"); otherwise the classic 60px slot.
    int srv_pct_tmp = -1;
    bool srv_fresh = (ui_state != GAME_OVER_STATE) &&
                     server_score_fresh(NULL, &srv_pct_tmp);
    int score_w = srv_fresh ? 95 : 60;
    if (thinking) {
        // 14pt turn label: "White thinking 5s" fits the 120px rect;
        // very long seconds still ellipsize.
        snprintf(left_text, sizeof(left_text), "%s thinking %ds",
                 (current_player == BLACK ? "Black" : "White"),
                 think_elapsed_sec());
    } else if (ui_state == GAME_OVER_STATE) {
        snprintf(left_text, sizeof(left_text), "%s",
                 (black_score > white_score) ? "Black won" : "White won");
    } else if (ui_state == REPLAY) {
        snprintf(left_text, sizeof(left_text), "Replay %d/%d", replay_shown,
                 hist_len());
    } else {
        bool is_ai = ((game_mode == MODE_BLACK_AI && current_player == BLACK) ||
                      (game_mode == MODE_WHITE_AI && current_player == WHITE) ||
                      (game_mode == MODE_AI_AI));
        snprintf(left_text, sizeof(left_text), "%s %s",
                 (current_player == BLACK ? "Black" : "White"),
                 is_ai ? "is thinking" : "to move");
    }
    graphics_draw_text(ctx, left_text,
                       fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
                       GRect(5, 2, 120, 20),
                       GTextOverflowModeTrailingEllipsis,
                       GTextAlignmentLeft, NULL);

    char right_text[32];
    if (ui_state == GAME_OVER_STATE || ui_state == REPLAY) {
        if (go_server) {
            // Katago final: server lead (winner + margin), "..." while it
            // loads, "-" on failure. Local count is known to miscount dead.
            if (go_have) {
                int m = go_lead_10x < 0 ? -go_lead_10x : go_lead_10x;
                snprintf(right_text, sizeof(right_text), "%c+%d.%d",
                         go_lead_10x >= 0 ? 'B' : 'W', m / 10, m % 10);
            } else {
                snprintf(right_text, sizeof(right_text), "%s",
                         server_score_failed ? "-" : "...");
            }
        } else {
            int diff_10x = (black_score * 10) - (white_score * 10 + 75);
            int abs_diff_10x = diff_10x < 0 ? -diff_10x : diff_10x;

            snprintf(right_text, sizeof(right_text), "%c%d.5",
                     (diff_10x >= 0 ? 'B' : 'W'), abs_diff_10x / 10);
        }
    } else {
        // Score and winrate from the side-to-move perspective (White to
        // move sees W+/W-, Black sees B+/B-). Fresh server estimate
        // outranks the local influence heuristic — except in Katago mode,
        // where a missing estimate shows "..." instead of a local guess.
        int diff_10x, pct = -1;
        bool fresh = server_score_fresh(&diff_10x, &pct);
        if (ai_engine == AI_ENGINE_KATAGO && !fresh) {
            snprintf(right_text, sizeof(right_text), "%s",
                     server_score_failed ? "-" : "...");
        } else {
            if (!fresh)
                diff_10x = estimate_score_10x_logic();
            diff_10x = round_10x_to_half(diff_10x);
            int rel_10x = (current_player == BLACK) ? diff_10x : -diff_10x;
            int abs_rel = rel_10x < 0 ? -rel_10x : rel_10x;
            char who = (current_player == BLACK) ? 'B' : 'W';
            if (fresh) {
                int show_pct = (current_player == BLACK) ? pct : 100 - pct;
                snprintf(right_text, sizeof(right_text), "%c%c%d.%d %d%%",
                         who, (rel_10x >= 0 ? '+' : '-'), abs_rel / 10,
                         abs_rel % 10, show_pct);
            } else {
                snprintf(right_text, sizeof(right_text), "%c%c%d.%d",
                         who, (rel_10x >= 0 ? '+' : '-'), abs_rel / 10,
                         abs_rel % 10);
            }
        }
    }
    // Score box erases the turn label underneath, so the full-width
    // left text never garbles the right-aligned score.
    graphics_context_set_fill_color(ctx, status_bg_color);
    graphics_fill_rect(ctx, GRect(width - score_w - 5, 0, score_w + 5, 25),
                       0, GCornerNone);
    graphics_context_set_text_color(ctx, status_text_color);
    graphics_draw_text(ctx, right_text,
                       fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                        GRect(width - score_w - 5, 0, score_w, 20), GTextOverflowModeWordWrap,
                       GTextAlignmentRight, NULL);

    // Board background
    graphics_context_set_stroke_color(ctx, COLOR_GRID);
    graphics_context_set_fill_color(ctx, COLOR_BOARD);
    graphics_fill_rect(ctx,
                       GRect(BOARD_ORIGIN_X - 1, BOARD_ORIGIN_Y - 1,
                             BOARD_SIZE * CELL_SIZE + 2,
                             height - (BOARD_ORIGIN_Y - 1)),
                       0, GCornerNone);

    if (ui_state == SELECTING_ROW) {
        int row_y = BOARD_ORIGIN_Y + selected_row * CELL_SIZE;
        graphics_context_set_fill_color(ctx, COLOR_HIGHLIGHT);
        graphics_fill_rect(
            ctx,
            GRect(BOARD_ORIGIN_X - CELL_SIZE, row_y - CELL_SIZE / 2,
                  BOARD_SIZE * CELL_SIZE + CELL_SIZE, CELL_SIZE),
            0, GCornerNone);
    }

    if (ui_state == SELECTING_COL && selected_row != MENU_ROW) {
        int cursor_x = BOARD_ORIGIN_X + selected_col * CELL_SIZE;
        int cursor_y = BOARD_ORIGIN_Y + selected_row * CELL_SIZE;
        graphics_context_set_fill_color(ctx, COLOR_CURSOR_COL);
        graphics_fill_rect(ctx,
                           GRect(cursor_x - CELL_SIZE / 2,
                                 cursor_y - CELL_SIZE / 2, CELL_SIZE,
                                 CELL_SIZE),
                           0, GCornerNone);
    }

    // Grid lines
    graphics_context_set_stroke_color(ctx, COLOR_GRID);
    for (int i = 0; i < BOARD_SIZE; i++) {
        int x = BOARD_ORIGIN_X + i * CELL_SIZE;
        graphics_draw_line(
            ctx, GPoint(x, BOARD_ORIGIN_Y),
            GPoint(x, BOARD_ORIGIN_Y + (BOARD_SIZE - 1) * CELL_SIZE));
        int y = BOARD_ORIGIN_Y + i * CELL_SIZE;
        graphics_draw_line(
            ctx, GPoint(BOARD_ORIGIN_X, y),
            GPoint(BOARD_ORIGIN_X + (BOARD_SIZE - 1) * CELL_SIZE, y));
    }

    // Labels
    graphics_context_set_text_color(ctx, COLOR_GRID);
    const char col_labels[] = "ABCDEFGHJ";
    for (int col = 0; col < BOARD_SIZE; col++) {
        char label[2] = {col_labels[col], '\0'};
        graphics_draw_text(
            ctx, label, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
            GRect(BOARD_ORIGIN_X + col * CELL_SIZE - 6, BOARD_ORIGIN_Y - COL_LABEL_Y_OFFSET, 12,
                  14),
            GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    }
    for (int row = 0; row < BOARD_SIZE; row++) {
        char label[2];
        snprintf(label, sizeof(label), "%d", BOARD_SIZE - row);
        graphics_draw_text(
            ctx, label, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
            GRect(4, BOARD_ORIGIN_Y + row * CELL_SIZE - 9, 10, 14),
            GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    }

    graphics_draw_text(ctx, "...",
                       fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
                       GRect(BOARD_ORIGIN_X + CELL_SIZE * 4 - 6,
                             BOARD_ORIGIN_Y + MENU_ROW * CELL_SIZE - 7, 12, 14),
                       GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);

    // Hoshi points (skipped with the territory overlay: the 5 dots read
    // as territory markers next to the tint).
    if (!terr_estimate_on) {
        graphics_context_set_fill_color(ctx, COLOR_GRID);
    int hoshi[5][2] = {{2, 2}, {2, 6}, {4, 4}, {6, 2}, {6, 6}};
    for (int i = 0; i < 5; i++) {
        graphics_fill_circle(ctx,
                             GPoint(BOARD_ORIGIN_X + hoshi[i][1] * CELL_SIZE,
                                    BOARD_ORIGIN_Y + hoshi[i][0] * CELL_SIZE),
                             2);
    }
    }

    // Stones
    for (int row = 0; row < BOARD_SIZE; row++) {
        for (int col = 0; col < BOARD_SIZE; col++) {
            uint8_t stone = get_stone(row, col);
            if (stone == EMPTY)
                continue;
            GPoint p = GPoint(BOARD_ORIGIN_X + col * CELL_SIZE,
                              BOARD_ORIGIN_Y + row * CELL_SIZE);
            if (stone == BLACK) {
                graphics_context_set_fill_color(ctx, COLOR_BLACK_STONE);
            } else {
                graphics_context_set_fill_color(ctx, COLOR_WHITE_STONE);
                graphics_context_set_stroke_color(ctx, COLOR_GRID);
            }
            graphics_fill_circle(ctx, p, STONE_RADIUS);
            if (stone == WHITE)
                graphics_draw_circle(ctx, p, STONE_RADIUS);
        }
    }

    // Live territory overlay (Settings toggle): tint estimated territory
    // and mark dead stones, same maps as the ESTIMATE view. The tint
    // prefers the server ownership map when fresh, else local influence.
    // Dead marks are local Benson verdicts OR server-confident dead
    // (stone on a strongly opponent-owned point).
    if (terr_estimate_on) {
        uint8_t owner[BOARD_SIZE * BOARD_SIZE];
        bool dead[BOARD_SIZE * BOARD_SIZE];
        const int8_t *sown = server_owner_map();
        if (sown) {
            for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++)
                owner[i] = server_owner_color(sown[i]);
        } else {
            score_influence_10x(board, owner);
        }
        find_dead_map(board, dead);
        if (sown) {
            for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
                if (board[i] != EMPTY && server_stone_dead(sown[i], board[i]))
                    dead[i] = true;
            }
        }
        for (int row = 0; row < BOARD_SIZE; row++) {
            for (int col = 0; col < BOARD_SIZE; col++) {
                int idx = board_index(row, col);
                GPoint p = GPoint(BOARD_ORIGIN_X + col * CELL_SIZE,
                                  BOARD_ORIGIN_Y + row * CELL_SIZE);
                if (board[idx] == EMPTY &&
                    (owner[idx] == BLACK || owner[idx] == WHITE)) {
                    graphics_context_set_fill_color(
                        ctx, (owner[idx] == BLACK) ? COLOR_BLACK_STONE
                                                  : COLOR_WHITE_STONE);
                    graphics_fill_rect(ctx, GRect(p.x - 2, p.y - 2, 5, 5),
                                       0, GCornerNone);
                } else if ((board[idx] == BLACK || board[idx] == WHITE) &&
                           dead[idx]) {
                    // Dead marks read exactly like territory tint (small
                    // filled square, opposite color); no clash since tint
                    // only ever sits on empty points.
                    graphics_context_set_fill_color(
                        ctx, (board[idx] == BLACK) ? COLOR_WHITE_STONE
                                                  : COLOR_BLACK_STONE);
                    graphics_fill_rect(ctx, GRect(p.x - 2, p.y - 2, 5, 5),
                                       0, GCornerNone);
                }
            }
        }
    }

    // Last-move indicator: open ring in the opposite color on the most
    // recently placed stone (white ring on black, black ring on white).
    // Single-stroked (1px): graphics_draw_circle is 1px per pass.
    // Skipped after a pass or on a fresh board (last_move_placed == false).
    if (last_move_placed) {
        uint8_t last_stone = get_stone(last_move_row, last_move_col);
        if (last_stone == BLACK || last_stone == WHITE) {
            GPoint p = GPoint(BOARD_ORIGIN_X + last_move_col * CELL_SIZE,
                              BOARD_ORIGIN_Y + last_move_row * CELL_SIZE);
            graphics_context_set_stroke_color(
                ctx, (last_stone == BLACK) ? COLOR_WHITE_STONE
                                       : COLOR_BLACK_STONE);
            graphics_draw_circle(ctx, p, 4);
        }
    }
}
