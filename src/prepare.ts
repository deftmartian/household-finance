import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Fault } from './domain.js';
import type { Prepared } from './documents.js';

export async function prepare(bytes: Buffer): Promise<Prepared> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/lib',
    '/lib',
    '--symlink',
    'usr/lib64',
    '/lib64',
    '--dir',
    '/proc',
    '--dir',
    '/dev',
    '--dev-bind',
    '/dev/null',
    '/dev/null',
    '--dev-bind',
    '/dev/urandom',
    '/dev/urandom',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/app',
    '--ro-bind',
    resolve(root, 'dist'),
    '/app/dist',
    '--ro-bind',
    resolve(root, 'node_modules'),
    '/app/node_modules',
    '--ro-bind',
    process.execPath,
    '/node',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin',
    '--setenv',
    'LANG',
    'C.UTF-8',
    '--',
    '/usr/bin/prlimit',
    '--as=2147483648',
    '--cpu=45',
    '--fsize=33554432',
    '--nofile=128',
    '--',
    '/node',
    '--max-old-space-size=256',
    '/app/dist/prepare-worker.js',
  ];
  return new Promise((resolve, reject) => {
    const child = execFile(
      '/usr/bin/bwrap',
      args,
      {
        timeout: 60000,
        maxBuffer: 24 * 1024 * 1024,
        env: { PATH: '/usr/bin' },
      },
      (error, stdout) => {
        if (error) {
          reject(new Fault('document-preparation-failed'));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as Prepared);
        } catch {
          reject(new Fault('document-preparation-invalid'));
        }
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(bytes);
  });
}
