#include "board.h"
#include <string.h>
#include <stdlib.h>
#include "../game_state.h"

uint8_t board[BOARD_SIZE * BOARD_SIZE];
uint8_t ko_board[BOARD_SIZE * BOARD_SIZE];
bool ko_active = false;

// Shared DFS arrays for liberty counting (moved from main.c)
static bool _dfs_visited[BOARD_SIZE * BOARD_SIZE];
static int _dfs_stack_r[BOARD_SIZE * BOARD_SIZE];
static int _dfs_stack_c[BOARD_SIZE * BOARD_SIZE];

int board_index(int row, int col) {
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
        return -1;
    }
    return row * BOARD_SIZE + col;
}

uint8_t get_stone(int row, int col) {
    int idx = board_index(row, col);
    if (idx < 0) return 0; // EMPTY
    return board[idx];
}

void set_stone(int row, int col, uint8_t color) {
    int idx = board_index(row, col);
    if (idx >= 0) {
        board[idx] = color;
    }
}

int count_liberties_on(uint8_t *b, int start_row, int start_col, uint8_t color) {
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

void remove_group_on(uint8_t *b, int start_row, int start_col, uint8_t color) {
    memset(_dfs_visited, 0, sizeof(_dfs_visited));
    int top = 0;

    int start_idx = board_index(start_row, start_col);
    if (start_idx < 0 || b[start_idx] != color) return;

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

int count_liberties(int start_row, int start_col, uint8_t color) {
    return count_liberties_on(board, start_row, start_col, color);
}

void remove_group(int start_row, int start_col, uint8_t color) {
    remove_group_on(board, start_row, start_col, color);
}

int score_board(uint8_t *b) {
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

void compute_chinese_score(void) {
    static bool visited[BOARD_SIZE * BOARD_SIZE];
    static int queue_r[BOARD_SIZE * BOARD_SIZE];
    static int queue_c[BOARD_SIZE * BOARD_SIZE];

    memset(visited, 0, sizeof(visited));

    int b_territory = 0, w_territory = 0;
    int b_stones = 0, w_stones = 0;

    for (int i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        if (board[i] == BLACK) b_stones++;
        else if (board[i] == WHITE) w_stones++;
    }

    const int dr[] = {-1, 1, 0, 0};
    const int dc[] = {0, 0, -1, 1};

    for (int sr = 0; sr < BOARD_SIZE; sr++) {
        for (int sc = 0; sc < BOARD_SIZE; sc++) {
            int sidx = board_index(sr, sc);
            if (board[sidx] != EMPTY || visited[sidx]) continue;

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

    black_score = b_stones + b_territory;
    white_score = w_stones + w_territory;
}

bool can_make_legal_move(uint8_t player) {
    uint8_t opponent = (player == BLACK) ? WHITE : BLACK;
    uint8_t temp_board[BOARD_SIZE * BOARD_SIZE];

    for (int row = 0; row < BOARD_SIZE; row++) {
        for (int col = 0; col < BOARD_SIZE; col++) {
            int idx = board_index(row, col);
            if (board[idx] != EMPTY) continue;

            // Try placing a stone
            memcpy(temp_board, board, sizeof(board));

            temp_board[idx] = player;

            // Check for captures
            const int dr[] = {-1, 1, 0, 0};
            const int dc[] = {0, 0, -1, 1};
            for (int d = 0; d < 4; d++) {
                int nr = row + dr[d];
                int nc = col + dc[d];
                int nidx = board_index(nr, nc);
                if (nidx < 0) continue;
                if (temp_board[nidx] == opponent && count_liberties_on(temp_board, nr, nc, opponent) == 0) {
                    remove_group_on(temp_board, nr, nc, opponent);
                }
            }

            // Check if this move is legal (not suicide)
            if (count_liberties_on(temp_board, row, col, player) == 0) {
                continue;
            }

            // Check Ko
            if (ko_active && memcmp(temp_board, ko_board, sizeof(board)) == 0) {
                continue;
            }

            return true;
        }
    }

    return true; // Pass is always legal
}
