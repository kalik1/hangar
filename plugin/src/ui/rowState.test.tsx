import { act, render, renderHook, screen } from '@testing-library/react';
import React from 'react';
import { DONE_MS, RowStatus, useRowChange } from './rowState';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('a row change: idle → pending → done | failed', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is pending at once with what was asked, then done, then idle after a few seconds', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRowChange<boolean>());
    expect(result.current.state).toEqual({ phase: 'idle' });
    const p = deferred();
    let run!: Promise<void>;
    act(() => {
      run = result.current.run(true, () => p.promise);
    });
    expect(result.current.state).toEqual({ phase: 'pending', want: true });
    await act(async () => {
      p.resolve();
      await run;
    });
    expect(result.current.state).toEqual({ phase: 'done', want: true });
    act(() => {
      vi.advanceTimersByTime(DONE_MS);
    });
    expect(result.current.state).toEqual({ phase: 'idle' });
  });

  it('keeps a failure with its reason until the next change; run never rejects', async () => {
    const { result } = renderHook(() => useRowChange<boolean>());
    const why = new Error('denied');
    await act(() => result.current.run(false, () => Promise.reject(why)));
    expect(result.current.state).toEqual({ phase: 'failed', want: false, error: why });
    act(() => result.current.clear());
    expect(result.current.state).toEqual({ phase: 'idle' });
  });

  it('only the latest change counts', async () => {
    const { result } = renderHook(() => useRowChange<string>());
    const first = deferred();
    const second = deferred();
    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => {
      a = result.current.run('a', () => first.promise);
    });
    act(() => {
      b = result.current.run('b', () => second.promise);
    });
    await act(async () => {
      second.resolve();
      await b;
    });
    await act(async () => {
      first.reject(new Error('late'));
      await a;
    });
    expect(result.current.state).toEqual({ phase: 'done', want: 'b' });
  });

  it('RowStatus says nothing when idle, then the pending, done or failed words', () => {
    const words = { pending: 'Working…', done: 'Done.', failed: 'It failed.' };
    const { container, rerender } = render(<RowStatus state={{ phase: 'idle' }} {...words} />);
    expect(container.textContent).toBe('');
    rerender(<RowStatus state={{ phase: 'pending' }} {...words} />);
    expect(screen.getByRole('status').textContent).toBe('Working…');
    rerender(<RowStatus state={{ phase: 'done' }} {...words} />);
    expect(screen.getByRole('status').textContent).toBe('Done.');
    rerender(<RowStatus state={{ phase: 'failed', error: new Error('x') }} {...words} />);
    expect(screen.getByRole('alert').textContent).toBe('It failed.');
  });
});
