.PHONY: help build clean install screenshot logs start-emulator stop-emulator setup 2x test status kill kill-force wipe match run deploy deploy-lan deploy-tailscale btn-up btn-down btn-select btn-back emu emu-stop live-logs

NAME := pebble-game-of-go
PHONE_IP := 192.168.0.37
PHONE_LAN_IP := 192.168.0.37
PHONE_TAILSCALE_IP := 100.107.175.36

help:
	@echo "Targets:"
	@echo "  build / install / run / test / clean   Build, install on emulator, test"
	@echo "  emu / emu-stop / status / kill         Emulator control"
	@echo "  deploy / deploy-lan / deploy-tailscale Deploy PBW to physical watch"
	@echo "  btn-up / btn-down / btn-select / btn-back  Emulator button presses"
	@echo "  match                              Start AI vs AI demo on emulator"
	@echo "  screenshot / logs / live-logs      Capture screen, emulator/phone logs"

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

emu-stop: stop-emulator

status:
	@ps aux | grep "[q]emu-pebble" && echo "✓ Emulator is running" || echo "✗ Emulator is NOT running"

kill:
	@echo "Killing all Pebble and QEMU processes..."
	@pkill -9 pebble || true
	@pkill -9 qemu-pebble || true

kill-force:
	@pkill -9 pebble 2>/dev/null || true
	@pkill -9 qemu-pebble 2>/dev/null || true

# Factory reset of Pebble OS emu
wipe:
	pebble wipe

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
	@echo "✓ Build complete: build/$(NAME).pbw"

install: build
	@echo "Installing on emulator..."
	@bash scripts/run-emu.sh
	@echo "✓ Installed on emulator"
run: install

test:
	@$(MAKE) -C tests run

screenshot: start-emulator
	@echo "Capturing screenshot..."
	pebble screenshot --no-open --emulator emery /tmp/screenshot-emery.png 2>/dev/null && \
		echo "✓ Screenshot: /tmp/screenshot-emery.png" || \
		echo "✗ Emulator not available (needs X11). Build only."

logs:
	@echo "Fetching emulator logs (Ctrl+C to stop)..."
	pebble logs --emulator emery

live-logs:
	pebble logs --phone $(PHONE_IP)

deploy: deploy-lan

deploy-lan: build
	@echo "Deploying to phone LAN ($(PHONE_LAN_IP))..."
	pebble install --phone $(PHONE_LAN_IP) build/$(NAME).pbw
	@echo "✓ Deploy complete"

deploy-tailscale: build
	@echo "Deploying to phone via tailscale ($(PHONE_TAILSCALE_IP))..."
	pebble install --phone $(PHONE_TAILSCALE_IP) build/$(NAME).pbw
	@echo "✓ Deploy complete"

# Button emulation helpers
btn-up:
	pebble emu-button click up --emulator emery

btn-down:
	pebble emu-button click down --emulator emery

btn-select:
	pebble emu-button click select --emulator emery

btn-back:
	pebble emu-button click back --emulator emery

btn-back-long:
	pebble emu-button click back --duration 2000 --emulator emery

clean:
	@echo "Cleaning build artifacts..."
	rm -rf build/
	@echo "✓ Clean complete"

.DEFAULT_GOAL := help
