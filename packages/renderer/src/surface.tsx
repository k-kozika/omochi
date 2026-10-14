import { useEffect, useState, type ReactNode } from 'react';
import { A2uiSurface, MarkdownContext } from '@a2ui/react/v0_9';
import { renderMarkdown } from '@a2ui/markdown-it';
import { A2uiWebSocketClient, type Processor } from './client.js';

/** One session per endpoint, shared by all of its rendered panels. */
export function useA2uiSession(url: string) {
  const [processor, setProcessor] = useState<Processor | null>(null);
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setProcessor(null);
    setStatus('Connecting…');
    setError(null);
    const client = new A2uiWebSocketClient(url, {
      onProcessor: setProcessor, onStatus: setStatus, onError: setError,
    });
    try { client.connect(); } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
    return () => client.close();
  }, [url]);
  const [surfaceIds, setSurfaceIds] = useState<string[]>([]);
  useEffect(() => {
    const sync = () => setSurfaceIds(processor ? [...processor.model.surfacesMap.keys()] : []);
    sync();
    if (!processor) return;
    const created = processor.onSurfaceCreated(sync);
    const deleted = processor.onSurfaceDeleted(sync);
    return () => { created.unsubscribe(); deleted.unsubscribe(); };
  }, [processor]);
  return { processor, surfaceIds, status, error };
}

export type A2uiSession = ReturnType<typeof useA2uiSession>;

export function SurfaceView({ session, surfaceId, fallback = null }: {
  session: A2uiSession; surfaceId: string; fallback?: ReactNode;
}) {
  const surface = session.processor?.model.surfacesMap.get(surfaceId);
  return <div className="omochi-surface a2ui-light">
    <MarkdownContext.Provider value={renderMarkdown}>
      {surface ? <A2uiSurface key={surfaceId} surface={surface} /> : fallback}
    </MarkdownContext.Provider>
  </div>;
}
