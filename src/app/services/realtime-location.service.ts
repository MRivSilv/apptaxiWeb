import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom } from 'rxjs';

export interface SessionLocation {
  session_id: string;
  nombre_completo?: string;
  patente?: string;
  empresa?: string;
  latitude: number;
  longitude: number;
  last_update?: string;
}

export interface DriverSession {
  session_id: string;
  nombre_completo?: string;
  patente?: string;
  empresa?: string;
}

type TransportMode = 'live' | 'fallback';

@Injectable({ providedIn: 'root' })
export class RealtimeLocationService implements OnDestroy {
  private readonly locationsSubject = new BehaviorSubject<SessionLocation[]>([]);
  private readonly activeSessionsSubject = new BehaviorSubject<DriverSession[]>([]);
  private readonly transportModeSubject = new BehaviorSubject<TransportMode>('fallback');
  private readonly connectedSubject = new BehaviorSubject<boolean>(false);

  readonly locations$ = this.locationsSubject.asObservable();
  readonly activeSessions$ = this.activeSessionsSubject.asObservable();
  readonly transportMode$ = this.transportModeSubject.asObservable();
  readonly connected$ = this.connectedSubject.asObservable();

  private ws?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private fallbackTimer?: ReturnType<typeof setInterval>;
  private reconnectAttempt = 0;

  private baseUrl = '';
  private token = '';

  constructor(private readonly http: HttpClient) {}

  ngOnDestroy(): void {
    this.stop();
  }

  async start(baseUrl: string, token: string): Promise<void> {
    this.baseUrl = this.normalizeBaseUrl(baseUrl);
    this.token = token;

    this.stopSocket();
    this.clearReconnectTimer();
    this.startFallbackLoop();

    this.connectWebSocket();
    await this.forceHttpSync(true);
  }

  stop(): void {
    this.stopSocket();
    this.clearReconnectTimer();
    this.stopFallbackLoop();
    this.connectedSubject.next(false);
    this.transportModeSubject.next('fallback');
    this.reconnectAttempt = 0;
  }

  async forceHttpSync(includeSessions: boolean): Promise<void> {
    if (!this.baseUrl || !this.token) {
      return;
    }

    const headers = this.authHeaders();

    try {
      const locationsRaw = await firstValueFrom(
        this.http.get<unknown>(`${this.baseUrl}/location/all/online`, { headers })
      );
      const parsedLocations = this.parseLocationsPayload(locationsRaw);
      this.locationsSubject.next(this.dedupeLocations(parsedLocations));
    } catch {
      // Fallback silencioso: el flujo de reconexión WS sigue intentándolo.
    }

    if (!includeSessions) {
      return;
    }

    try {
      const sessionsRaw = await firstValueFrom(
        this.http.get<unknown>(`${this.baseUrl}/sessions/active`, { headers })
      );
      const parsedSessions = this.parseSessionsPayload(sessionsRaw);
      this.activeSessionsSubject.next(this.dedupeSessions(parsedSessions));
    } catch {
      // No forzar error visual por sesión activa; mantenemos último estado válido.
    }
  }

  private connectWebSocket(): void {
    const wsUrl = this.buildWsUrl();
    if (!wsUrl) {
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      this.handleSocketDown();
      this.scheduleReconnect();
      return;
    }

    this.ws = socket;

    socket.onopen = () => {
      this.connectedSubject.next(true);
      this.transportModeSubject.next('live');
      this.reconnectAttempt = 0;
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      this.handleSocketMessage(event.data);
    };

    socket.onerror = () => {
      this.handleSocketDown();
    };

    socket.onclose = () => {
      if (this.ws === socket) {
        this.handleSocketDown();
        this.scheduleReconnect();
      }
    };
  }

  private handleSocketMessage(rawData: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(rawData);
    } catch {
      return;
    }

    if (!payload || typeof payload !== 'object') {
      return;
    }

    const body = payload as Record<string, unknown>;
    const type = typeof body['type'] === 'string' ? body['type'] : '';

    if (type === 'heartbeat') {
      return;
    }

    if ('locations' in body) {
      const parsedLocations = this.parseLocationsPayload(body['locations']);
      this.locationsSubject.next(this.dedupeLocations(parsedLocations));
    }

