/**
 * Authorization module — layer 2 of the defense-in-depth gate.
 *
 * Layer 1 is the workflow-level `if:` gate on `author_association` (documented
 * in the example workflows; runs before our code). This module is layer 2: it
 * re-checks in code so that a misconfigured workflow still cannot let an
 * untrusted user run `/zai` commands.
 *
 * The signal is GitHub's pre-computed `author_association` — the authoritative
 * mapping of a commenter's relationship to the repo. No octokit, no
 * `getCollaboratorPermission` API call, no extra token scopes.
 *
 * `authorize` is a PURE function: no I/O, no async, never throws. It always
 * returns a result object. Misconfiguration (an unrecognized threshold) is
 * flagged via `unknownThreshold: true`, never raised as an exception.
 */

/**
 * Threshold -> allowed author_associations.
 *
 * A threshold `T` authorizes association `A` iff the value at `T` is non-null
 * and `THRESHOLD_ASSOCIATIONS[T].includes(A)`. A `null` value (`none`)
 * disables the association gate entirely (the workflow `if:` gate is the
 * primary control; `none` means "I am handling auth entirely in the workflow").
 *
 * @type {Record<string, string[] | null>}
 */
export const THRESHOLD_ASSOCIATIONS = {
  admin: ['OWNER'],
  maintain: ['OWNER', 'MEMBER'],
  write: ['OWNER', 'MEMBER', 'COLLABORATOR'], // default
  read: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'],
  none: null, // gate disabled (the fork guard still applies)
};

/**
 * Decide whether a commenter is authorized to run `/zai` commands.
 *
 * Logic order (implemented EXACTLY in this order):
 *  1. Resolve association: `comment.author_association ?? sender.author_association ?? null`.
 *  2. Resolve threshold (default `'write'`).
 *  3. Resolve the allowed set; an unknown threshold falls back to the `write`
 *     set (safest non-`none` default) AND records `unknownThreshold: true`.
 *  4. Association gate: if the gate is enabled (allowed !== null) AND the
 *     association is not in the set -> block silently.
 *  5. Fork gate: if `isFork === true` AND `allowForkCommands !== true` ->
 *     block silently. (Strict boolean equality on `isFork` to avoid
 *     truthy-string surprises.)
 *  6. Otherwise -> authorized.
 *
 * Never throws. Missing/null inputs are tolerated via optional chaining and
 * safe destructuring.
 *
 * @param {{
 *   comment?: { author_association?: string } | null,
 *   sender?: { author_association?: string } | null,
 *   isFork?: boolean,
 *   config?: { authThreshold?: string, allowForkCommands?: boolean } | null,
 * }} [input]
 * @returns {{
 *   authorized: boolean,
 *   silent: boolean,
 *   reason: 'authorized' | 'untrusted_association' | 'fork_not_allowed',
 *   association: string | null,
 *   threshold: string,
 *   unknownThreshold?: boolean,
 * }}
 */
export function authorize(input) {
  // Destructure defensively so `authorize(null)` / `authorize(undefined)` /
  // `authorize({})` never throw.
  const { comment, sender, isFork, config } = input ?? {};

  // 1. Resolve the association (comment wins, sender falls back).
  const assoc = comment?.author_association ?? sender?.author_association ?? null;

  // 2. Resolve the threshold (default 'write').
  const threshold = config?.authThreshold ?? 'write';

  // 3. Resolve the allowed set. An unknown threshold falls back to the `write`
  //    set (safest non-`none` default) and is flagged via `unknownThreshold`.
  const known = Object.prototype.hasOwnProperty.call(THRESHOLD_ASSOCIATIONS, threshold);
  const allowed = known ? THRESHOLD_ASSOCIATIONS[threshold] : THRESHOLD_ASSOCIATIONS.write;

  // Build the base result; append `unknownThreshold` only when the threshold
  // was not recognized (present in EVERY return path below).
  const base = { association: assoc, threshold };
  if (!known) {
    base.unknownThreshold = true;
  }

  // 4. Association gate (skipped entirely when allowed === null, i.e. `none`).
  if (allowed !== null && !allowed.includes(assoc)) {
    return {
      ...base,
      authorized: false,
      silent: true,
      reason: 'untrusted_association',
    };
  }

  // 5. Fork gate. Strict `=== true` so truthy non-booleans don't surprise us.
  if (isFork === true && config?.allowForkCommands !== true) {
    return {
      ...base,
      authorized: false,
      silent: true,
      reason: 'fork_not_allowed',
    };
  }

  // 6. Authorized.
  return { ...base, authorized: true, silent: false, reason: 'authorized' };
}
