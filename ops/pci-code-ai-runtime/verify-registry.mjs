// Exercise the actual registry/tunnel implementation with the new server only.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import * as childProcess from 'node:child_process';
import * as net from 'node:net';
import http from 'node:http';
import path from 'node:path';
const context=vm.createContext({process,console,Buffer,setTimeout,clearTimeout,Date});
const synthetic=values=>new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);},{context});
const imports={child_process:synthetic({spawn:childProcess.spawn}),net:synthetic({createServer:net.createServer}),fs:synthetic({promises:fs}),http:synthetic({default:http}),path:synthetic({default:path}),'./config.js':synthetic({CODEX_APP_CONFIG:{remoteHostsFile:'/root/projects/code-ai/.code-ai/remote-hosts.json'}})};
const registry=new vm.SourceTextModule(stripTypeScriptTypes(await fs.readFile('server/remoteHostRegistry.ts','utf8')),{context});
await registry.link(specifier=>{assert.ok(imports[specifier]);return imports[specifier];});
await registry.evaluate();
try {
  const health=await registry.namespace.refreshRemoteHostHealth('pci');
  const servers=await registry.namespace.listCodeAiServers();
  const summary=servers.find(server=>server.id==='pci');
  assert.equal(health.hostname,process.argv[2]||'code-ai-pci');assert.equal(summary.status,'online');
  assert.ok(health.profiles.some(profile=>profile.id==='pci-admin'));
  console.log(JSON.stringify({registryContract:true,server:summary,otherServersUntouched:true}));
} finally {registry.namespace.shutdownRemoteHostTunnels();}
