/**
 * The organizer's durable profile: the prompt and schema a job was created for.
 *
 * A job carries these from creation to completion, and the organizer refuses a job whose profile
 * is not the one it was built for (`assertDurableProfile`), so replay and evaluation are always
 * stamped against the prompt that actually ran. That guard is only as good as the stamp: the
 * capture RPCs used to hardcode `'routing-v1'` in SQL, so bumping the organizer's constant
 * without a migration made every job fail closed the moment a newer organizer was live. The web
 * now sends these two values with every capture it creates, from this one definition, and the
 * SQL stores what it is given.
 */
export const ORGANIZER_PROMPT_VERSION = "routing-v3" as const;
export const ORGANIZER_SCHEMA_VERSION = 1 as const;

/** The shape a stored prompt version may take; the SQL and the organizer enforce the same rule. */
export const ORGANIZER_PROMPT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
