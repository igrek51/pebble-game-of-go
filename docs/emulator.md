# Pebble Emulator Interaction Findings - Reliable Control Established

This document details the successful establishment of a reliable process for interacting with and controlling the Pebble Time 2 (`emery`) emulator, resolving previous limitations.

## Persistent Emulator Process

Through user intervention and `strace` analysis, it has been confirmed that a persistent QEMU emulator process *can* be launched and maintained, although not directly by `pebble install --emulator emery` in an easily detectable manner from the agent's typical execution context.

**QEMU Command Line:**
The precise command line used by `pebble install` to launch `qemu-pebble` was identified via `strace`:
`/home/igrek/.pebble-sdk/SDKs/4.9.148/toolchain/bin/qemu-pebble -rtc base=localtime -serial null -serial tcp::56061,server,nowait -serial tcp::33323,server,nowait -pflash /home/igrek/.pebble-sdk/SDKs/4.9.148/sdk-core/pebble/emery/qemu/qemu_micro_flash.bin -gdb tcp::59135,server,nowait -monitor tcp::48613,server,nowait -machine pebble-snowy-emery-bb -cpu cortex-m4 -pflash /home/igrek/.pebble-sdk/4.9.148/emery/qemu_spi_flash.bin`

When this QEMU process is launched by the user (e.g., via `pebble install --emulator emery` from their terminal), it results in a persistent graphical window.

## Process Detection

Once the emulator is running as a persistent window (launched by the user), its process can be reliably detected using `ps` commands. For example, `ps ax | grep qemu` or `ps ax | grep qemu-pebble` will reveal the `qemu-pebble` process and its arguments.

## Command-Line Control (Key Press Simulation)

We have successfully demonstrated command-line control over the persistent emulator instance:

1.  **Action:** `pebble emu-button click select --emulator emery` was sent to the running emulator.
2.  **Verification (Screenshot):** A subsequent screenshot (`screenshot.png`) confirmed that the emulator's display changed from the default screen to an application menu, with "Go 9x9" highlighted. This conclusively proves that `pebble emu-button` commands effectively interact with the running emulator session.

## Session Persistence for Reinstallation

It has been verified that the emulator session persists and can be updated without resetting:

1.  **Action:** After the initial app installation and button press, `pebble install --emulator emery` was executed again.
2.  **Verification (Screenshot):** A screenshot (`screenshot_after_reinstall.png`) taken after reinstallation showed the *same* application menu, with "Go 9x9" still highlighted. This confirms that subsequent installations update the app within the existing emulator session, maintaining its state.

## Conclusion and Established Workflow

A reliable workflow for interacting with the Pebble emulator has been established:

1.  **User Launch:** The user must manually launch the emulator once (e.g., by running `pebble install --emulator emery` from their terminal and keeping the window open).
2.  **Agent Control:** Once the emulator window is persistent, the agent can:
    *   **Detect its presence:** Use `ps ax | grep qemu-pebble`.
    *   **Send button presses:** Use `pebble emu-button click <button> --emulator emery`.
    *   **Capture screenshots:** Use `pebble screenshot --no-open --emulator emery <filename.png>`.
    *   **Install/reinstall apps:** Use `pebble install --emulator emery`.

This reliable control mechanism now allows for thorough testing and debugging of Pebble applications.

## Next Steps

With reliable emulator control established, we can now proceed to thoroughly test the "Game of Go" application, leveraging these control mechanisms.
