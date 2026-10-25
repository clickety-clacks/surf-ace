// Keep release-tooling tests runnable on their own while allowing workflow inputs to win in CI.
process.env.PRODUCT_TAG ??= "surf-ace-v0.2.10-rc2-r2";
process.env.TOOLING_TAG ??= "surf-ace-release-tooling-v0.2.10-rc2-r3";
