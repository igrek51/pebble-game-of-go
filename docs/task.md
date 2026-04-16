# Tasks

## Completed Features
- ✓ Add stones capture detection logic - count_liberties() & remove_group() with iterative DFS
- ✓ Implement Ko rule checking - board state snapshots with memcmp comparison
- ✓ Add scoring (Chinese rules with komi 7.5) - territory + stones with BFS flood-fill
- ✓ Add pass mechanic & menu system - long-press SELECT to open menu with PASS/NEW GAME options
- ✓ Improve UI (row/column labels, status display) - coordinates, hoshi dots, status bar with player
- ✓ Add message / dialog UI mechanic - Ko message dialog, game over dialog, error dialog for occupied cells
- Add unit tests for some important, critical parts, like AI strategy.

## Future Improvements
- Make sure the current implementation of AI algorithm is on par with the Monte Carlo Search Tree described in ai_strategy.md

- I feel like the AI strategy is stupid, putting it bluntly. Sometimes it plays in the corner, out of blue, which is considered a worst move. Verify if everything is correct with the algorithm and it's on par with general design @docs/ai_strategy.md. For instance, it should prioritize escaping atari, and capturing, but I'm pretty sure it's not doing it. You can allocate more resources, more time, more search depth, iterations, etc. to the algorithm. So far it's quite fast, we can improve it at slight cost of the time.