    if ('active_sessions' in body) {
      const parsedSessions = this.parseSessionsPayload(body['active_sessions']);
      this.activeSessionsSubject.next(this.dedupeSessions(parsedSessions));
    }
  }

  private handleSocketDown(): void {
    this.connectedSubject.next(false);
    this.transportModeSubject.next('fallback');
  }

  private scheduleReconnect(): void {
    if (!this.baseUrl || !this.token) {
      return;
    }

    this.clearReconnectTimer();
    const delay = Math.min(30000, Math.pow(2, this.reconnectAttempt) * 1000);
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.connectWebSocket();
      if (!this.connectedSubject.value) {
        void this.forceHttpSync(false);
      }
    }, delay);
  }

  private startFallbackLoop(): void {
    this.stopFallbackLoop();
    this.fallbackTimer = setInterval(() => {
      if (this.connectedSubject.value) {
        return;
      }

      void this.forceHttpSync(false);
    }, 15000);
  }

  private stopFallbackLoop(): void {
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = undefined;
    }
  }

  private stopSocket(): void {
    if (!this.ws) {
      return;
    }

    const socket = this.ws;
    this.ws = undefined;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private buildWsUrl(): string {
    if (!this.baseUrl || !this.token) {
      return '';
    }

    try {
      const parsed = new URL(this.baseUrl);
      parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/ws/location/stream`;
      parsed.searchParams.set('token', this.token);
      return parsed.toString();
    } catch {
      return '';
    }
  }

  private authHeaders(): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${this.token}` });
  }

  private normalizeBaseUrl(value: string | null | undefined): string {
    if (!value) {
      return '';
    }

    return value.trim().replace(/\/+$/, '');
  }

  private parseLocationsPayload(raw: unknown): SessionLocation[] {
    const rows = this.coerceArray(raw);
    const result: SessionLocation[] = [];
    let fallbackIndex = 0;

    for (const row of rows) {
      const sessionId =
        this.asText(
          this.pick(row, [
            'session_id',
            'id',
            'sessionId',
            'id_sesion',
            'id_session',
            'driver_id',
            'id_conductor'
          ])
        ) || `online-${++fallbackIndex}`;

      const latitude = this.asNumber(
        this.pickDeep(row, [
          'latitude',
          'lat',
          'y',
          'location.latitude',
          'location.lat',
          'coords.latitude',
          'coords.lat'
        ])
      );
      const longitude = this.asNumber(
        this.pickDeep(row, [
          'longitude',
          'lng',
          'lon',
          'x',
          'location.longitude',
          'location.lng',
          'location.lon',
          'coords.longitude',
          'coords.lng',
          'coords.lon'
        ])
      );

      if (latitude === null || longitude === null) {
        continue;
      }

      result.push({
        session_id: sessionId,
        nombre_completo: this.asText(this.pick(row, ['nombre_completo', 'full_name', 'driver_name'])),
        patente: this.asText(this.pick(row, ['patente', 'plate'])),
        empresa: this.asText(this.pick(row, ['empresa', 'company'])),
        latitude,
        longitude,
        last_update: this.asText(this.pick(row, ['last_update', 'updated_at']))
      });
    }

    return result;
  }

  private parseSessionsPayload(raw: unknown): DriverSession[] {
    const rows = this.coerceArray(raw);
    const result: DriverSession[] = [];

    for (const row of rows) {
      const sessionId = this.asText(this.pick(row, ['session_id', 'id', 'sessionId']));
      if (!sessionId) {
        continue;
      }

      result.push({
        session_id: sessionId,
        nombre_completo: this.asText(this.pick(row, ['nombre_completo', 'full_name', 'driver_name'])),
        patente: this.asText(this.pick(row, ['patente', 'plate'])),
        empresa: this.asText(this.pick(row, ['empresa', 'company']))
      });
    }

    return result;
  }

  private dedupeLocations(rows: SessionLocation[]): SessionLocation[] {
    const bySession = new Map<string, SessionLocation>();
    for (const row of rows) {
      bySession.set(row.session_id, row);
    }
    return Array.from(bySession.values());
  }

  private dedupeSessions(rows: DriverSession[]): DriverSession[] {
    const bySession = new Map<string, DriverSession>();
    for (const row of rows) {
      bySession.set(row.session_id, row);
    }
    return Array.from(bySession.values());
  }

  private coerceArray(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
    }

    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      for (const key of ['items', 'data', 'results', 'sessions', 'locations']) {
        const nested = obj[key];
        if (Array.isArray(nested)) {
          return nested.filter(
            (item): item is Record<string, unknown> => !!item && typeof item === 'object'
          );
        }
      }

      const objectValues = Object.values(obj).filter(
        (item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
      );
      if (objectValues.length) {
        return objectValues;
      }
    }

    return [];
  }

  private pick(source: unknown, keys: string[]): unknown {
    if (!source || typeof source !== 'object') {
      return undefined;
    }

    const row = source as Record<string, unknown>;
    for (const key of keys) {
      if (key in row) {
        return row[key];
      }
    }

    return undefined;
  }

  private pickDeep(source: unknown, paths: string[]): unknown {
    for (const path of paths) {
      const segments = path.split('.');
      let current: unknown = source;
      let found = true;

      for (const segment of segments) {
        if (!current || typeof current !== 'object') {
          found = false;
          break;
        }

        const record = current as Record<string, unknown>;
        if (!(segment in record)) {
          found = false;
          break;
        }

        current = record[segment];
      }

      if (found) {
        return current;
      }
    }

    return undefined;
  }

  private asText(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'number') {
      return String(value);
    }

    return undefined;
  }

  private asNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return null;
  }
}
