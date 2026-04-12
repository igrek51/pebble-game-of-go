# Remarks
1. Running `pebble logs ...` starts a process of QEMU emulator, it hangs, awaits user input. If you can't control it from CLI, don't go this way. Possibly try to make screenshots and analyze them. And send the keystrokes to control it. Running `pebble logs --emulator emery` hangs your process if you run it synchronously, if you're counting to get some output, you won't get it, this is the emulator. This way, you're freezing yourself, because you're waiting for the process indefinitely. Unless, you run it in background!
To control the emulator, use these commands:
- `pebble emu-button click select --emulator emery` - to click select
- `pebble emu-button click back --emulator emery` - to click back
- `pebble emu-button click up --emulator emery` - to click up
- `pebble emu-button click down --emulator emery` - to click down
- `pebble install --emulator emery` to start QEMU emulator and install the built version
- `pebble build` to build the app
- `pebble logs --emulator emery` to read the logs - start it in background.
- `pebble screenshot --no-open --emulator emery /tmp/pebble-screenshot.png` to make a screenshot. Then read this file to analyze the screenshot.

2. There are some examples of pebble apps like https://github.com/Moddable-OpenSource/pebble-examples/tree/main/hellopiu-balls or here https://developer.repebble.com/examples/.
3. Also, read the tutorials like https://developer.repebble.com/tutorials/alloy-watchface-tutorial/part1/ and the documentation of Pebble - it's very extensive, look for more.
4. In other sibling folder `pebble-watchface-agent-skill` there is a whole official agent skill for develoing the app / watchface for Pebble - make use of it.
5. Then, attempt to fix our "Game of Go 9x9" app.
6. You can read the PNG screenshot files on your own. You are multimodal model, you can read PNG files.
7. `pebble logs --emulator emery` blocks your operation, it awaits input. Always run it in background, otherwise you'll wait forever to finish.

# Before you start
1. Read the files of `pebble-watchface-agent-skill`.
2. Read the web resources about the SDK and creating apps for Pebble. 
