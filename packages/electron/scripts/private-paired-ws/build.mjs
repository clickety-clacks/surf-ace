import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';import {build} from 'esbuild';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../../../..'),out=process.env.PRIVATE_WS_BUILD_OUT;
if(!out||!path.isAbsolute(out)||fs.existsSync(out))throw Error('new absolute external build root required');fs.mkdirSync(path.join(out,'app'),{recursive:true});
const shared={bundle:true,format:'esm',platform:'node',target:'node24',alias:{'@surf-ace/protocol':path.join(repo,'packages/protocol/src/index.ts')},banner:{js:'import { createRequire as __privateCreateRequire } from "node:module"; const require = __privateCreateRequire(import.meta.url);'}};
await build({...shared,entryPoints:[path.join(here,'fixture.ts')],outfile:path.join(out,'app/fixture.mjs')});
await build({...shared,entryPoints:[path.join(here,'collector.mjs')],outfile:path.join(out,'collector.mjs')});
fs.copyFileSync(path.join(repo,'packages/protocol/schema.json'),path.join(out,'schema.json'));
const manifest={};for(const name of ['app/fixture.mjs','collector.mjs','schema.json'])manifest[name]=createHash('sha256').update(fs.readFileSync(path.join(out,name))).digest('hex');fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({out,manifestSha256:createHash('sha256').update(fs.readFileSync(path.join(out,'manifest.json'))).digest('hex')}));
