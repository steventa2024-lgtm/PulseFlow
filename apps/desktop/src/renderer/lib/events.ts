import type { EngineEvent } from '@pulseflow/contracts';
import { useEffect } from 'react';
import { create } from 'zustand';

const listeners = new Set<(e: EngineEvent) => void>();

export function dispatchEngineEvent(e: EngineEvent): void {
  for (const fn of listeners) fn(e);
}

export function useEngineEvents(fn: (e: EngineEvent) => void, deps: unknown[] = []): void {
  useEffect(() => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export const useLive = create<{ connected: boolean; setConnected: (v: boolean) => void }>((set) => ({
  connected: false,
  setConnected: (connected) => set({ connected }),
}));
