import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { Fault, id } from './domain.js';

const secretPath = z.string().refine(isAbsolute);
export const configSchema = z.strictObject({
  port: z.number().int().min(1024).max(65535).default(4380),
  dataDir: z.literal('/data'),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('CAD'),
  timezone: z.string().default('America/Halifax'),
  actual: z.strictObject({
    url: z.url(),
    budget: id,
    passwordFile: secretPath,
    readAccounts: z.array(id).min(1),
    writeAccounts: z.array(id).min(1),
    automaticCategories: z.array(id).min(1),
  }),
  talk: z.strictObject({
    url: z.url(),
    room: id,
    secretFile: secretPath,
    users: z.array(id).min(1).max(10),
    user: id,
    passwordFile: secretPath,
    botActor: z.string().regex(/^bots\/bot-[a-f0-9]{40}$/),
    archive: z
      .string()
      .regex(/^[\p{L}\p{N} _/-]+$/u)
      .refine(
        (s) => !s.includes('..') && !s.startsWith('/') && !s.endsWith('/'),
      ),
  }),
  model: z.strictObject({
    keyFile: secretPath,
    model: z.string().min(1),
    effort: z.enum(['low', 'medium', 'high']).default('medium'),
    dailyTicks: z.number().int().safe().positive(),
    reservationTicks: z.number().int().safe().positive(),
    enabled: z.boolean().default(false),
  }),
  activate: z.boolean().default(false),
});
export function secret(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o007) !== 0)
    throw new Fault('secret-permissions');
  const value = readFileSync(path, 'utf8').trim();
  if (!value || /[\r\n\0]/.test(value)) throw new Fault('secret-invalid');
  return value;
}
export function config(path: string) {
  const c = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const url = new URL(c.talk.url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Fault('nextcloud-origin');
  c.talk.url = url.origin;
  const actual = new URL(c.actual.url);
  if (
    !['http:', 'https:'].includes(actual.protocol) ||
    actual.username ||
    actual.password ||
    actual.search ||
    actual.hash
  )
    throw new Fault('actual-origin');
  if (c.actual.writeAccounts.some((a) => !c.actual.readAccounts.includes(a)))
    throw new Fault('account-scope');
  if (c.model.reservationTicks > c.model.dailyTicks)
    throw new Fault('model-budget');
  new Intl.DateTimeFormat('en', { timeZone: c.timezone });
  return c;
}
