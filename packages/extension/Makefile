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
SURF_ACE_CONTINUITY_FILES := \
	surf-ace-provider-identity.json \
	surf-ace-runtime-state.json \
	surf-ace-runtime-screens.json \
	surf-ace-runtime-owner.lock
SURF_ACE_CONTINUITY_PROTECT_FILTERS := $(foreach file,$(SURF_ACE_CONTINUITY_FILES),--filter='P /$(file)')

.PHONY: package verify-package verify-deploy-state-preservation deploy-tars guard-tars-extension-deploy clean

package:
	pnpm --dir ../protocol build
	pnpm --dir ../controller build
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
	mkdir -p $(PKG_DIR)/node_modules/@surf-ace/controller $(PKG_DIR)/node_modules/@surf-ace/protocol
	cp ../controller/package.json $(PKG_DIR)/node_modules/@surf-ace/controller/package.json
	rsync -a ../controller/dist/ $(PKG_DIR)/node_modules/@surf-ace/controller/dist/
	cp ../protocol/package.json $(PKG_DIR)/node_modules/@surf-ace/protocol/package.json
	cp ../protocol/schema.json $(PKG_DIR)/node_modules/@surf-ace/protocol/schema.json
	rsync -a ../protocol/dist/ $(PKG_DIR)/node_modules/@surf-ace/protocol/dist/

verify-package: package
	node scripts/verify-openclaw-package.mjs

verify-deploy-state-preservation:
	@tmpdir=$$(mktemp -d); \
	trap 'rm -rf "$$tmpdir"' EXIT; \
	mkdir -p "$$tmpdir/src/dist" "$$tmpdir/dest"; \
	printf 'current-build\n' > "$$tmpdir/src/dist/surf-ace.js"; \
	for file in $(SURF_ACE_CONTINUITY_FILES); do \
		printf 'preserve:%s\n' "$$file" > "$$tmpdir/dest/$$file"; \
	done; \
	printf 'remove-me\n' > "$$tmpdir/dest/stale-build-artifact.txt"; \
	rsync -a --delete $(SURF_ACE_CONTINUITY_PROTECT_FILTERS) "$$tmpdir/src/" "$$tmpdir/dest/"; \
	for file in $(SURF_ACE_CONTINUITY_FILES); do \
		test "$$(cat "$$tmpdir/dest/$$file")" = "preserve:$$file" || { echo "Continuity file was not preserved: $$file" >&2; exit 1; }; \
	done; \
	test ! -e "$$tmpdir/dest/stale-build-artifact.txt" || { echo "Stale build artifact was not deleted" >&2; exit 1; }; \
	test "$$(cat "$$tmpdir/dest/dist/surf-ace.js")" = "current-build" || { echo "Build artifact was not synced" >&2; exit 1; }

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
	rsync -av --delete $(SURF_ACE_CONTINUITY_PROTECT_FILTERS) $(PKG_DIR)/ $(SURF_ACE_EXTENSION_DEPLOY_HOST):~/.openclaw/extensions/surf-ace/

clean:
	rm -rf $(PKG_DIR)
