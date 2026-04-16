CC = gcc
CFLAGS = -Wall -Wextra -I../src/c -DUNIT_TEST

SRC_LOGIC = ../src/c/logic/board.c ../src/c/game_state.c
TESTS = test_board

all: $(TESTS)

test_board: test_board.c $(SRC_LOGIC)
	$(CC) $(CFLAGS) $^ -o $@

run: all
	./test_board

clean:
	rm -f $(TESTS)
