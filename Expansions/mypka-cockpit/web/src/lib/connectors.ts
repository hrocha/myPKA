// connectors.ts — types + helpers for the Connections page and the hub agenda.
//
// SECURITY SHAPE: every read here is secret-free by server construction — key
// NAMES and configured BOOLEANS only. The save helper sends a value once; it is
// never readable back through any endpoint.
import { cockpitWrite } from './useCockpitWrite';

export interface ConnectorKey {
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
}

export interface ConnectorInfo {
  id: string;
  label: string;
  kind: 'task' | 'calendar';
  /** Coverage bucket for the Connections page checklist. */
  category: 'tasks' | 'calendar' | 'email';
  help: string;
  configured: boolean;
  keys: ConnectorKey[];
}

export interface ConnectorsResponse {
  connectors: ConnectorInfo[];
  /** Stored .env key NAMES not yet claimed by a connector (awaiting AI wiring). */
  customKeys: string[];
  envPath: string;
}

export interface AgendaTask {
  id: string;
  source: string;
  title: string;
  due: string | null;
  dueBucket: 'overdue' | 'today';
  priorityRank: number;
  url: string | null;
}

export interface AgendaEvent {
  uid: string;
  source: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  url: string | null;
}

export interface AgendaPlanned {
  id: string;
  source: string;
  title: string;
  url: string | null;
}

export interface AgendaData {
  today: string;
  planned: AgendaPlanned[];
  tasks: AgendaTask[];
  events: AgendaEvent[];
  sources: {
    tasks: { source: string; ok: boolean; reason: string | null }[];
    calendar: { source: string; ok: boolean; reason: string | null }[];
  };
}

export function saveConnectorKey(key: string, value: string) {
  return cockpitWrite<{ ok: true; key: string; configured: boolean }>(
    '/api/cockpit/connectors/env', 'POST', { key, value },
  );
}

export function clearConnectorKey(key: string) {
  return cockpitWrite<{ ok: true; key: string; configured: boolean }>(
    `/api/cockpit/connectors/env/${encodeURIComponent(key)}`, 'DELETE', undefined,
  );
}
