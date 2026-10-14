/** Persisted dashboard configuration. Surface contents remain owned by the app. */
export interface SurfaceReference {
  nodeId: string;
  serviceId: string;
  surfaceId: string;
}
export interface Panel {
  id: string;
  title: string;
  reference: SurfaceReference;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface DashboardInput {
  name: string;
  panels: Panel[];
}
export interface Dashboard extends DashboardInput {
  id: string;
  revision: number;
}
/** A read-only dashboard supplied by a running `omochi-ui up` composition. */
export interface DashboardPreset extends DashboardInput {
  id: string;
}
export interface DashboardFile {
  version: 1;
  dashboards: Dashboard[];
}
export function referenceId(reference: SurfaceReference): string {
  return `${reference.nodeId}~${reference.serviceId}/${reference.surfaceId}`;
}
export function overlaps(a: Pick<Panel, 'x' | 'y' | 'w' | 'h'>, b: Pick<Panel, 'x' | 'y' | 'w' | 'h'>): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
