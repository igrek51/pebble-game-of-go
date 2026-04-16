CC = gcc
CFLAGS = -Wall -Wextra -I../src/c -DUNIT_TEST
LIBS = -lm

SRC_LOGIC = ../src/c/logic/board.c ../src/c/game_state.c
SRC_AI = ../src/c/ai/mcts.c $(SRC_LOGIC)

TESTS = test_board test_ai test_match

all: $(TESTS)

test_board: test_board.c $(SRC_LOGIC)
	$(CC) $(CFLAGS) $^ $(LIBS) -o $@

test_ai: test_ai.c $(SRC_AI)
	$(CC) $(CFLAGS) $^ $(LIBS) -o $@

test_match: test_match.c $(SRC_AI)
	$(CC) $(CFLAGS) $^ $(LIBS) -o $@

run: all
	./test_board
	./test_ai
	./test_match

clean:
	rm -f $(TESTS)
