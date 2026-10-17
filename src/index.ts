import { DurableObject } from 'cloudflare:workers';
import { createApp } from './app.ts';
import { Counter } from './lib/limits.ts';
import type { Env } from './types.ts';

/** The spend meter: one instance (named "meter") holds every daily counter, so takes are serialized and caps are exact. */
export class MeterDO extends DurableObject<Env> {
  private counter = new Counter(this.ctx.storage.kv);
  take(...a: Parameters<Counter['take']>) {
    return this.counter.take(...a);
  }
  give(...a: Parameters<Counter['give']>) {
    return this.counter.give(...a);
  }
  used(...a: Parameters<Counter['used']>) {
    return this.counter.used(...a);
  }
}

export default createApp();
