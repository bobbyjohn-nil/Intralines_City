import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSink, report, resetErrorBusForTests } from './bus';
import type { ErrorLogEntry, ErrorSink } from './bus';
import type { ErrorReport } from './types';

// errors.md §1's own example: "a storage-full autosave firing every 10 s produces 3 toasts and one
// log row reading ×214, which is the honest number." 214 repeats, 10 s apart, is exactly the
// dedup + throttle behaviour this file exists to protect.
const STORAGE_FULL: ErrorReport = {
  severity: 'problem',
  source: 'save',
  code: 'quota',
  message: 'Storage is full — your company could not be saved. Export a save from Finance.',
};

function spySink(): { sink: ErrorSink; calls: Array<{ entry: ErrorLogEntry; notify: boolean }> } {
  const calls: Array<{ entry: ErrorLogEntry; notify: boolean }> = [];
  const sink: ErrorSink = (entry, notify) => calls.push({ entry: { ...entry }, notify });
  return { sink, calls };
}

beforeEach(() => {
  resetErrorBusForTests();
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('dedup — one row per source/code', () => {
  it('collapses repeats into a single entry with a correct running count', () => {
    const { sink, calls } = spySink();
    registerSink(sink);

    for (let i = 0; i < 214; i++) {
      vi.setSystemTime(i * 10_000); // every 10 s, per the spec's own example
      report(STORAGE_FULL);
    }

    expect(calls).toHaveLength(214);
    // 214 sink invocations (one per report call), but every one is the *same* row mutated in
    // place — see "reuses the exact same log row object" below for the identity check itself.
    expect(calls[213]!.entry.count).toBe(214);
    expect(calls[213]!.entry.source).toBe('save');
    expect(calls[213]!.entry.code).toBe('quota');
  });

  it('reuses the exact same log row object across repeats (no per-repeat allocation)', () => {
    const seen: ErrorLogEntry[] = [];
    registerSink((entry) => seen.push(entry));

    report(STORAGE_FULL);
    report(STORAGE_FULL);
    report(STORAGE_FULL);

    expect(seen[0]).toBe(seen[1]);
    expect(seen[1]).toBe(seen[2]);
    expect(seen[2]!.count).toBe(3);
  });

  it('never collapses two different source/code pairs into each other', () => {
    const seen: ErrorLogEntry[] = [];
    registerSink((entry) => seen.push({ ...entry }));

    report(STORAGE_FULL); // save/quota
    report({ severity: 'problem', source: 'pack', code: 'download-failed', message: 'x' });
    report(STORAGE_FULL);

    expect(seen).toHaveLength(3);
    expect(seen[0]!.count).toBe(1);
    expect(seen[1]!.count).toBe(1);
    expect(seen[1]!.source).toBe('pack');
    expect(seen[1]!.code).toBe('download-failed');
    expect(seen[2]!.count).toBe(2);
    expect(seen[2]!.source).toBe('save');
  });
});

describe('toast throttle — 120 s window and 3-per-session cap', () => {
  it('produces exactly 3 notify=true occurrences out of 214 repeats, one row reading ×214', () => {
    const { sink, calls } = spySink();
    registerSink(sink);

    for (let i = 0; i < 214; i++) {
      vi.setSystemTime(i * 10_000); // 10 s apart — spec's own storage-full cadence
      report(STORAGE_FULL);
    }

    const notified = calls.filter((c) => c.notify);
    expect(notified).toHaveLength(3);
    expect(calls[calls.length - 1]!.entry.count).toBe(214);
  });

  it('does not notify again for the same key inside the 120 s window', () => {
    const { sink, calls } = spySink();
    registerSink(sink);

    vi.setSystemTime(0);
    report(STORAGE_FULL); // 1st — earns notify
    vi.setSystemTime(60_000); // +60s, inside the 120s window
    report(STORAGE_FULL); // repeat — must not notify yet

    expect(calls[0]!.notify).toBe(true);
    expect(calls[1]!.notify).toBe(false);
  });

  it('notifies again once the 120 s window has fully elapsed', () => {
    const { sink, calls } = spySink();
    registerSink(sink);

    vi.setSystemTime(0);
    report(STORAGE_FULL); // 1st — notify
    vi.setSystemTime(120_000); // exactly the dedupe window later
    report(STORAGE_FULL); // 2nd — notify again

    expect(calls[0]!.notify).toBe(true);
    expect(calls[1]!.notify).toBe(true);
  });

  it('stops notifying after 3 toasts per session even with the window respected', () => {
    const { sink, calls } = spySink();
    registerSink(sink);

    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(i * 200_000); // always past the 120s window
      report(STORAGE_FULL);
    }

    expect(calls.map((c) => c.notify)).toEqual([true, true, true, false, false]);
  });
});

describe('zero sinks — safe to call before anything mounts', () => {
  it('does not throw when report() is called with no sinks registered', () => {
    expect(() => report(STORAGE_FULL)).not.toThrow();
  });

  it('queues pre-mount reports and delivers them, in order, when a sink registers', () => {
    report({ severity: 'problem', source: 'pack', code: 'download-failed', message: 'a' });
    report({ severity: 'problem', source: 'sim', code: 'worker-dead', message: 'b' });
    report({ severity: 'note', source: 'pwa', code: 'register-failed', message: 'c' });

    const { sink, calls } = spySink();
    registerSink(sink);

    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.entry.code)).toEqual(['download-failed', 'worker-dead', 'register-failed']);
  });

  it('delivers live reports directly once a sink is registered, without re-queueing', () => {
    const { sink, calls } = spySink();
    registerSink(sink);

    report(STORAGE_FULL);
    expect(calls).toHaveLength(1);
  });
});

describe('severity — note never toasts', () => {
  it('a note-severity report never earns notify, no matter how many times it repeats', () => {
    const { sink, calls } = spySink();
    registerSink(sink);

    const noteReport: ErrorReport = {
      severity: 'note',
      source: 'pwa',
      code: 'register-failed',
      message: 'SW registration failed while the app is already cached.',
    };

    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(i * 1_000_000); // well past any throttle window
      report(noteReport);
    }

    expect(calls.every((c) => c.notify === false)).toBe(true);
    expect(calls[calls.length - 1]!.entry.count).toBe(10);
  });
});

describe('sink safety', () => {
  it('drops a throwing sink for the rest of the session without surfacing to the caller', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwingSink: ErrorSink = () => {
      throw new Error('boom');
    };
    const { sink: goodSink, calls } = spySink();

    registerSink(throwingSink);
    registerSink(goodSink);

    expect(() => report(STORAGE_FULL)).not.toThrow();
    expect(calls).toHaveLength(1); // the good sink still got it

    // Second report — the throwing sink should no longer be invoked at all (already dropped).
    vi.setSystemTime(200_000);
    expect(() => report(STORAGE_FULL)).not.toThrow();
    expect(calls).toHaveLength(2);

    consoleErrorSpy.mockRestore();
  });
});
