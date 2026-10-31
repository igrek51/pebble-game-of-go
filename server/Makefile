HOST       ?= titan
REMOTE_DIR ?= katago
IMAGE      ?= registry.gitlab.com/igrek51/registry/katago:latest
PLATFORM   ?=

.PHONY: deploy logs health ssh

deploy:
	DEPLOY_HOST=$(HOST) REMOTE_DIR=$(REMOTE_DIR) IMAGE=$(IMAGE) PLATFORM=$(PLATFORM) ./scripts/deploy.sh

logs:
	ssh $(HOST) "cd $(REMOTE_DIR) && docker compose logs -f --tail=100"

health:
	ssh $(HOST) "curl -fsS http://127.0.0.1:2718/health"

ssh:
	ssh $(HOST)
