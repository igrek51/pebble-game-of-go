# Tasks

## Completed Features
- ✓ Add stones capture detection logic - count_liberties() & remove_group() with iterative DFS
- ✓ Implement Ko rule checking - board state snapshots with memcmp comparison
- ✓ Add scoring (Chinese rules with komi 7.5) - territory + stones with BFS flood-fill
- ✓ Add pass mechanic & menu system - long-press SELECT to open menu with PASS/NEW GAME options
- ✓ Improve UI (row/column labels, status display) - coordinates, hoshi dots, status bar with player
- ✓ Add message / dialog UI mechanic - Ko message dialog, game over dialog, error dialog for occupied cells

## Future Improvements
- Replace the basic AI algorithm with the new one Monte Carlo Search Tree described in ai_strategy.md
- Split the code in src/c/main.c into multiple files, logically separate.
- Show the current score estimate always with regards to Black (even if White is winning), meaning: "B-7.5" or "B+12.5".
- On clicking Back, in VIEW mode, open the Menu.
