import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { SurfaceView, useA2uiSession } from '@omochi-ui/renderer';
import { referenceId, type Dashboard, type DashboardPreset, type Panel } from './contracts.js';
import { placePanel } from './layout.js';
import { groupByNode, splitSurfaceId, subscribeServices, type ServiceView } from './services.js';

async function api<T>(path = '', method = 'GET', value?: unknown): Promise<T> {
  const response = await fetch(`/api/dashboards${path}`, {
    method, headers: value === undefined ? undefined : { 'Content-Type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Dashboard request failed');
  return data as T;
}
const emptyDashboard = (): Dashboard => ({ id: '', name: 'Untitled dashboard', revision: 0, panels: [] });

export default function App() {
  const session = useA2uiSession(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  const [services, setServices] = useState<ServiceView[]>([]);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [presets, setPresets] = useState<DashboardPreset[]>([]);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [search, setSearch] = useState('');
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 760px)').matches);
  const grid = useRef<HTMLDivElement>(null);
  const pickerDialog = useRef<HTMLDialogElement>(null);
  const gesture = useRef<{ id: string; mode: 'move' | 'resize'; x: number; y: number; column: number; panel: Panel; panels: Panel[] } | null>(null);
  const current = selected.startsWith('dashboard:') ? dashboards.find(d => `dashboard:${d.id}` === selected) : undefined;
  const preset = selected.startsWith('preset:') ? presets.find(p => `preset:${p.id}` === selected) : undefined;
  const active = draft ?? current ?? preset;
  const editing = draft !== null;
  const connected = session.status === 'Connected';

  const reload = async () => {
    setLoading(true);
    try {
      const [nextDashboards, nextPresets] = await Promise.all([
        api<Dashboard[]>(),
        fetch('/api/presets').then(async response => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.error ?? 'Preset request failed');
          return data as DashboardPreset[];
        }),
      ]);
      setDashboards(nextDashboards);
      setPresets(nextPresets);
      setSelected(id => {
        if (nextDashboards.some(d => `dashboard:${d.id}` === id) || nextPresets.some(p => `preset:${p.id}` === id)) return id;
        const search = new URLSearchParams(location.search);
        const requestedPreset = search.get('preset');
        if (requestedPreset && nextPresets.some(p => p.id === requestedPreset)) return `preset:${requestedPreset}`;
        const requestedDashboard = search.get('dashboard');
        if (requestedDashboard && nextDashboards.some(d => d.id === requestedDashboard)) return `dashboard:${requestedDashboard}`;
        return nextDashboards[0] ? `dashboard:${nextDashboards[0].id}` : nextPresets[0] ? `preset:${nextPresets[0].id}` : '';
      });
      setError(null);
    } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    if (!selected) return;
    const url = new URL(location.href);
    if (selected.startsWith('preset:')) {
      url.searchParams.set('preset', selected.slice('preset:'.length));
      url.searchParams.delete('dashboard');
    } else {
      url.searchParams.set('dashboard', selected.slice('dashboard:'.length));
      url.searchParams.delete('preset');
    }
    history.replaceState(null, '', url);
  }, [selected]);
  useEffect(() => {
    if (picker) pickerDialog.current?.showModal();
    else pickerDialog.current?.close();
  }, [picker]);
  useEffect(() => { const sub = subscribeServices('', setServices); return () => sub.close(); }, []);
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)');
    const change = () => { setNarrow(media.matches); gesture.current = null; };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!editing) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [editing]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const save = () => {
    if (!draft) return;
    void run(async () => {
      const saved = await api<Dashboard>(draft.id ? `/${draft.id}` : '', draft.id ? 'PUT' : 'POST', draft);
      setDashboards(all => [...all.filter(d => d.id !== saved.id), saved]);
      setSelected(`dashboard:${saved.id}`); setDraft(null); setPicker(false);
    });
  };
  const remove = () => {
    if (!current || !confirm(`Delete “${current.name}”?`)) return;
    void run(async () => {
      await api(`/${current.id}`, 'DELETE', { revision: current.revision });
      const next = dashboards.filter(d => d.id !== current.id);
      setDashboards(next); setSelected(presets[0] ? `preset:${presets[0].id}` : next[0] ? `dashboard:${next[0].id}` : '');
    });
  };
  const changePanel = (panel: Panel) => setDraft(d => d ? { ...d, panels: placePanel(d.panels, panel) } : d);
  const beginGesture = (event: PointerEvent<HTMLButtonElement>, panel: Panel, mode: 'move' | 'resize') => {
    if (narrow || !draft || busy || !grid.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { id: panel.id, mode, x: event.clientX, y: event.clientY,
      column: (grid.current.clientWidth + 16) / 12, panel, panels: draft.panels };
  };
  const moveGesture = (event: PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g || narrow) return;
    const dx = Math.round((event.clientX - g.x) / g.column);
    const dy = Math.round((event.clientY - g.y) / 56);
    const panel = g.mode === 'move' ? { ...g.panel, x: g.panel.x + dx, y: Math.min(100000, g.panel.y + dy) }
      : { ...g.panel, w: Math.min(12 - g.panel.x, Math.max(1, g.panel.w + dx)), h: Math.min(1000, Math.max(1, g.panel.h + dy)) };
    setDraft(d => d ? { ...d, panels: placePanel(g.panels, panel) } : d);
  };
  const endGesture = () => { gesture.current = null; };
  const addSurface = (service: ServiceView, id: string) => {
    if (!service.node || !draft) return;
    const surface = splitSurfaceId(id);
    const reference = { nodeId: service.node.id, serviceId: service.id.slice(service.node.id.length + 1), surfaceId: surface.surfaceId };
    if (draft.panels.some(p => referenceId(p.reference) === id)) return;
    const panel: Panel = { id: crypto.randomUUID(), title: `${service.name} · ${surface.surfaceId}`, reference,
      x: 0, y: Math.max(0, ...draft.panels.map(p => p.y + p.h)), w: 6, h: 6 };
    setDraft({ ...draft, panels: [...draft.panels, panel] });
    setPicker(false);
  };
  const panels = [...(active?.panels ?? [])].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups = groupByNode(services);
  const available = services.filter(s => s.status === 'connected').length;

  return <div className="hub-layout">
    <aside className="sidebar">
      <a className="brand" href="/" onClick={event => { if (editing) event.preventDefault(); }}><span className="brand-mark">o</span> omochi <span className="brand-tag">hub</span></a>
      <div className="nav-caption">WORKSPACE</div>
      {!!presets.length && <><div className="nav-section"><span>◇</span> Presets <span className="count">{presets.length}</span></div>
      <nav aria-label="Presets">
        {presets.map(p => <button key={p.id} className={`dashboard-link ${selected === `preset:${p.id}` ? 'selected' : ''}`} disabled={editing || busy}
          onClick={() => { setSelected(`preset:${p.id}`); setError(null); }}>{p.name}</button>)}
      </nav></>}
      <div className="nav-section"><span>▦</span> Dashboards <span className="count">{dashboards.length}</span></div>
      <nav aria-label="Dashboards">
        {dashboards.map(d => <button key={d.id} className={`dashboard-link ${selected === `dashboard:${d.id}` ? 'selected' : ''}`} disabled={editing || busy}
          onClick={() => { setSelected(`dashboard:${d.id}`); setError(null); }}>{d.name}</button>)}
        {!dashboards.length && <p className="sidebar-hint">Your dashboards will appear here.</p>}
      </nav>
      <button className="new-dashboard" disabled={editing || loading || busy} onClick={() => setDraft(emptyDashboard())}>＋ New dashboard</button>
      <div className="sidebar-footer"><span className={`signal ${connected ? 'online' : ''}`} />{connected ? 'Hub connected' : 'Reconnecting…'}<small>{available} apps available</small></div>
    </aside>
    <main className="workspace">
      <div className="breadcrumb">Workspace <span>/</span> Dashboards</div>
      <header className="page-header">
        <div><div className="eyebrow">YOUR WORKSPACE, COMPOSED</div>
          {editing ? <input className="dashboard-name" aria-label="Dashboard name" maxLength={200} value={draft.name} disabled={busy} onChange={e => setDraft({ ...draft, name: e.target.value })} />
            : <h1>{active?.name ?? 'Dashboards'}</h1>}
          <p className="subtitle">{editing ? 'Arrange your views, then save your dashboard.' : 'Live views from your apps, together in one place.'}</p>
        </div>
        <div className="toolbar">{editing ? <>
          <button disabled={busy} onClick={() => { setDraft(null); setPicker(false); setError(null); }}>Cancel</button>
          <button className="primary" disabled={busy || !draft.name.trim() || draft.panels.some(p => !p.title.trim())} onClick={save}>{busy ? 'Saving…' : 'Save dashboard'}</button>
        </> : current ? <>
          <button disabled={busy} onClick={remove}>Delete</button>
          <button className="primary" disabled={busy} onClick={() => setDraft(structuredClone(current))}>Edit dashboard</button>
        </> : preset ? <button className="primary" disabled={busy} onClick={() => setDraft({ ...structuredClone(preset), id: '', revision: 0 })}>Save as dashboard</button> : null}</div>
      </header>
      {error && <div className="notice error" role="alert"><span>{error}</span><button disabled={busy} onClick={() => {
        if (draft && !confirm('Discard your unsaved edits and reload the saved dashboards?')) return;
        setDraft(null); setPicker(false); void reload();
      }}>Reload saved dashboards</button></div>}
      {session.error && <div className="notice" role="status">{session.error}</div>}
      {narrow && editing && <div className="notice">Use a wider screen to move and resize panels. Your saved layout is preserved.</div>}
      {active && <div className="board-bar"><span><strong>{panels.length}</strong> {panels.length === 1 ? 'view' : 'views'} <span className="separator">/</span> {editing ? 'Editing' : 'Live dashboard'}</span>
        {editing && <button disabled={busy || panels.length >= 200} onClick={() => { setSearch(''); setPicker(true); }}>＋ Add view</button>}</div>}
      {loading ? <div className="empty-state">Loading dashboards…</div> : !panels.length ? <div className="empty-state">
        <div className="empty-symbol">▦</div><h2>{editing ? 'Start with a view' : active ? 'This dashboard is ready for views' : 'Make room for what matters'}</h2>
        <p>Bring views from your apps into a dashboard.<br />Arrange them to fit the way you work.</p>
        <button className="primary" disabled={busy || !!error} onClick={() => {
          if (!draft) setDraft(current ? structuredClone(current) : emptyDashboard());
          setSearch(''); setPicker(true);
        }}>＋ {active ? 'Add your first view' : 'Create a dashboard'}</button>
      </div> : <div ref={grid} className={`panel-grid ${editing ? 'editing' : ''}`}>
        {panels.map(panel => {
          const id = referenceId(panel.reference);
          const service = services.find(s => s.id === `${panel.reference.nodeId}~${panel.reference.serviceId}`);
          const present = connected && service?.status === 'connected' && session.surfaceIds.includes(id);
          return <article className="panel" key={panel.id} style={{ gridColumn: `${panel.x + 1} / span ${panel.w}`, gridRow: `${panel.y + 1} / span ${panel.h}` }}>
            <header className="panel-header">
              {editing && !narrow && <button aria-label={`Move ${panel.title}`} className="drag-handle" disabled={busy}
                onPointerDown={e => beginGesture(e, panel, 'move')} onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={endGesture}>⠿</button>}
              <div className="panel-heading">{editing ? <input aria-label={`Panel title ${panel.title}`} maxLength={200} disabled={busy} value={panel.title} onChange={e => changePanel({ ...panel, title: e.target.value })} /> : <h2>{panel.title}</h2>}
                <small>{service?.node?.name ?? panel.reference.nodeId} / {service?.name ?? panel.reference.serviceId}</small></div>
              {editing ? <button className="icon-button" aria-label={`Remove ${panel.title}`} disabled={busy} onClick={() => setDraft(d => d ? { ...d, panels: d.panels.filter(p => p.id !== panel.id) } : d)}>×</button>
                : <span className={`signal ${present ? 'online' : ''}`} title={present ? 'Live' : 'Unavailable'} />}
            </header>
            <div className="panel-content">{present ? <SurfaceView session={session} surfaceId={id} />
              : <div className="unavailable"><span>○</span><strong>View unavailable</strong><p>{service?.detail ?? 'Waiting for this app to publish its view.'}</p></div>}</div>
            {editing && !narrow && <footer className="panel-editor">
              {(['x', 'y', 'w', 'h'] as const).map(key => <label key={key}>{({ x: 'X', y: 'Y', w: 'W', h: 'H' })[key]}<input type="number" aria-label={`${panel.title} ${key}`} disabled={busy}
                min={key === 'w' || key === 'h' ? 1 : 0} max={key === 'x' ? 12 - panel.w : key === 'w' ? 12 - panel.x : key === 'h' ? 1000 : 100000}
                value={panel[key]} onChange={e => {
                  const value = e.target.valueAsNumber;
                  if (Number.isInteger(value) && e.target.validity.valid) changePanel({ ...panel, [key]: value });
                }} /></label>)}
              <button className="resize-handle" aria-label={`Resize ${panel.title}`} disabled={busy}
                onPointerDown={e => beginGesture(e, panel, 'resize')} onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={endGesture}>↘</button>
            </footer>}
          </article>;
        })}
      </div>}
      <footer className="workspace-footer">omochi hub <span>Views stay connected to their apps.</span></footer>
    </main>
    {picker && <dialog ref={pickerDialog} aria-labelledby="picker-title" className="picker" onCancel={() => setPicker(false)}>
      <header><div><div className="eyebrow">COMPOSE YOUR DASHBOARD</div><h2 id="picker-title">Add a view</h2></div><button aria-label="Close view picker" onClick={() => setPicker(false)}>×</button></header>
      <p>Choose a surface published by one of your apps.</p>
      <input autoFocus className="search" aria-label="Search views" placeholder="Search apps or views…" value={search} onChange={e => setSearch(e.target.value)} />
      <div className="view-options">
        {groups.map(group => <section key={group.node?.id ?? 'unknown'}><h3>{group.node?.name ?? 'Unknown machine'}</h3>
          {group.services.filter(s => s.node && s.status === 'connected').map(service => {
            const ids = session.surfaceIds.filter(id => splitSurfaceId(id).channelId === service.id && `${service.name} ${splitSurfaceId(id).surfaceId}`.toLowerCase().includes(search.toLowerCase()));
            return ids.length ? <div className="app-options" key={service.id}><h4>{service.name}</h4>{ids.map(id => {
              const added = draft?.panels.some(p => referenceId(p.reference) === id);
              return <button key={id} disabled={added} onClick={() => addSurface(service, id)}><span>▧ <strong>{splitSurfaceId(id).surfaceId}</strong></span><span>{added ? 'Added' : '＋ Add'}</span></button>;
            })}</div> : null;
          })}</section>)}
        {!session.surfaceIds.length && <p className="picker-empty">No views available yet. Start an app with a discoverable Unix socket to add its surfaces.</p>}
      </div>
      <footer>Each view is a live surface. Its state is shared with the app.</footer>
    </dialog>}
  </div>;
}
