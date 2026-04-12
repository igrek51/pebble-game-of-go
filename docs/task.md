# Task 1: Prepare a development flow for testing on emulator
We need to establish a reliable feedback loop for testing our app on emulator.
This is intended to be used by agents, though emulators are graphical and interactive and that's the problem.
For that we need a way to do the following from the CLI:
- checking if the Emulator process `qemu-pebble` is running
- starting the emulator process in background
- reading screenshot and analyzing it
- sending keystroke signals to emulator, simulating click: Select, Back, Up, Down

Find a reliable solution for this and update doc emulator.md.
Most problematic is starting the Emulator session, that outlives the CLI agent (Gemini CLI or Claude Code).

# Task 2: Make the app successfully running for the first time
Task: Fix the Pebble app.
Currently, the app builds correctly but running it in emulator `pebble install --emulator emery` and selecting the app within the QEMU emulator, does nothing and shows the error logs only. The app doesn't open, perhaps it crashes.
Fix it.
