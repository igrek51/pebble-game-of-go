CC = gcc
CFLAGS = -Wall -Wextra -I../src/c -DUNIT_TEST
LIBS = -lm

SRC_LOGIC = ../src/c/logic/board.c ../src/c/logic/life.c ../src/c/game_state.c
SRC_AI = ../src/c/ai/mcts.c $(SRC_LOGIC)

TESTS = test_board test_ai test_match test_fallback

all: $(TESTS)

test_board: test_board.c $(SRC_LOGIC)
	$(CC) $(CFLAGS) $^ $(LIBS) -o $@

test_ai: test_ai.c $(SRC_AI)
	$(CC) $(CFLAGS) $^ $(LIBS) -o $@

test_match: test_match.c $(SRC_AI)
	$(CC) $(CFLAGS) $^ $(LIBS) -o $@

test_fallback: test_fallback.c $(SRC_AI)
	$(CC) $(CFLAGS) $^ $(LIBS) -o $@

run: all
	./test_board
	./test_ai
	./test_match
	./test_fallback
	@if command -v node >/dev/null 2>&1; then node pkjs/run.js; else echo "node not found, skipping pkjs tests"; fi

clean:
	rm -f $(TESTS)
