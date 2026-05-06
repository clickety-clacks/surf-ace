# Surf Ace extension — OpenClaw deploy packaging
#
# Targets:
#   package      Build self-contained deploy package at dist/openclaw-package/
#   deploy-tars  Package then rsync to TARS ~/.openclaw/extensions/surf-ace/
#   clean        Remove dist/openclaw-package/
#
# Deploy layout mirrors the monorepo so relative imports resolve:
#   extension/src/ (packages/extension/src/) imports ../../protocol/src/index.js
#   which resolves to protocol/src/ (packages/protocol/src/)

PKG_DIR := dist/openclaw-package
TARS_EXTENSION_DEPLOY_HOST := tars.tail4105e8.ts.net
SURF_ACE_EXTENSION_DEPLOY_HOST ?= $(TARS_EXTENSION_DEPLOY_HOST)

.PHONY: package deploy-tars guard-tars-extension-deploy clean

package:
	rm -rf $(PKG_DIR)
	mkdir -p $(PKG_DIR)/extension/src $(PKG_DIR)/protocol/src $(PKG_DIR)/skills
	cp openclaw.plugin.json $(PKG_DIR)/openclaw.plugin.json
	cp surf-ace.ts $(PKG_DIR)/surf-ace.ts
	printf '{\n  "type": "module",\n  "openclaw": {\n    "extensions": [\n      "./surf-ace.ts"\n    ]\n  },\n  "dependencies": {\n    "bonjour-service": "^1.3.0",\n    "ws": "^8.18.0"\n  }\n}\n' > $(PKG_DIR)/package.json
	rsync -a src/ $(PKG_DIR)/extension/src/
	rsync -a ../protocol/src/ $(PKG_DIR)/protocol/src/
	cp ../protocol/schema.json $(PKG_DIR)/protocol/schema.json
	rsync -a skills/ $(PKG_DIR)/skills/
	npm install --prefix $(PKG_DIR) --omit=dev --silent

guard-tars-extension-deploy:
	@case "$(SURF_ACE_EXTENSION_DEPLOY_HOST)" in \
		tars|tars.tail4105e8.ts.net|mike@tars|mike@tars.tail4105e8.ts.net) ;; \
		*) \
			if [ "$$SURF_ACE_ALLOW_NON_TARS_PROVIDER" = "1" ]; then \
				printf '%s\n' "WARNING: SURF_ACE_ALLOW_NON_TARS_PROVIDER=1 permits Surf Ace provider deploy to $(SURF_ACE_EXTENSION_DEPLOY_HOST)."; \
			else \
				printf '%s\n' "Refusing Surf Ace provider deploy to non-TARS host $(SURF_ACE_EXTENSION_DEPLOY_HOST)." >&2; \
				printf '%s\n' "Provider identity/state belongs on TARS only. Use the Electron client on eezo for display/testing." >&2; \
				printf '%s\n' "Set SURF_ACE_ALLOW_NON_TARS_PROVIDER=1 only for an explicit approved override." >&2; \
				exit 1; \
			fi; \
			;; \
	esac

deploy-tars: guard-tars-extension-deploy package
	rsync -av --delete $(PKG_DIR)/ $(SURF_ACE_EXTENSION_DEPLOY_HOST):~/.openclaw/extensions/surf-ace/

clean:
	rm -rf $(PKG_DIR)
