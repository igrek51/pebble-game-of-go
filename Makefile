.PHONY: help build clean install screenshot logs start-emulator stop-emulator setup 2x

help:
	@echo "Game of Go - Pebble Time 2 (Emery)"
	@echo ""
	@echo "Available commands:"
	@echo "  make setup             - Set up Pebble SDK (run once)"
	@echo "  make start-emulator    - Start QEMU emulator in background"
	@echo "  make 2x                - Make emulator with 2x scaling"
	@echo "  make stop-emulator     - Stop emulator"
	@echo "  make build             - Build the app (PBW)"
	@echo "  make install           - Build and install on emulator"
	@echo "  make screenshot        - Capture screenshot from emulator"
	@echo "  make logs              - View emulator logs"
	@echo "  make clean             - Remove build artifacts"
	@echo ""

setup:
	@echo "Setting up Pebble SDK..."
	@if [ ! -d "$$HOME/.pebble-sdk" ]; then pebble sdk install; else echo "✓ SDK already installed"; fi

emu: start-emulator
start-emulator:
	@bash scripts/emulator-control.sh start

# Scale emulator window to 2x
2x:
	@WINDOW_ID=$$(xdotool search --name QEMU | tail -1); \
	xdotool windowsize "$$WINDOW_ID" 400 456;

stop-emulator:
	@bash scripts/emulator-control.sh stop

build:
	@echo "Building Game of Go..."
	pebble build
	@echo "✓ Build complete: build/go-game.pbw"

install: build start-emulator
	@echo "Installing on emulator..."
	pebble install --emulator emery
	@echo "✓ Installed on emulator"

screenshot: start-emulator
	@echo "Capturing screenshot..."
	pebble screenshot --no-open --emulator emery /tmp/screenshot-emery.png
	@echo "✓ Screenshot: /tmp/screenshot-emery.png"

logs:
	@echo "Fetching emulator logs (Ctrl+C to stop)..."
	pebble logs --emulator emery

clean:
	@echo "Cleaning build artifacts..."
	rm -rf build/
	@echo "✓ Clean complete"

.DEFAULT_GOAL := help
