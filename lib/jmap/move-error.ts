import type { JmapErrorInfo } from './jmap-error';

/** A server's explicit refusal of a message or of the whole Email/set method. */
export type MoveEmailRejection = JmapErrorInfo;

/**
 * A bulk Move finished without confirming every requested message. IDs belong
 * to this call's authenticated client and owner, never to a global ID space.
 * Unknown requests may have been applied: losing an answer is not a rejection.
 */
export class MoveEmailsError extends Error {
  /** Legacy callers remove only IDs outside this conservative failure set. */
  get jmapFailedIds(): string[] {
    return [...new Set([...Object.keys(this.rejections), ...this.unknownIds, ...this.unattemptedIds])];
  }

  get jmapType(): string | undefined {
    return Object.values(this.rejections)[0]?.type;
  }

  get jmapProperties(): string[] | undefined {
    return Object.values(this.rejections)[0]?.properties;
  }

  constructor(
    message: string,
    readonly confirmedIds: string[],
    readonly rejections: Record<string, MoveEmailRejection>,
    readonly unknownIds: string[],
    readonly unattemptedIds: string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MoveEmailsError';
  }
}
