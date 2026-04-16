.PHONY: help build clean install screenshot logs start-emulator stop-emulator setup 2x test status kill match

help:
	@echo "Game of Go - Pebble Time 2 (Emery)"
	@echo ""
	@echo "Available commands:"
	@echo "  make setup             - Set up Pebble SDK (run once)"
	@echo "  make start-emulator    - Start QEMU emulator in background"
	@echo "  make 2x                - Make emulator with 2x scaling"
	@echo "  make status            - Check if emulator is running"
	@echo "  make stop-emulator     - Stop emulator"
	@echo "  make kill              - Force kill all pebble/qemu processes"
	@echo "  make build             - Build the app (PBW)"
	@echo "  make install           - Build and install on emulator"
	@echo "  make test              - Run native unit tests"
	@echo "  make match             - Run AI vs AI smoke test (requires running emulator)"
	@echo "  make screenshot        - Capture screenshot from emulator"
	@echo "  make logs              - View emulator logs"
	@echo "  make clean             - Remove build artifacts"
	@echo ""

setup:
	@echo "Setting up Pebble SDK..."
	@if [ ! -d "$$HOME/.pebble-sdk" ]; then pebble sdk install latest; else echo "✓ SDK already installed"; fi

emu: start-emulator
start-emulator:
	@bash scripts/emulator-control.sh start

# Scale emulator window to 2x
2x:
	@WINDOW_ID=$$(xdotool search --name QEMU | tail -1); \
	xdotool windowsize "$$WINDOW_ID" 400 456;

stop-emulator:
	@bash scripts/emulator-control.sh stop

status:
	@ps aux | grep "[q]emu-pebble" && echo "✓ Emulator is running" || echo "✗ Emulator is NOT running"

kill:
	@echo "Killing all Pebble and QEMU processes..."
	@pkill -9 pebble || true
	@pkill -9 qemu-pebble || true

match: install
	@echo "Starting AI vs AI match..."
	@pebble emu-button click back --emulator emery && sleep 0.5
	@pebble emu-button click down --emulator emery && sleep 0.5
	@pebble emu-button click select --emulator emery && sleep 0.5
	@pebble emu-button click down --emulator emery && sleep 0.2
	@pebble emu-button click down --emulator emery && sleep 0.2
	@pebble emu-button click down --emulator emery && sleep 0.5
	@pebble emu-button click select --emulator emery
	@echo "✓ Match started. Use 'make logs' to watch progress."

build:
	@echo "Building Game of Go..."
	pebble build
	@echo "✓ Build complete: build/go-game.pbw"

install: build start-emulator
	@echo "Installing on emulator..."
	pebble install --emulator emery
	@echo "✓ Installed on emulator"

test:
	@$(MAKE) -C tests run

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
