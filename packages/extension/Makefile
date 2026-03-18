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

.PHONY: package deploy-tars clean

package:
	rm -rf $(PKG_DIR)
	mkdir -p $(PKG_DIR)/extension/src $(PKG_DIR)/protocol/src $(PKG_DIR)/skills $(PKG_DIR)/node_modules
	cp openclaw.plugin.json $(PKG_DIR)/openclaw.plugin.json
	printf '{\n  "type": "module",\n  "openclaw": {\n    "extensions": [\n      "./extension/src/index.ts"\n    ]\n  },\n  "dependencies": {\n    "ws": "^8.18.0"\n  }\n}\n' > $(PKG_DIR)/package.json
	rsync -a src/ $(PKG_DIR)/extension/src/
	rsync -a ../protocol/src/ $(PKG_DIR)/protocol/src/
	rsync -a skills/ $(PKG_DIR)/skills/
	cp -r node_modules/ws $(PKG_DIR)/node_modules/ws

deploy-tars: package
	rsync -av --delete $(PKG_DIR)/ tars.tail4105e8.ts.net:~/.openclaw/extensions/surf-ace/

clean:
	rm -rf $(PKG_DIR)
