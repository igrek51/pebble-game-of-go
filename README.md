# Game of Go 9x9 on Pebble

![](gfx/go144icon.png)
![](gfx/demo200x228.gif)
![](gfx/200x228-screnshot.png)


[Game of Go app](https://apps.repebble.com/35ad80179c4145118edca560)

This app brings the game of Go / Baduk / Weiqi to the Pebble Time 2 with a fast,
fully-featured engine and a polished interface.
Go is the ultimate mental workout for your commute or coffee break.

Features:
* Board 9x9, Chinese rules (Stones + Territory)
* AI algorithm based on Monte Carlo Tree Search.
* Game modes: Player vs Player, Human vs AI (Black or White), and even AI vs AI mode.
* Intuitive two-step stone placement designed specifically for the Pebble's buttons.
* A real-time score estimate, keeping you informed of who's winning at every turn.
* 100% offline - all computations happen on the local device, pushing Pebble's capabilities to the boundaries.
* AI hints - stuck on the next move? Ask the AI for a suggestion.
* Authentic look: standard coordinate labels (1-9, A-J), Hoshi (star) points, and a wooden board aesthetic

How to Play:
1. Select Row: Use UP/DOWN to highlight a row, then press SELECT.
2. Select Column: Use UP/DOWN to move the cursor horizontally, then press SELECT to place your stone.
3. Press BACK to open Menu to Pass, start a New Game, or get a Hint.

Rules of Go:
* Go is a two-player, turn-based board game played on a grid, where the goal is to control more territory than the opponent.
  Black moves first, alternating turns by placing one stone on an intersection.
  Stones are captured by surrounding them, and the game ends with 2 consecutive passed turns, scoring by occupied area. 
* Players take turns placing a single stone on an empty intersection. Stones cannot be moved.
* Capture (Liberties): A stone or group must have adjacent (not diagonally) empty points ("liberties") to remain on the board.
  If all liberties are blocked by opponent stones, the group is removed.
* Illegal Suicide Move: You cannot place a stone where it has no liberties unless it captures an opponent's stone(s).
* The Ko rule prohibits immediately re-capturing a single stone if it repeats a previous board position.
* Ending the Game: The game ends when both players pass consecutively. Passing is allowed at any time.
* Scoring (Goal): The winner is the player with the most occupied area: territory (empty points surrounded) plus stones on board.
* Compensation: White receives extra 7.5 points (komi) to compensate for going second.

---

Love the game? Please leave a ❤️ on the Pebble App Store! Your support helps me keep improving the AI and adding new features like persistent saves and larger boards.

![](gfx/banner-720x320.png)
