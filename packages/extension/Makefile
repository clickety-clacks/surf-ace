# Surf Ace extension — OpenClaw deploy packaging
#
# Targets:
#   package      Build self-contained deploy package at dist/openclaw-package/
#   deploy-provider  Package then rsync to the configured provider host
#   clean        Remove dist/openclaw-package/
#
# Deploy layout includes source files for inspection plus compiled runtime
# entries for installed OpenClaw package loading.

PKG_DIR := dist/openclaw-package
SURF_ACE_EXTENSION_DEPLOY_HOST ?=
export SURF_ACE_EXTENSION_DEPLOY_HOST
SURF_ACE_CONTINUITY_FILES := \
	surf-ace-provider-identity.json \
	surf-ace-runtime-state.json \
	surf-ace-runtime-screens.json \
	surf-ace-runtime-owner.lock \
	lockless-controller-identity.json
SURF_ACE_CONTINUITY_DIRECTORIES := lockless-endpoints
SURF_ACE_CONTINUITY_PROTECT_FILTERS := \
	$(foreach file,$(SURF_ACE_CONTINUITY_FILES),--filter='P /$(file)') \
	$(foreach directory,$(SURF_ACE_CONTINUITY_DIRECTORIES),--filter='P /$(directory)/***')
SURF_ACE_CONTINUITY_HIDE_FILTERS := \
	$(foreach file,$(SURF_ACE_CONTINUITY_FILES),--filter='H /$(file)') \
	$(foreach directory,$(SURF_ACE_CONTINUITY_DIRECTORIES),--filter='H /$(directory)/***')
SURF_ACE_CONTINUITY_FILTERS := $(SURF_ACE_CONTINUITY_PROTECT_FILTERS) $(SURF_ACE_CONTINUITY_HIDE_FILTERS)

.PHONY: package verify-package verify-deploy-state-preservation rollback-preflight deploy-provider guard-extension-deploy-config clean

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
	mkdir -p "$$tmpdir/src/dist" "$$tmpdir/src/lockless-endpoints/endpoint-a" \
		"$$tmpdir/dest/lockless-endpoints/endpoint-a/projection" \
		"$$tmpdir/dest/lockless-endpoints/endpoint-a/outbox" \
		"$$tmpdir/dest/lockless-endpoints/endpoint-a/receipts" \
		"$$tmpdir/dest/stale-package-directory"; \
	printf 'current-build\n' > "$$tmpdir/src/dist/surf-ace.js"; \
	for file in $(SURF_ACE_CONTINUITY_FILES); do \
		printf 'preserve:%s\n' "$$file" > "$$tmpdir/dest/$$file"; \
	done; \
	printf 'must-not-replace\n' > "$$tmpdir/src/lockless-controller-identity.json"; \
	printf 'must-not-replace\n' > "$$tmpdir/src/lockless-endpoints/endpoint-a/state.json"; \
	printf 'projection-state\n' > "$$tmpdir/dest/lockless-endpoints/endpoint-a/projection/state.json"; \
	printf 'outbox-state\n' > "$$tmpdir/dest/lockless-endpoints/endpoint-a/outbox/request.json"; \
	printf 'receipt-state\n' > "$$tmpdir/dest/lockless-endpoints/endpoint-a/receipts/receipt.json"; \
	cp -R "$$tmpdir/dest/lockless-endpoints" "$$tmpdir/expected-lockless-endpoints"; \
	printf 'remove-me\n' > "$$tmpdir/dest/stale-build-artifact.txt"; \
	printf 'remove-me-too\n' > "$$tmpdir/dest/stale-package-directory/artifact.js"; \
	rsync -a --delete $(SURF_ACE_CONTINUITY_FILTERS) "$$tmpdir/src/" "$$tmpdir/dest/"; \
	for file in $(SURF_ACE_CONTINUITY_FILES); do \
		test "$$(cat "$$tmpdir/dest/$$file")" = "preserve:$$file" || { echo "Continuity file was not preserved: $$file" >&2; exit 1; }; \
	done; \
	diff -r "$$tmpdir/expected-lockless-endpoints" "$$tmpdir/dest/lockless-endpoints" || { echo "Lockless endpoint state tree was not preserved byte-for-byte" >&2; exit 1; }; \
	test ! -e "$$tmpdir/dest/stale-build-artifact.txt" || { echo "Stale build artifact was not deleted" >&2; exit 1; }; \
	test ! -e "$$tmpdir/dest/stale-package-directory" || { echo "Stale package directory was not deleted" >&2; exit 1; }; \
	test "$$(cat "$$tmpdir/dest/dist/surf-ace.js")" = "current-build" || { echo "Build artifact was not synced" >&2; exit 1; }

rollback-preflight:
	@test -n "$(STATE_FILE)" || { printf '%s\n' "STATE_FILE is required" >&2; exit 1; }
	node scripts/rollback-preflight.mjs --state-file "$(STATE_FILE)"

guard-extension-deploy-config:
	node scripts/validate-deploy-host.mjs

deploy-provider: guard-extension-deploy-config verify-deploy-state-preservation package
	@deploy_host=$$(node scripts/validate-deploy-host.mjs); \
	rsync -av --delete $(SURF_ACE_CONTINUITY_FILTERS) $(PKG_DIR)/ "$$deploy_host:~/.openclaw/extensions/surf-ace/"

clean:
	rm -rf $(PKG_DIR)
