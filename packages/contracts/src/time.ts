import { z } from "zod";

export const UtcInstantSchema = z.iso.datetime({ offset: false });
export type UtcInstant = z.infer<typeof UtcInstantSchema>;

export interface Clock {
  now(): UtcInstant;
}

export class SystemClock implements Clock {
  now(): UtcInstant {
    return UtcInstantSchema.parse(new Date().toISOString());
  }
}

export class FixedClock implements Clock {
  readonly #instant: UtcInstant;

  constructor(instant: string) {
    this.#instant = UtcInstantSchema.parse(instant);
  }

  now(): UtcInstant {
    return this.#instant;
  }
}
