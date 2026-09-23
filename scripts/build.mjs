import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { staticFiles } from './static-files.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const file of staticFiles) {
  const source = resolve(root, file), text = await readFile(source, 'utf8');
  if (file.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', source], { encoding: 'utf8' });
    if (result.status !== 0) throw Error(result.stderr);
  }
  if (/sb_secret_[A-Za-z0-9_-]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) throw Error(`Secret found in ${file}`);
  for (const token of text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || []) {
    try { if (JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).role === 'service_role') throw Error('privileged'); }
    catch (e) { if (e.message === 'privileged') throw Error(`Service-role key found in ${file}`); }
  }
  const target = resolve(root, 'dist', file); await mkdir(dirname(target), { recursive: true }); await copyFile(source, target);
}
console.log(`Static PWA verified and built: ${staticFiles.length} allowlisted files in dist/. No server code or .env copied.`);
