import { THRESHOLD_ASSOCIATIONS, authorize } from '../src/lib/auth.js';

describe('THRESHOLD_ASSOCIATIONS', () => {
  test('exposes the exact threshold -> associations mapping', () => {
    expect(THRESHOLD_ASSOCIATIONS).toEqual({
      admin: ['OWNER'],
      maintain: ['OWNER', 'MEMBER'],
      write: ['OWNER', 'MEMBER', 'COLLABORATOR'],
      read: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'],
      none: null,
    });
  });

  test('the five tiers are the only keys', () => {
    expect(Object.keys(THRESHOLD_ASSOCIATIONS).sort()).toEqual(
      ['admin', 'maintain', 'none', 'read', 'write'],
    );
  });
});

describe('authorize — association gate (default threshold "write")', () => {
  test('OWNER passes', () => {
    expect(
      authorize({ comment: { author_association: 'OWNER' }, isFork: false, config: {} }),
    ).toEqual({
      authorized: true,
      silent: false,
      reason: 'authorized',
      association: 'OWNER',
      threshold: 'write',
    });
  });

  test('MEMBER passes', () => {
    expect(
      authorize({ comment: { author_association: 'MEMBER' }, isFork: false, config: {} }),
    ).toMatchObject({ authorized: true, reason: 'authorized', association: 'MEMBER' });
  });

  test('COLLABORATOR passes', () => {
    expect(
      authorize({
        comment: { author_association: 'COLLABORATOR' },
        isFork: false,
        config: {},
      }),
    ).toMatchObject({ authorized: true, reason: 'authorized' });
  });

  test('CONTRIBUTOR is blocked silently', () => {
    const r = authorize({
      comment: { author_association: 'CONTRIBUTOR' },
      isFork: false,
      config: {},
    });
    expect(r).toMatchObject({
      authorized: false,
      silent: true,
      reason: 'untrusted_association',
      association: 'CONTRIBUTOR',
      threshold: 'write',
    });
  });

  test('NONE is blocked silently', () => {
    const r = authorize({
      comment: { author_association: 'NONE' },
      isFork: false,
      config: {},
    });
    expect(r.authorized).toBe(false);
    expect(r.silent).toBe(true);
    expect(r.reason).toBe('untrusted_association');
  });

  test('FIRST_TIMER is blocked', () => {
    expect(
      authorize({
        comment: { author_association: 'FIRST_TIMER' },
        isFork: false,
        config: {},
      }).authorized,
    ).toBe(false);
  });

  test('FIRST_TIME_CONTRIBUTOR is blocked', () => {
    expect(
      authorize({
        comment: { author_association: 'FIRST_TIME_CONTRIBUTOR' },
        isFork: false,
        config: {},
      }).authorized,
    ).toBe(false);
  });

  test('MANNEQUIN is blocked', () => {
    expect(
      authorize({
        comment: { author_association: 'MANNEQUIN' },
        isFork: false,
        config: {},
      }).authorized,
    ).toBe(false);
  });
});

describe('authorize — threshold tiers change the gate', () => {
  test('admin: OWNER passes, MEMBER blocked', () => {
    expect(
      authorize({
        comment: { author_association: 'OWNER' },
        isFork: false,
        config: { authThreshold: 'admin' },
      }).authorized,
    ).toBe(true);
    expect(
      authorize({
        comment: { author_association: 'MEMBER' },
        isFork: false,
        config: { authThreshold: 'admin' },
      }),
    ).toMatchObject({ authorized: false, reason: 'untrusted_association' });
  });

  test('maintain: OWNER and MEMBER pass, COLLABORATOR blocked', () => {
    expect(
      authorize({
        comment: { author_association: 'OWNER' },
        isFork: false,
        config: { authThreshold: 'maintain' },
      }).authorized,
    ).toBe(true);
    expect(
      authorize({
        comment: { author_association: 'MEMBER' },
        isFork: false,
        config: { authThreshold: 'maintain' },
      }).authorized,
    ).toBe(true);
    expect(
      authorize({
        comment: { author_association: 'COLLABORATOR' },
        isFork: false,
        config: { authThreshold: 'maintain' },
      }).authorized,
    ).toBe(false);
  });

  test('read: CONTRIBUTOR passes; NONE still blocked', () => {
    expect(
      authorize({
        comment: { author_association: 'CONTRIBUTOR' },
        isFork: false,
        config: { authThreshold: 'read' },
      }).authorized,
    ).toBe(true);
    expect(
      authorize({
        comment: { author_association: 'NONE' },
        isFork: false,
        config: { authThreshold: 'read' },
      }).authorized,
    ).toBe(false);
  });

  test('none: ANY association passes when NOT a fork (gate disabled)', () => {
    for (const assoc of ['NONE', 'MANNEQUIN', 'CONTRIBUTOR', 'FIRST_TIMER']) {
      expect(
        authorize({
          comment: { author_association: assoc },
          isFork: false,
          config: { authThreshold: 'none' },
        }).authorized,
      ).toBe(true);
    }
  });

  test('none: unknown/null association passes because the gate is off', () => {
    expect(
      authorize({ comment: {}, isFork: false, config: { authThreshold: 'none' } }).authorized,
    ).toBe(true);
    expect(
      authorize({ comment: null, isFork: false, config: { authThreshold: 'none' } }).authorized,
    ).toBe(true);
  });
});

