// Build-time only: no npm, compiler or package-manager dependency on a user's machine.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp, mkdir, readFile, readdir, realpath, rm, writeFile, lstat, access} from 'node:fs/promises';
import {basename, delimiter, join, resolve, relative, sep, dirname} from 'node:path';
import {unzipSync} from 'fflate';
import {build} from 'esbuild';

const root=resolve(import.meta.dirname,'..');
const source=join(root,'scripts/retriever-runtime');
const output=join(root,'dist-retriever-runtime');
const platform=process.env.MEMCODE_PACKAGE_PLATFORM??process.platform;
const arch=process.env.MEMCODE_PACKAGE_ARCH??process.arch;
assert.ok((platform==='darwin'&&arch==='arm64')||(platform==='win32'&&arch==='x64'),'No reviewed local retriever runtime for this platform.');
assert.equal(platform,process.platform,'Stage local inference on its native build platform.');
assert.equal(arch,process.arch,'Stage local inference on its native build architecture.');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const lock=await readFile(join(source,'package-lock.json'));
const metadata=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
assert.equal(metadata.dependencies['@huggingface/transformers'],'4.3.2');
let npm;
for(const path of [process.env.npm_execpath,join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),resolve(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean)){
 try{await access(path);npm=path;break;}catch{}
}
// Homebrew can link npm into its prefix separately from the Node executable.
if (!npm && process.platform !== 'win32') {
 for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
  const candidate = await realpath(join(directory, 'npm')).catch(() => undefined);
  if (candidate && basename(candidate) === 'npm-cli.js') { npm = candidate; break; }
 }
}
assert.ok(npm,'The build-time Node installation must include npm; end users never need npm.');
// This dependency tree is isolated from the application and user projects.
execFileSync(process.execPath,[npm,'ci','--prefix',source,'--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,stdio:'inherit',windowsHide:true});
// The constant resolved target is verified before replacing our generated output.
assert.equal(output,join(root,'dist-retriever-runtime'));assert.ok(output.startsWith(root+sep));
await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
await cp(join(source,'node_modules'),join(output,'node_modules'),{recursive:true,dereference:false});
// The Node entry uses native ORT. Exclude the browser-only dependency subtree,
// including unused web binaries, while preserving the package dependency closure.
const needed=new Set();
async function need(name){
 if(name==='onnxruntime-web'||name==='sharp'||needed.has(name))return;
 const path=join(output,'node_modules',name);let pkg;
 try{pkg=JSON.parse(await readFile(join(path,'package.json'),'utf8'));}catch{return;}
 needed.add(name);
 for(const child of Object.keys({...pkg.dependencies,...pkg.optionalDependencies}))await need(child);
}
await need('@huggingface/transformers');
// Build a scoped text-only adapter, with a module alias rather than patching
// upstream source. No image-processing native code is distributed or loaded.
await build({entryPoints:[join(source,'text-only.mjs')],outfile:join(output,'node_modules/@huggingface/transformers/dist/transformers.node.mjs'),bundle:true,format:'esm',platform:'node',target:'node24',external:['onnxruntime-node','onnxruntime-common'],logLevel:'silent',plugins:[{name:'memcode-text-only',setup(build){build.onResolve({filter:/^sharp$/},()=>({path:'memcode-text-only-image',namespace:'memcode-text-only'}));build.onLoad({filter:/.*/,namespace:'memcode-text-only'},()=>({contents:"export default function imageProcessingUnavailable(){throw Error('The MemCode retrieval runtime supports text generation only; image processing is unavailable.');}",loader:'js'}));}}]});
await writeFile(join(output,'TEXT-ONLY-RUNTIME.txt'),'MemCode text-only retrieval adapter.\nBuilt from @huggingface/transformers 4.3.2, licensed Apache-2.0; original source and license remain in node_modules/@huggingface/transformers.\nThe generated Node entry is modified by a build-time module alias: unsupported image processing throws explicitly. Sharp and libvips are not distributed.\nONNX Runtime is pinned to 1.23.2 for macOS 13.5 compatibility and verified with the actual local model.\n');
const modules=join(output,'node_modules');
for(const entry of await readdir(modules,{withFileTypes:true})){
 if(entry.name==='.bin'||entry.name==='.package-lock.json'){const path=resolve(modules,entry.name);assert.ok(path.startsWith(output+sep));await rm(path,{recursive:true,force:true});continue;}
 if(!entry.isDirectory())continue;
 const names=entry.name.startsWith('@')?(await readdir(join(modules,entry.name))).map(name=>`${entry.name}/${name}`):[entry.name];
 for(const name of names)if(!needed.has(name)){const path=resolve(modules,name);assert.ok(path.startsWith(output+sep));await rm(path,{recursive:true,force:true});}
}
const native=join(output,'node_modules/onnxruntime-node/bin/napi-v6');
for(const entry of await readdir(native,{withFileTypes:true})){
 const target=resolve(native,entry.name);assert.ok(target.startsWith(native+sep));
 if(entry.name!==platform)await rm(target,{recursive:true,force:true});
 else for(const cpu of await readdir(target)){const path=resolve(target,cpu);assert.ok(path.startsWith(target+sep));if(cpu!==arch)await rm(path,{recursive:true,force:true});}
}
if(platform==='win32'){
 const engine=join(root,'dist-memtrace-engine');
 const pin=JSON.parse(await readFile(join(engine,'memcode-engine.json'),'utf8'));
 assert.equal(pin.platform,'windows');assert.equal(pin.arch,'x86_64');
 const archive=await readFile(join(engine,'engine.zip'));assert.equal(archive.length,pin.bytes);assert.equal(sha(archive),pin.sha256);
 const names=['msvcp140.dll','msvcp140_1.dll','vcruntime140.dll','vcruntime140_1.dll','LICENSE-MICROSOFT-VC.txt'];
 const files=unzipSync(archive,{filter:file=>names.includes(file.name)});
 for(const name of names){const entry=pin.files.find(file=>file.name===name);assert.ok(entry);const bytes=files[name];assert.equal(bytes.length,entry.bytes);assert.equal(sha(bytes),entry.sha256);await writeFile(join(native,platform,arch,name),bytes);}
}
// CPU inference needs no browser ONNX/WASM distribution or build scripts.
const packagePaths=[];
for(const entry of await readdir(join(output,'node_modules'),{withFileTypes:true})){
 if(!entry.isDirectory()||entry.name.startsWith('.'))continue;
 if(entry.name.startsWith('@'))for(const sub of await readdir(join(output,'node_modules',entry.name)))packagePaths.push(join(entry.name,sub));
 else packagePaths.push(entry.name);
}
// Microsoft's published npm archives omit their original project notices.
// Retain the exact upstream originals beside both packages, not a paraphrase.
for(const [name,bytes,checksum]of [['LICENSE',1073,'2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c'],['ThirdPartyNotices.txt',326866,'e9e90971a8e75a9a8ac0c6412e29c1202d079998389915aa485f46c816c3b4cc']]){
 const body=await readFile(join(source,'notices','onnxruntime-1.23.2',name));
 assert.equal(body.length,bytes);assert.equal(sha(body),checksum);
 for(const pkg of ['onnxruntime-node','onnxruntime-common']){
  const path=join(output,'node_modules',pkg);assert.equal(JSON.parse(await readFile(join(path,'package.json'),'utf8')).version,'1.23.2');await writeFile(join(path,name),body);
 }
}
const packages=[];
for(const packagePath of packagePaths){
 const path=join(output,'node_modules',packagePath);let pkg;
 try{pkg=JSON.parse(await readFile(join(path,'package.json'),'utf8'));}catch{continue;}
 const notices=[];
 for(const name of await readdir(path))if(/^(?:licen[cs]e|notice|copying|copyright|third.?party.?notices)/i.test(name)){
  const file=join(path,name);if((await lstat(file)).isFile())notices.push({file:relative(output,file).replaceAll('\\','/'),sha256:sha(await readFile(file))});
 }
 assert.ok(notices.length,`Missing original local inference license material: ${pkg.name}`);
 packages.push({name:pkg.name,version:pkg.version,license:pkg.license??'See original notices',notices});
}
const files=[];
const nativeMinimums=[];
function minimumMacOS(bytes){
 assert.equal(bytes.subarray(0,4).toString('hex'),'cffaedfe','The Mac retrieval runtime must contain native ARM64 Mach-O files.');assert.equal(bytes.readUInt32LE(4),0x0100000c);
 const count=bytes.readUInt32LE(16);let at=32;
 for(let i=0;i<count;i++){const cmd=bytes.readUInt32LE(at),size=bytes.readUInt32LE(at+4);assert.ok(size>=8&&at+size<=bytes.length);if(cmd===0x32||cmd===0x24){const value=bytes.readUInt32LE(at+(cmd===0x32?12:8));return[value>>>16,(value>>>8)&255,value&255];}at+=size;}
 throw Error('The native retrieval library lacks a macOS compatibility command.');
}
async function inventory(directory){for(const entry of await readdir(directory,{withFileTypes:true})){
 const file=join(directory,entry.name);if(entry.isSymbolicLink()){assert.ok(relative(output,file).startsWith('node_modules/.bin/'),'Unexpected runtime symlink');await rm(file);continue;}
 if(entry.isDirectory())await inventory(file);
 else if(entry.isFile()){const bytes=await readFile(file),name=relative(output,file).replaceAll('\\','/');files.push({name,bytes:bytes.length,sha256:sha(bytes)});if(platform==='darwin'&&/\.(?:node|dylib)$/.test(name)){const version=minimumMacOS(bytes);assert.ok(version[0]<13||(version[0]===13&&version[1]<=5),'The local retrieval runtime requires newer than supported macOS13.5.');nativeMinimums.push({name,minimumMacOS:version.join('.')});}}
}}
await inventory(output);
const entry='node_modules/@huggingface/transformers/dist/transformers.node.mjs';
assert.ok(files.some(file=>file.name===entry));
assert.ok(files.some(file=>file.name===`node_modules/onnxruntime-node/bin/napi-v6/${platform}/${arch}/onnxruntime_binding.node`));
assert.equal(files.some(file=>/^node_modules\/(?:sharp\/|@img\/sharp)/.test(file.name)),false,'Image-processing native packages must never ship in the text retrieval runtime.');
if(platform==='darwin')assert.ok(nativeMinimums.length>=2,'Verify both ONNX native binding and library.');
await writeFile(join(output,'THIRD_PARTY_NOTICES.json'),JSON.stringify({packages},null,2)+'\n');
await writeFile(join(output,'provenance.json'),JSON.stringify({schema:1,version:'4.3.2',onnxRuntimeVersion:'1.23.2',textOnly:true,sharpExcluded:true,platform,arch,entry,packageLockSha256:sha(lock),nativeMinimums,files},null,2)+'\n');
execFileSync(process.execPath,['--input-type=module','-e',`const {pathToFileURL}=await import('node:url');const p=await import(pathToFileURL(process.argv[1]).href);if(typeof p.pipeline!=='function')throw Error('Missing pipeline');`,join(output,entry)],{cwd:output,windowsHide:true,stdio:'inherit'});
console.log(JSON.stringify({kind:'memcode-retriever-runtime',platform,arch,version:'4.3.2',files:files.length,packages:packages.length,bytes:files.reduce((n,f)=>n+f.bytes,0),allOriginalNoticesRetained:true,modelWeightsBundled:false}));
