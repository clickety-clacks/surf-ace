# Surf Ace extension — OpenClaw deploy packaging
#
# Targets:
#   package      Build self-contained deploy package at dist/openclaw-package/
#   deploy-tars  Package then rsync to TARS ~/.openclaw/extensions/surf-ace/
#   clean        Remove dist/openclaw-package/
#
# Deploy layout includes source files for inspection plus compiled runtime
# entries for installed OpenClaw package loading.

PKG_DIR := dist/openclaw-package
TARS_EXTENSION_DEPLOY_HOST := tars.tail4105e8.ts.net
SURF_ACE_EXTENSION_DEPLOY_HOST ?= $(TARS_EXTENSION_DEPLOY_HOST)

.PHONY: package verify-package deploy-tars guard-tars-extension-deploy clean

package:
	pnpm exec tsc -p tsconfig.json
	rm -rf $(PKG_DIR)
	mkdir -p $(PKG_DIR)/extension/src $(PKG_DIR)/protocol/src $(PKG_DIR)/dist/protocol $(PKG_DIR)/skills
	cp openclaw.plugin.json $(PKG_DIR)/openclaw.plugin.json
	cp surf-ace.ts $(PKG_DIR)/surf-ace.ts
	printf '{\n  "name": "surf-ace",\n  "version": "0.1.0",\n  "type": "module",\n  "openclaw": {\n    "plugin": {\n      "id": "surf-ace",\n      "label": "Surf Ace"\n    },\n    "extensions": [\n      "./surf-ace.ts"\n    ],\n    "runtimeExtensions": [\n      "./dist/extension/src/index.js"\n    ]\n  },\n  "dependencies": {\n    "bonjour-service": "^1.3.0",\n    "ws": "^8.18.0"\n  }\n}\n' > $(PKG_DIR)/package.json
	printf 'export { default } from "./extension/src/index.js";\nexport * from "./extension/src/index.js";\n' > $(PKG_DIR)/dist/surf-ace.js
	rsync -a dist/extension/ $(PKG_DIR)/dist/extension/
	rsync -a dist/protocol/ $(PKG_DIR)/dist/protocol/
	cp ../protocol/schema.json $(PKG_DIR)/dist/protocol/schema.json
	rsync -a src/ $(PKG_DIR)/extension/src/
	rsync -a ../protocol/src/ $(PKG_DIR)/protocol/src/
	cp ../protocol/schema.json $(PKG_DIR)/protocol/schema.json
	rsync -a skills/ $(PKG_DIR)/skills/
	npm install --prefix $(PKG_DIR) --omit=dev --silent

verify-package: package
	node scripts/verify-openclaw-package.mjs

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
