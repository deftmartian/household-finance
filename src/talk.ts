import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import { XMLParser } from 'fast-xml-parser';
import { Fault, key } from './domain.js';
import type { Source } from './domain.js';
import { MAX_FILE, sniff } from './documents.js';
import { readBytes, request } from './http-client.js';

export interface TalkConfig {
  url: string;
  room: string;
  secret: string;
  users: string[];
  user: string;
  password: string;
  archive: string;
  botActor: string;
}
export const attachmentSchema = z.strictObject({
  fileId: z.string().regex(/^\d+$/),
  etag: z
    .string()
    .min(1)
    .max(256)
    .refine((v) => !/[\r\n"]/.test(v)),
  size: z.number().int().safe().positive(),
  mediaType: z.string().max(150),
});
export type Attachment = z.infer<typeof attachmentSchema>;
export interface Message {
  id: string;
  speaker: string;
  message: string;
  parent: string | null;
  at: string;
  attachments: Attachment[];
}
export function webhook(
  bytes: Buffer,
  headers: Record<string, string | undefined>,
  config: TalkConfig,
): Message | null {
  const signature = headers['x-nextcloud-talk-signature'] ?? '',
    random = headers['x-nextcloud-talk-random'] ?? '';
  if (
    bytes.length > 512 * 1024 ||
    !/^[a-f0-9]{64}$/i.test(signature) ||
    !random ||
    random.length > 256
  )
    throw new Fault('webhook-signature');
  const expected = createHmac('sha256', config.secret)
    .update(random)
    .update(bytes)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
    throw new Fault('webhook-signature');
  if (
    (headers['x-nextcloud-talk-backend'] ?? '').replace(/\/$/, '') !==
    config.url
  )
    throw new Fault('webhook-backend');
  const activity = z
    .object({
      type: z.string(),
      actor: z.object({ type: z.string(), id: z.string() }),
      object: z.object({
        type: z.string(),
        id: z.union([z.string(), z.number()]),
        content: z.string(),
        inReplyTo: z.unknown().optional(),
      }),
      target: z.object({ id: z.string() }),
    })
    .parse(JSON.parse(bytes.toString()));
  if (
    !['Create', 'Activity'].includes(activity.type) ||
    activity.actor.type !== 'Person'
  )
    return null;
  if (activity.object.type !== 'Note' || activity.target.id !== config.room)
    throw new Fault('webhook-room');
  const speaker = activity.actor.id.replace(/^users\//, '');
  if (
    !config.users.includes(speaker) ||
    activity.actor.id !== `users/${speaker}`
  )
    throw new Fault('webhook-speaker');
  const content = z
    .object({
      message: z.string().max(16000),
      parameters: z
        .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
        .optional(),
    })
    .parse(JSON.parse(activity.object.content));
  const attachments = attachmentsFrom(content.parameters);
  const parent = z
    .object({ object: z.object({ id: z.union([z.string(), z.number()]) }) })
    .safeParse(activity.object.inReplyTo);
  return {
    id: String(activity.object.id),
    speaker,
    message: content.message === '{file}' ? '' : content.message,
    parent: parent.success ? String(parent.data.object.id) : null,
    at: new Date().toISOString(),
    attachments,
  };
}
function attachmentsFrom(parameters: unknown): Attachment[] {
  const attachments: Attachment[] = [];
  for (const p of Object.values(parameters ?? {})) {
    if (p && typeof p === 'object' && 'type' in p && p.type === 'file') {
      const file = z
        .object({
          id: z.union([z.string(), z.number()]),
          etag: z.string(),
          size: z.union([z.string(), z.number()]),
          mimetype: z.string(),
        })
        .parse(p);
      attachments.push(
        attachmentSchema.parse({
          fileId: String(file.id),
          etag: file.etag.replace(/^"|"$/g, ''),
          size: Number(file.size),
          mediaType: file.mimetype.split(';')[0]!.toLowerCase(),
        }),
      );
    }
  }
  if (attachments.length > 12) throw new Fault('attachment-count');
  return attachments;
}
function array(v: unknown): unknown[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object') throw new Fault('nextcloud-response');
  return v as Record<string, unknown>;
}
const chatSchema = z.object({
  id: z
    .union([z.number().int().safe().positive(), z.string().regex(/^[1-9]\d*$/)])
    .transform(String),
  token: z.string(),
  actorType: z.string(),
  actorId: z.string(),
  message: z.string(),
  messageType: z.string(),
  systemMessage: z.string(),
  referenceId: z.string().nullable().optional(),
  parent: z
    .object({
      id: z.union([z.number().int().safe(), z.string()]).transform(String),
    })
    .nullable()
    .optional(),
  messageParameters: z.unknown().optional(),
  timestamp: z.number().optional(),
});
export type ChatMessage = z.infer<typeof chatSchema>;
export function fromHistory(
  row: ChatMessage,
  config: TalkConfig,
): Message | null {
  if (row.token !== config.room) throw new Fault('talk-history-room');
  if (
    row.actorType !== 'users' ||
    !config.users.includes(row.actorId) ||
    row.systemMessage ||
    row.messageType !== 'comment'
  )
    return null;
  return {
    id: row.id,
    speaker: row.actorId,
    message: row.message === '{file}' ? '' : row.message,
    parent: row.parent?.id ?? null,
    at: new Date((row.timestamp ?? Date.now() / 1000) * 1000).toISOString(),
    attachments: attachmentsFrom(row.messageParameters),
  };
}
export class Talk {
  private readonly authorization: string;
  constructor(readonly config: TalkConfig) {
    this.authorization = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`;
  }
  private path(path: string): string {
    return `${this.config.url}/remote.php/dav/files/${encodeURIComponent(this.config.user)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  private async dav(url: string, init: RequestInit): Promise<Response> {
    return request(url, {
      ...init,
      headers: { authorization: this.authorization, ...init.headers },
    });
  }
  async download(a: Attachment): Promise<Buffer> {
    attachmentSchema.parse(a);
    const body = `<?xml version="1.0"?><d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:basicsearch><d:select><d:prop><d:getetag/><oc:fileid/><oc:size/></d:prop></d:select><d:from><d:scope><d:href>/files/${encodeURIComponent(this.config.user)}</d:href><d:depth>infinity</d:depth></d:scope></d:from><d:where><d:eq><d:prop><oc:fileid/></d:prop><d:literal>${a.fileId}</d:literal></d:eq></d:where><d:orderby/></d:basicsearch></d:searchrequest>`;
    const result = await this.dav(`${this.config.url}/remote.php/dav/`, {
      method: 'SEARCH',
      headers: { 'content-type': 'application/xml' },
      body,
    });
    if (result.status !== 207) throw new Fault('nextcloud-search-failed', true);
    const raw = (await readBytes(result, 512 * 1024)).toString();
    if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Fault('unsafe-xml');
    const xml = record(
      new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(raw),
    );
    const matches = array(record(xml.multistatus).response).flatMap((r) => {
      const response = record(r);
      return array(response.propstat).flatMap((p) => {
        const propstat = record(p);
        if (!String(propstat.status).includes('200')) return [];
        const prop = record(propstat.prop);
        return String(prop.fileid) === a.fileId
          ? [
              {
                href: String(response.href),
                etag: String(prop.getetag).replace(/^"|"$/g, ''),
                size: Number(prop.size),
              },
            ]
          : [];
      });
    });
    if (matches.length !== 1) throw new Fault('nextcloud-file-ambiguous');
    const match = matches[0]!;
    const url = new URL(match.href, this.config.url);
    const prefix = `/remote.php/dav/files/${encodeURIComponent(this.config.user)}/`;
    if (
      url.origin !== this.config.url ||
      !url.pathname.startsWith(prefix) ||
      match.etag !== a.etag ||
      match.size !== a.size
    )
      throw new Fault('nextcloud-metadata-mismatch');
    const response = await this.dav(url.href, {
      method: 'GET',
      headers: { 'if-match': `"${a.etag}"` },
    });
    if (response.status !== 200)
      throw new Fault('nextcloud-download-failed', response.status >= 500);
    const bytes = await readBytes(response, MAX_FILE);
    if (
      bytes.length !== a.size ||
      response.headers.get('etag')?.replace(/^"|"$/g, '') !== a.etag
    )
      throw new Fault('nextcloud-metadata-mismatch');
    // MIME aliases are not file identity. Verify bytes and parse in isolation.
    sniff(bytes);
    return bytes;
  }
  async archive(bytes: Buffer, messageId: string): Promise<Source> {
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    const mediaType = sniff(bytes);
    if (mediaType.startsWith('audio/')) throw new Fault('voice-not-supported');
    const extension =
      mediaType === 'application/pdf'
        ? 'pdf'
        : mediaType === 'image/jpeg'
          ? 'jpg'
          : mediaType === 'image/png'
            ? 'png'
            : mediaType === 'application/json'
              ? 'json'
              : mediaType.includes('spreadsheetml')
                ? 'xlsx'
                : 'txt';
    const folder = `${this.config.archive}/Originals`;
    await this.directory(folder);
    const path = `${folder}/${actualHash}.${extension}`;
    const url = this.path(path);
    const response = await this.dav(url, {
      method: 'PUT',
      headers: { 'if-none-match': '*', 'content-type': mediaType },
      body: new Uint8Array(bytes),
    });
    if (response.status === 412) {
      const existing = await this.dav(url, { method: 'GET' });
      if (
        !existing.ok ||
        (await import('node:crypto'))
          .createHash('sha256')
          .update(await readBytes(existing, MAX_FILE))
          .digest('hex') !== actualHash
      )
        throw new Fault('archive-content-conflict');
    } else if (![201, 204].includes(response.status))
      throw new Fault('archive-failed', true);
    return {
      hash: actualHash,
      url: await this.fileLink(url),
      mediaType,
      messageId,
    };
  }
  async directory(path: string): Promise<void> {
    let current = '';
    for (const part of path.split('/')) {
      current = current ? `${current}/${part}` : part;
      const r = await this.dav(this.path(current), { method: 'MKCOL' });
      if (![201, 405].includes(r.status))
        throw new Fault('archive-directory-failed', true);
      await r.body?.cancel();
    }
  }
  async details(
    purchaseId: string,
    revision: number,
    body: string,
  ): Promise<string> {
    const folder = `${this.config.archive}/Purchase Details`;
    await this.directory(folder);
    const url = this.path(`${folder}/${purchaseId}-${revision}.txt`);
    const r = await this.dav(url, {
      method: 'PUT',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'if-none-match': '*',
      },
      body,
    });
    if (r.status === 412) {
      const old = await this.dav(url, { method: 'GET' });
      if (!old.ok || (await readBytes(old, 512 * 1024)).toString() !== body)
        throw new Fault('detail-conflict');
    } else if (![201, 204].includes(r.status))
      throw new Fault('detail-publish-failed', true);
    return this.fileLink(url);
  }
  private async fileLink(url: string): Promise<string> {
    const response = await this.dav(url, {
      method: 'PROPFIND',
      headers: { depth: '0', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>',
    });
    if (response.status !== 207) throw new Fault('archive-link-failed', true);
    const parsed = new XMLParser({
      removeNSPrefix: true,
      parseTagValue: false,
    }).parse((await readBytes(response, 32768)).toString()) as unknown;
    const result = record(record(parsed).multistatus).response;
    const rows = Array.isArray(result) ? result : [result];
    const ids = rows.flatMap((row) => {
      const blocks = record(row).propstat;
      return (Array.isArray(blocks) ? blocks : [blocks]).flatMap((block) => {
        const value = record(block);
        const fileId = String(record(value.prop).fileid ?? '');
        return String(value.status).includes('200') &&
          /^[1-9][0-9]*$/.test(fileId)
          ? [fileId]
          : [];
      });
    });
    if (ids.length !== 1) throw new Fault('archive-link-ambiguous');
    return `${this.config.url}/index.php/f/${ids[0]}`;
  }
  async history(cursor?: string, future = false): Promise<ChatMessage[]> {
    const url = new URL(
      `${this.config.url}/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(this.config.room)}`,
    );
    url.search = new URLSearchParams({
      lookIntoFuture: future ? '1' : '0',
      limit: '200',
      setReadMarker: '0',
      noStatusUpdate: '1',
      markNotificationsAsRead: '0',
      timeout: '0',
      format: 'json',
      ...(cursor ? { lastKnownMessageId: cursor } : {}),
    }).toString();
    const response = await request(url.href, {
      headers: {
        authorization: this.authorization,
        accept: 'application/json',
        'ocs-apirequest': 'true',
      },
    });
    if (response.status === 304) return [];
    if (response.status !== 200) throw new Fault('talk-history-failed', true);
    const result = z
      .object({ ocs: z.object({ data: z.array(chatSchema) }) })
      .safeParse(
        JSON.parse((await readBytes(response, 2 * 1024 * 1024)).toString()),
      );
    if (
      !result.success ||
      result.data.ocs.data.some((r) => r.token !== this.config.room)
    )
      throw new Fault('talk-history-invalid');
    return result.data.ocs.data;
  }
  private async delivered(
    id: string,
    parent: string,
    body: string,
  ): Promise<string | undefined> {
    const rows = (await this.history()).filter(
      (r) => r.referenceId === key('reply', id),
    );
    if (!rows.length) return undefined;
    if (
      rows.length !== 1 ||
      rows[0]!.actorType !== 'bots' ||
      rows[0]!.actorId !== this.config.botActor.replace(/^bots\//, '') ||
      rows[0]!.message !== body ||
      (rows[0]!.parent?.id ?? '0') !== parent
    )
      throw new Fault('talk-reference-conflict');
    return rows[0]!.id;
  }
  async reply(id: string, parent: string, body: string): Promise<string> {
    const existing = await this.delivered(id, parent, body);
    if (existing) return existing;
    const random = randomBytes(32).toString('hex'),
      signature = createHmac('sha256', this.config.secret)
        .update(random)
        .update(body)
        .digest('hex');
    const response = await request(
      `${this.config.url}/ocs/v2.php/apps/spreed/api/v1/bot/${encodeURIComponent(this.config.room)}/message`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'ocs-apirequest': 'true',
          'x-nextcloud-talk-bot-random': random,
          'x-nextcloud-talk-bot-signature': signature,
        },
        body: JSON.stringify({
          message: body,
          ...(parent === '0' ? {} : { replyTo: Number(parent) }),
          referenceId: key('reply', id),
          silent: false,
        }),
      },
    );
    if (response.status !== 201) throw new Fault('talk-reply-failed', true);
    await response.body?.cancel();
    const delivered = await this.delivered(id, parent, body);
    if (!delivered) throw new Fault('talk-reply-uncertain', true);
    return delivered;
  }
}
