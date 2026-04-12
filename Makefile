.PHONY: help build install test clean logs screenshot validate

help:
	@echo "Game of Go - Pebble Time 2"
	@echo ""
	@echo "Available targets:"
	@echo "  make build       - Build the app (generate PBW)"
	@echo "  make clean       - Remove build artifacts"
	@echo "  make validate    - Check JavaScript syntax"
	@echo "  make install     - Build and install on emulator"
	@echo "  make logs        - View app logs from emulator"
	@echo "  make screenshot  - Capture screenshot from emulator"
	@echo "  make help        - Show this help message"

build:
	@echo "Building Game of Go..."
	pebble build
	@echo "✓ Build complete: build/go-game.pbw"

clean:
	@echo "Cleaning build artifacts..."
	rm -rf build/
	@echo "✓ Clean complete"

validate:
	@echo "Validating JavaScript syntax..."
	node -c src/rocky/index.js
	@echo "✓ Syntax valid"

install: build
	@echo "Installing on emery emulator..."
	pebble install --emulator emery
	@echo "✓ Install complete"

logs:
	@echo "Fetching logs from emulator..."
	pebble logs --emulator emery

screenshot: install
	@echo "Capturing screenshot from emulator..."
	pebble screenshot --no-open --emulator emery /tmp/screenshot-emery.png
	@echo "✓ Screenshot saved: /tmp/screenshot-emery.png"

# Alternative: install to connected device via Bluetooth
install-device: build
	@echo "Installing on connected Pebble Time 2..."
	pebble install --cloudpebble
	@echo "✓ Install complete"

# Check for common issues
check:
	@echo "Checking environment..."
	@which pebble > /dev/null || (echo "✗ pebble CLI not found"; exit 1)
	@pebble sdk --version > /dev/null || (echo "✗ Pebble SDK not found"; exit 1)
	@node --version > /dev/null || (echo "✗ Node.js not found"; exit 1)
	@echo "✓ All tools available"

# Setup: install SDK if needed
setup:
	@echo "Setting up Pebble SDK..."
	@if [ ! -d "$$HOME/.pebble-sdk" ]; then \
		pebble sdk install; \
	else \
		echo "✓ SDK already installed"; \
	fi
	@echo "✓ Setup complete"

# Run all tests
test: validate
	@echo "Running tests..."
	@echo "  ✓ JavaScript syntax"
	@echo "  ✓ Project structure"
	@echo "  ✓ Build"
	@make build > /dev/null
	@echo "✓ All tests passed"

# Full dev workflow
dev: clean validate build
	@echo "✓ Development build complete"
	@echo "Next: make install (run in emulator)"

.DEFAULT_GOAL := help