describe('authorize — unknown threshold', () => {
  test('falls back to the write set AND flags unknownThreshold', () => {
    const ok = authorize({
      comment: { author_association: 'COLLABORATOR' },
      isFork: false,
      config: { authThreshold: 'bogus' },
    });
    expect(ok).toMatchObject({
      authorized: true,
      reason: 'authorized',
      association: 'COLLABORATOR',
      threshold: 'bogus',
      unknownThreshold: true,
    });

    const blocked = authorize({
      comment: { author_association: 'CONTRIBUTOR' },
      isFork: false,
      config: { authThreshold: 'bogus' },
    });
    expect(blocked).toMatchObject({
      authorized: false,
      reason: 'untrusted_association',
      threshold: 'bogus',
      unknownThreshold: true,
    });
  });

  test('a recognized threshold does NOT set unknownThreshold', () => {
    const r = authorize({
      comment: { author_association: 'OWNER' },
      isFork: false,
      config: { authThreshold: 'admin' },
    });
    expect(r.unknownThreshold).toBeUndefined();
  });
});

describe('authorize — comment vs sender fallback', () => {
  test('association taken from comment.author_association when present', () => {
    const r = authorize({
      comment: { author_association: 'OWNER' },
      sender: { author_association: 'NONE' },
      isFork: false,
      config: {},
    });
    expect(r.association).toBe('OWNER');
    expect(r.authorized).toBe(true);
  });

  test('falls back to sender.author_association when comment lacks it', () => {
    const r = authorize({
      comment: {},
      sender: { author_association: 'MEMBER' },
      isFork: false,
      config: {},
    });
    expect(r.association).toBe('MEMBER');
    expect(r.authorized).toBe(true);
  });

  test('both missing -> association null and blocked', () => {
    const r = authorize({ comment: {}, sender: {}, isFork: false, config: {} });
    expect(r.association).toBeNull();
    expect(r.authorized).toBe(false);
    expect(r.reason).toBe('untrusted_association');
  });
});

describe('authorize — fork gate', () => {
  test('isFork true + allowForkCommands false blocks even OWNER', () => {
    const r = authorize({
      comment: { author_association: 'OWNER' },
      isFork: true,
      config: { allowForkCommands: false },
    });
    expect(r).toMatchObject({
      authorized: false,
      silent: true,
      reason: 'fork_not_allowed',
      association: 'OWNER',
    });
  });

  test('isFork true + allowForkCommands true + OWNER authorized', () => {
    const r = authorize({
      comment: { author_association: 'OWNER' },
      isFork: true,
      config: { allowForkCommands: true },
    });
    expect(r).toMatchObject({ authorized: true, reason: 'authorized' });
  });

  test('association gate runs BEFORE fork gate (CONTRIBUTOR on fork, write)', () => {
    const r = authorize({
      comment: { author_association: 'CONTRIBUTOR' },
      isFork: true,
      config: { allowForkCommands: true, authThreshold: 'write' },
    });
    expect(r.reason).toBe('untrusted_association');
    expect(r.reason).not.toBe('fork_not_allowed');
    expect(r.authorized).toBe(false);
  });

  test('isFork false -> fork gate never blocks (CONTRIBUTOR still blocked by association)', () => {
    const r = authorize({
      comment: { author_association: 'CONTRIBUTOR' },
      isFork: false,
      config: { allowForkCommands: false, authThreshold: 'write' },
    });
    expect(r.reason).toBe('untrusted_association');
  });

  test('isFork false -> OWNER authorized regardless of allowForkCommands', () => {
    const r = authorize({
      comment: { author_association: 'OWNER' },
      isFork: false,
      config: { allowForkCommands: false },
    });
    expect(r.authorized).toBe(true);
  });
});

