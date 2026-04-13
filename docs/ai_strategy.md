Implementation Guide: 9x9 Go AI for Pebble Time 2 (Emery Platform)
==================================================================

This guide provides the technical architecture and specific C implementation strategies for a memory-bounded Monte Carlo Tree Search (MCTS) Go AI. It is designed to run within the strict hardware constraints of the Pebble Time 2.

1. Hardware Constraints & Memory Management
--------------------------------------------

The Pebble Time 2 ("Emery" platform) features a 240 MHz Cortex-M33-like processor. The total maximum app size (which includes both your compiled code and your heap memory) is strictly limited to **128 KB**.

*   **No Dynamic Allocation:** Do not use malloc() or free() during the AI's "thinking" phase. Dynamic allocation causes heap fragmentation and overhead that will quickly crash an embedded app.
    
*   **Static Node Pool:** Pre-allocate a fixed static array of MCTS nodes at startup.
    
*   **Node Compression:** Pack your MCTS tree node struct tightly to maximize your search tree depth. If you keep the node size under 16 bytes, you can fit roughly 3,000–4,000 nodes in 64 KB of RAM.
    

**Example C Struct (12 bytes):**

C

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   typedef struct {      uint16_t visits;      uint16_t wins;      uint16_t first_child_idx;      uint16_t next_sibling_idx;      uint8_t move_coord;      uint8_t pad[3]; // For 4-byte alignment  } MCTSNode;   `

2. Board Representation: 81-bit Bitboards
------------------------------------------

A standard 2D array (int board\[9\]\[9\]) is too slow for move generation. Instead, use **Bitboards**. Since a 9x9 board requires 81 bits, represent each player's stones using a combination of a 64-bit integer and a 32-bit integer.

C

Plain textANTLR4BashCC#CSSCoffeeScriptCMakeDartDjangoDockerEJSErlangGitGoGraphQLGroovyHTMLJavaJavaScriptJSONJSXKotlinLaTeXLessLuaMakefileMarkdownMATLABMarkupObjective-CPerlPHPPowerShell.propertiesProtocol BuffersPythonRRubySass (Sass)Sass (Scss)SchemeSQLShellSwiftSVGTSXTypeScriptWebAssemblyYAMLXML`   uint64_t black_stones_low;   uint32_t black_stones_high;   `

Use bitwise operations (&, |, ^, <<, >>) to place stones, check for legal moves, and execute flood-fill algorithms to find connected groups and liberties.

3. Zobrist Hashing for Superko
-------------------------------

Positional Superko (preventing the board from returning to a previous state) is required for accurate Chinese rules implementation. Tracking full board states wastes memory. Implement **Zobrist Hashing**.

*   **Lookup Tables:** Generate a static lookup table of random 64-bit integers for all 81 intersections and 2 colors (81 \* 2 = 162 random numbers).
    
*   **Hashing Operations:** When a stone is placed or captured, simply XOR the corresponding random number with your current hash state.
    
*   **Repetition Check:** Keep a short array of previous Zobrist hashes in your game state to check for repetitions.
    

4. The MCTS Algorithm
----------------------

Execute the four standard phases of MCTS in a while loop until the turn timer expires.

*   Score=NW​+CNlnNp​​​_(where W is wins, N is node visits, Np​ is parent visits, and C is the exploration constant)_
    
*   **Optimization:** Do not use the hardware FPU for floating-point math if possible; convert UCT to use fixed-point integer arithmetic or precomputed lookup tables for the square root and natural logarithm.
    
*   **Expansion:** Once a leaf node is reached, pick a legal move, apply it, and claim the next available index from your static node\_pool.
    
*   **Simulation (Heavy Playouts):** From the new node, simulate the game to completion. To compensate for the low node-count on the 240 MHz CPU, do not use purely random playouts. Implement "heavy" heuristic playouts (MoGo style).
    
    *   _Atari Defense:_ Check if the last move put your stones in Atari (1 liberty). If so, prioritize escaping or capturing.
        
    *   _3x3 Pattern Matching:_ Extract the 3x3 bitboard grid around the last played stone. Use a small set of hard-coded bitmasks for classic good Go shapes (e.g., hane, cut). If a mask matches, play there.
        
    *   _Fallback:_ Play a random legal move.

    In other words, when choosing a move during the simulation, do not pick entirely at random.
    Check the following in order:
    1. Atari evasion: If the last move put your stones in Atari (1 liberty left), play a move to escape or capture the attacking stone.
    2. Atari capture: If you can capture an opponnent's stone, do it.
    3. Local 3x3 Patterns: Check the 8 surrounding intersections of the last played move. Use a small, hardcoded lookup table of classic 3x3 Go shapes (hane, cut, cross). If a pattern matches, play there.
        
*   **Backpropagation:** Walk back up the tree to the root node, incrementing the visits count by 1 and the wins count by 1 (if the simulation resulted in a win for that node's player).

* When beginning a game as Black, start the first move at D5 position.
    

5. Area Scoring (Chinese Rules)
--------------------------------

Chinese rules are exceptionally friendly to MCTS because you do not have to mathematically prove whether a group of stones is "dead" or "alive" before scoring.

*   During simulations, the agents simply play until both randomly pass.
    
*   **Calculate the Area Score:** The number of a player's stones on the board plus the number of empty intersections entirely surrounded by their stones.
    
*   **Algorithm:** Use a bitwise flood-fill on the empty intersections. If the contiguous empty bits only touch black stones, those bits belong to Black. If they touch both, they are neutral (dame) and yield 0 points. Subtract the komi (e.g., 7.5) from Black's total.
