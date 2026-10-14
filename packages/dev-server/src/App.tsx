import { SurfaceView, useA2uiSession } from '@omochi-ui/renderer';
import '@omochi-ui/renderer/styles.css';
import { resolveWebSocketUrl } from './a2ui-websocket-client.js';
import './App.css';

function Preview({ url }: { url: string }) {
  const session = useA2uiSession(url);
  return <main className="dev-shell">
    <header className="dev-header"><span className="status" role="status">{session.status}</span></header>
    {session.error && <div className="error" role="alert">{session.error}</div>}
    <section className="surface-shell" aria-label="Application preview">
      {session.surfaceIds.length ? session.surfaceIds.map(id => <SurfaceView key={id} session={session} surfaceId={id} />)
        : <div className="empty">Waiting for an A2UI surface…</div>}
    </section>
  </main>;
}
export default function App() {
  try { return <Preview url={resolveWebSocketUrl(location)} />; }
  catch (error) { return <div className="error" role="alert">{String(error)}</div>; }
}
