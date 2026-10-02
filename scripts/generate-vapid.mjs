import { createECDH } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '.secrets', 'push-vapid.json');

try {
  const existing = JSON.parse(await readFile(output, 'utf8'));
  if (existing.publicKey && existing.privateKey) {
    console.log(`VAPID key pair already exists at ${output}`);
    console.log(`VAPID_PUBLIC_KEY=${existing.publicKey}`);
    process.exit(0);
  }
} catch {}

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const keys = {
  publicKey: ecdh.getPublicKey().toString('base64url'),
  privateKey: ecdh.getPrivateKey().toString('base64url'),
  generatedAt: new Date().toISOString(),
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(keys, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(`VAPID key pair created at ${output}`);
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log('The private key was written only to the ignored .secrets file and was not printed.');
