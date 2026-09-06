import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Fault } from './domain.js';
import { readBytes } from './http-client.js';
import type { Store } from './store.js';

export interface ModelConfig {
  key: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
  dailyTicks: number;
  reservationTicks: number;
  enabled: boolean;
}
export interface Interpreter {
  readonly name?: string;
  structured<T>(
    schema: z.ZodType<T>,
    instructions: string,
    input: unknown,
    images?: string[],
  ): Promise<T>;
}
export class Model implements Interpreter {
  private checkedAt = 0;
  get name(): string {
    return this.config.model;
  }
  constructor(
    readonly config: ModelConfig,
    readonly store: Store,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  private async call(body: unknown): Promise<unknown> {
    if (!this.config.enabled) throw new Fault('model-disabled');
    const callId = randomUUID();
    this.store.reserveCall(
      callId,
      this.config.reservationTicks,
      this.config.dailyTicks,
    );
    let response: Response;
    try {
      response = await this.fetcher('https://api.x.ai/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
      });
    } catch {
      throw new Fault('model-network-error', true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Fault(
        response.status === 402
          ? 'model-credits-exhausted'
          : `model-http-${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    if (response.headers.get('x-zero-data-retention') !== 'true') {
      await response.body?.cancel();
      this.checkedAt = 0;
      throw new Fault('model-zdr-required');
    }
    let value: unknown;
    try {
      value = JSON.parse(
        (await readBytes(response, 2 * 1024 * 1024)).toString('utf8'),
      );
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault('model-invalid-response');
    }
    const responseSchema = z.object({
      model: z.literal(this.config.model),
      status: z.literal('completed'),
      usage: z.object({
        cost_in_usd_ticks: z.number().int().safe().nonnegative(),
      }),
      output: z.array(
        z.object({
          type: z.string(),
          content: z
            .array(z.object({ type: z.string(), text: z.string().optional() }))
            .optional(),
        }),
      ),
    });
    const parsed = responseSchema.safeParse(value);
    if (!parsed.success) throw new Fault('model-invalid-response');
    this.store.recordCall(callId, parsed.data.usage.cost_in_usd_ticks);
    if (parsed.data.usage.cost_in_usd_ticks > this.config.reservationTicks) {
      this.store.setMeta('model-reservation-exceeded', 'true');
      throw new Fault('model-reservation-exceeded');
    }
    const outputs = parsed.data.output
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === 'output_text');
    if (outputs.length !== 1 || !outputs[0]?.text)
      throw new Fault('model-invalid-response');
    try {
      return JSON.parse(outputs[0].text);
    } catch {
      throw new Fault('model-invalid-json');
    }
  }
  async structured<T>(
    schema: z.ZodType<T>,
    instructions: string,
    input: unknown,
    images: string[] = [],
  ): Promise<T> {
    if (this.store.getMeta('model-reservation-exceeded') === 'true')
      throw new Fault('model-reservation-exceeded');
    if (Date.now() - this.checkedAt > 300000) {
      await this.call({
        model: this.config.model,
        store: false,
        max_output_tokens: 128,
        reasoning: { effort: 'low' },
        input: [{ role: 'user', content: 'Return {"ok":true}.' }],
        text: {
          format: {
            type: 'json_schema',
            name: 'privacy_check',
            strict: true,
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            },
          },
        },
      });
      this.checkedAt = Date.now();
    }
    const serialized = JSON.stringify(input);
    if (serialized.length > 100000 || images.length > 12)
      throw new Fault('model-context-limit');
    const content: unknown[] = [
      { type: 'input_text', text: serialized },
      ...images.map((base64) => ({
        type: 'input_image',
        image_url: `data:image/jpeg;base64,${base64}`,
      })),
    ];
    const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7' });
    const value = await this.call({
      model: this.config.model,
      store: false,
      max_output_tokens: 8000,
      reasoning: { effort: this.config.effort },
      input: [
        { role: 'system', content: instructions },
        { role: 'user', content },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'result',
          strict: true,
          schema: jsonSchema,
        },
      },
    });
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Fault('model-schema-mismatch');
    return parsed.data;
  }
}
