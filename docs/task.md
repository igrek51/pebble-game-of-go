# Tasks

## Completed Features
- ✓ Add stones capture detection logic - count_liberties() & remove_group() with iterative DFS
- ✓ Implement Ko rule checking - board state snapshots with memcmp comparison
- ✓ Add scoring (Chinese rules with komi 7.5) - territory + stones with BFS flood-fill
- ✓ Add pass mechanic & menu system - long-press SELECT to open menu with PASS/NEW GAME options
- ✓ Improve UI (row/column labels, status display) - coordinates, hoshi dots, status bar with player
- ✓ Add message / dialog UI mechanic - Ko message dialog, game over dialog, error dialog for occupied cells

## Future Improvements
- Make sure the current implementation of AI algorithm is on par with the Monte Carlo Search Tree described in ai_strategy.md
- Split the code in src/c/main.c into multiple files, logically separate.
- Add unit tests for some important, critical parts, like AI strategy.
- Establish a reliable way for testing the app stability, correctness, compilation errors, without running it actually on emulator, but just compiling it and running tests. Of course, emulator and screenshots is final test.
- tests are only testing board, which is almost nothing. Also , run some sanity checks / smoke tests verifying AI algotithm. For instance, try to play the match to the very end, between 2 AI opponnents. Make sure the results makes sense more or less, and it doesn't crash.