describe('authorize — threshold "none" + fork are independent', () => {
  test('none + fork + allowForkCommands false still blocks at the fork gate', () => {
    const r = authorize({
      comment: { author_association: 'NONE' },
      isFork: true,
      config: { authThreshold: 'none', allowForkCommands: false },
    });
    expect(r).toMatchObject({
      authorized: false,
      silent: true,
      reason: 'fork_not_allowed',
      association: 'NONE',
    });
  });

  test('none + fork + allowForkCommands true authorizes a NONE commenter', () => {
    const r = authorize({
      comment: { author_association: 'NONE' },
      isFork: true,
      config: { authThreshold: 'none', allowForkCommands: true },
    });
    expect(r).toMatchObject({ authorized: true, reason: 'authorized' });
  });
});

describe('authorize — edge cases / hardening', () => {
  test('authorize({}) -> blocked, silent, association null, threshold write', () => {
    expect(authorize({})).toEqual({
      authorized: false,
      silent: true,
      reason: 'untrusted_association',
      association: null,
      threshold: 'write',
    });
  });

  test('authorize(null) does NOT throw and yields the blocked result', () => {
    expect(() => authorize(null)).not.toThrow();
    expect(authorize(null)).toMatchObject({
      authorized: false,
      reason: 'untrusted_association',
      association: null,
      threshold: 'write',
    });
  });

  test('authorize(undefined) does NOT throw', () => {
    expect(() => authorize(undefined)).not.toThrow();
    expect(authorize(undefined).authorized).toBe(false);
  });

  test('config missing entirely defaults threshold write + allowForkCommands false', () => {
    const r = authorize({ comment: { author_association: 'OWNER' }, isFork: true });
    // allowForkCommands defaults to !== true -> fork gate blocks OWNER.
    expect(r).toMatchObject({ reason: 'fork_not_allowed', threshold: 'write' });
  });

  test('isFork truthy non-boolean (1) is NOT treated as a fork (strict ===)', () => {
    const r = authorize({
      comment: { author_association: 'OWNER' },
      isFork: 1,
      config: { allowForkCommands: false },
    });
    expect(r.authorized).toBe(true);
  });

  test('isFork truthy string "true" is NOT treated as a fork (strict ===)', () => {
    const r = authorize({
      comment: { author_association: 'OWNER' },
      isFork: 'true',
      config: { allowForkCommands: false },
    });
    expect(r.authorized).toBe(true);
  });

  test('never throws on weird inputs (numbers, arrays)', () => {
    expect(() =>
      authorize({ comment: 42, sender: [], isFork: false, config: 'nope' }),
    ).not.toThrow();
  });
});

describe('authorize — return shape invariants', () => {
  test('authorized result has silent:false', () => {
    const r = authorize({
      comment: { author_association: 'OWNER' },
      isFork: false,
      config: {},
    });
    expect(r.silent).toBe(false);
  });

  test('blocked result always has silent:true', () => {
    const a = authorize({
      comment: { author_association: 'NONE' },
      isFork: false,
      config: {},
    });
    const b = authorize({
      comment: { author_association: 'OWNER' },
      isFork: true,
      config: { allowForkCommands: false },
    });
    expect(a.silent).toBe(true);
    expect(b.silent).toBe(true);
  });

  test('result always carries association + threshold fields', () => {
    const cases = [
      authorize({ comment: { author_association: 'OWNER' }, isFork: false, config: {} }),
      authorize({ comment: { author_association: 'NONE' }, isFork: false, config: {} }),
      authorize({ comment: { author_association: 'OWNER' }, isFork: true, config: {} }),
      authorize({}),
    ];
    for (const r of cases) {
      expect(r).toHaveProperty('association');
      expect(r).toHaveProperty('threshold');
      expect(typeof r.threshold).toBe('string');
    }
  });
});

describe('regression: the fork bypass is gone', () => {
  test('regression: a random NONE commenter is NOT authorized (the fork bypass is gone)', () => {
    // The fork's checkAuthorization returned { authorized: true } for any login.
    // A random NONE commenter on a normal (non-fork) PR must now be blocked.
    const r = authorize({
      comment: { author_association: 'NONE' },
      isFork: false,
      config: { authThreshold: 'write', allowForkCommands: false },
    });
    expect(r.authorized).toBe(false);
    expect(r.silent).toBe(true);
    expect(r.reason).toBe('untrusted_association');
    expect(r.association).toBe('NONE');
  });
});
