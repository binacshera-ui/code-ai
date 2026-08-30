#!/usr/bin/env node
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(appRoot, 'server', 'personal-chrome');
const destination = path.join(appRoot, 'dist', 'personal-chrome');
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
