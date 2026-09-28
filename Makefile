.PHONY: help build clean install screenshot logs start-emulator stop-emulator setup 2x test status kill kill-force wipe match run deploy deploy-lan deploy-tailscale btn-up btn-down btn-select btn-back emu emu-stop live-logs docker-build docker-up docker-down docker-logs docker-push remote-docker-pull remote-docker-compose-up

NAME := pebble-game-of-go
PHONE_IP := 192.168.0.37
PHONE_LAN_IP := 192.168.0.37
PHONE_TAILSCALE_IP := 100.107.175.36
GITLAB_IMAGE := registry.gitlab.com/igrek51/katago
GITLAB_TAG ?= 1.0
# Remote host for deploys (override: make remote-docker-pull SSH_HOST=user@other)
SSH_HOST ?= sirius
# Remote dir holding docker-compose.yaml on the host
REMOTE_DIR := /opt/katago

help:
	@echo "Targets:"
	@echo "  build / install / run / test / clean   Build, install on emulator, test"
	@echo "  emu / emu-stop / status / kill         Emulator control"
	@echo "  deploy / deploy-lan / deploy-tailscale Deploy PBW to physical watch"
	@echo "  btn-up / btn-down / btn-select / btn-back  Emulator button presses"
	@echo "  match                              Start AI vs AI demo on emulator"
	@echo "  screenshot / logs / live-logs      Capture screen, emulator/phone logs"
	@echo "  docker-build / docker-up / docker-down / docker-logs / docker-push"
	@echo "                                   KataGo AI server (docker, :2718)"
	@echo "  remote-docker-pull               Pull server image on remote host (SSH_HOST)"
	@echo "  remote-docker-compose-up         Ship compose file, start server on remote host"

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

# KataGo AI server (Human SL, serves pkjs): image ~400MB, first build
# downloads KataGo + nets (~165MB, pinned URLs in server/Dockerfile).
docker-build:
	@echo "Building KataGo server image..."
	docker build -t pebble-katago:1.0 ./server
	@echo "✓ Server image ready: pebble-katago:1.0"

docker-up:
	@echo "Starting KataGo server (health: up to ~3 min for model load)..."
	docker compose -f server/docker-compose.yml up -d --build
	@echo "✓ Server starting on :2718 (use 'make server-health')"

docker-down:
	docker compose -f server/docker-compose.yml down
	@echo "✓ Server stopped"

docker-logs:
	docker logs -f server-katago-1

# Push the server image to GitLab (https://gitlab.com/igrek51/katago ->
# container registry). Login once first:
#   docker login registry.gitlab.com   (PAT with write_registry scope)
# Override the tag:  make docker-push GITLAB_TAG=1.1
docker-push: docker-build
	@echo "Pushing $(GITLAB_IMAGE):$(GITLAB_TAG)..."
	docker tag pebble-katago:1.0 $(GITLAB_IMAGE):$(GITLAB_TAG)
	docker push $(GITLAB_IMAGE):$(GITLAB_TAG)
	@echo "✓ Pushed $(GITLAB_IMAGE):$(GITLAB_TAG)"

remote-docker-pull:
	ssh -t $(SSH_HOST) 'docker pull $(GITLAB_IMAGE):$(GITLAB_TAG)'

# Ship src/docker-compose.remote.yaml to the remote host as
# /opt/katago/docker-compose.yaml and (re)start the server there.
# Image tag follows GITLAB_TAG:
#   make remote-docker-compose-up GITLAB_TAG=1.1
remote-docker-compose-up:
	ssh -t $(SSH_HOST) 'mkdir -p $(REMOTE_DIR)'
	scp server/docker-compose.remote.yaml $(SSH_HOST):$(REMOTE_DIR)/docker-compose.yaml
	ssh -t $(SSH_HOST) 'cd $(REMOTE_DIR) && KATAGO_IMAGE=$(GITLAB_IMAGE):$(GITLAB_TAG) docker compose up -d'

deploy-server: docker-build docker-push remote-docker-pull remote-docker-compose-up

.DEFAULT_GOAL := help
