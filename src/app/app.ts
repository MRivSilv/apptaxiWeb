import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import * as L from 'leaflet';

interface AuthResponse {
  access_token: string;
  token_type: string;
  user_id: string;
  role: string;
  email: string;
  full_name: string;
}

interface SessionLocation {
  session_id: string;
  nombre_completo?: string;
  patente?: string;
  empresa?: string;
  latitude: number;
  longitude: number;
  last_update?: string;
}

interface DriverSession {
  session_id: string;
  nombre_completo?: string;
  patente?: string;
  empresa?: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements AfterViewInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly storage = this.getStorage();

  @ViewChild('mapContainer')
  mapContainer?: ElementRef<HTMLDivElement>;

  readonly apiBaseUrl = signal(this.normalizeBaseUrl(this.storage.getItem('api_base_url')) || 'http://127.0.0.1:8000');
  readonly email = signal(this.storage.getItem('admin_email') || '');
  readonly password = signal('');
  readonly token = signal(this.storage.getItem('admin_token') || '');

  readonly loading = signal(false);
  readonly mapLoading = signal(false);
  readonly mapError = signal('');
  readonly authError = signal('');
  readonly lastRefresh = signal<Date | null>(null);
  readonly onlineLocations = signal<SessionLocation[]>([]);
  readonly activeSessions = signal<DriverSession[]>([]);

  private map?: L.Map;
  private markersLayer = L.layerGroup();
  private refreshTimer?: ReturnType<typeof setInterval>;

  ngAfterViewInit(): void {
    if (this.token()) {
      this.initializeMap();
      void this.refreshMapData();
      this.startAutoRefresh();
    }
  }

  ngOnDestroy(): void {
    this.clearRefreshTimer();
    this.map?.remove();
  }

  get isLoggedIn(): boolean {
    return !!this.token();
  }

  async loginAdmin(event: Event): Promise<void> {
    event.preventDefault();
    this.authError.set('');
    this.loading.set(true);

    try {
      const baseUrl = this.normalizeBaseUrl(this.apiBaseUrl()) || 'http://127.0.0.1:8000';
      const response = await firstValueFrom(
        this.http.post<AuthResponse>(`${baseUrl}/auth/login`, {
          email: this.email().trim(),
          password: this.password()
        })
      );

      this.token.set(response.access_token);
      this.password.set('');

      this.storage.setItem('admin_token', response.access_token);
      this.storage.setItem('admin_email', response.email);
      this.storage.setItem('api_base_url', baseUrl);
      this.apiBaseUrl.set(baseUrl);

      queueMicrotask(() => {
        this.initializeMap();
        void this.refreshMapData();
        this.startAutoRefresh();
      });
    } catch {
      this.authError.set('No se pudo iniciar sesión. Revisa credenciales o URL del backend.');
    } finally {
      this.loading.set(false);
    }
  }

  logout(): void {
    this.clearRefreshTimer();
    this.token.set('');
    this.onlineLocations.set([]);
    this.activeSessions.set([]);
    this.lastRefresh.set(null);
    this.mapError.set('');
    this.storage.removeItem('admin_token');
    this.map?.remove();
    this.map = undefined;
    this.markersLayer = L.layerGroup();
  }

  async useCurrentSession(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.token()) {
      return;
    }

    const normalized = this.normalizeBaseUrl(this.apiBaseUrl());
    if (!normalized) {
      return;
    }

    this.apiBaseUrl.set(normalized);
    this.storage.setItem('api_base_url', normalized);
    await this.refreshMapData();
  }

  async refreshMapData(): Promise<void> {
    if (!this.token()) {
      return;
    }

    this.mapLoading.set(true);
    this.mapError.set('');

    try {
      const headers = this.adminHeaders();
      const baseUrl = this.normalizeBaseUrl(this.apiBaseUrl());
      if (!baseUrl) {
        throw new Error('Missing API base URL');
      }

      const [locationRaw, activeRaw] = await Promise.all([
        firstValueFrom(this.http.get<unknown>(`${baseUrl}/location/all/online`, { headers })),
        firstValueFrom(this.http.get<unknown>(`${baseUrl}/sessions/active`, { headers }))
      ]);

      const locations = this.parseLocations(locationRaw);
      const sessions = this.parseSessions(activeRaw);

      this.onlineLocations.set(locations);
      this.activeSessions.set(sessions);
      this.lastRefresh.set(new Date());

      this.drawMarkers(locations);
    } catch {
      this.mapError.set('No se pudo actualizar el mapa. Verifica token y disponibilidad del backend.');
    } finally {
      this.mapLoading.set(false);
    }
  }

  displayName(location: SessionLocation): string {
    return location.nombre_completo || location.patente || location.session_id;
  }

  displayPlate(location: SessionLocation): string {
    return location.patente || 'Sin patente';
  }

  private initializeMap(): void {
    if (!this.mapContainer || this.map) {
      return;
    }

    this.map = L.map(this.mapContainer.nativeElement, {
      center: [-33.4489, -70.6693],
      zoom: 11
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(this.map);

    this.markersLayer.addTo(this.map);
  }

  private drawMarkers(locations: SessionLocation[]): void {
    if (!this.map) {
      return;
    }

    this.markersLayer.clearLayers();

    const points: L.LatLngExpression[] = [];
    for (const location of locations) {
      const marker = L.circleMarker([location.latitude, location.longitude], {
        radius: 8,
        color: '#0b4f8a',
        weight: 2,
        fillColor: '#1d9bf0',
        fillOpacity: 0.9
      });
      marker.bindPopup(`
        <strong>${this.displayName(location)}</strong><br>
        Patente: ${this.displayPlate(location)}<br>
        Empresa: ${location.empresa || 'N/A'}<br>
        Sesión: ${location.session_id}<br>
        Coordenadas: ${location.latitude}, ${location.longitude}
      `);
      marker.addTo(this.markersLayer);
      points.push([location.latitude, location.longitude]);
    }

    if (points.length === 1) {
      this.map.setView(points[0], 15);
    } else if (points.length > 1) {
      this.map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
    }
  }

  private startAutoRefresh(): void {
    this.clearRefreshTimer();
    this.refreshTimer = setInterval(() => {
      void this.refreshMapData();
    }, 8000);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private adminHeaders(): HttpHeaders {
    return new HttpHeaders({
      Authorization: `Bearer ${this.token()}`
    });
  }

  private parseLocations(raw: unknown): SessionLocation[] {
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

  private parseSessions(raw: unknown): DriverSession[] {
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

  private getStorage(): StorageLike {
    const rawStorage = globalThis.localStorage as Partial<StorageLike> | undefined;

    if (
      rawStorage &&
      typeof rawStorage.getItem === 'function' &&
      typeof rawStorage.setItem === 'function' &&
      typeof rawStorage.removeItem === 'function'
    ) {
      return rawStorage as StorageLike;
    }

    const fallback = new Map<string, string>();
    return {
      getItem(key: string): string | null {
        return fallback.has(key) ? fallback.get(key)! : null;
      },
      setItem(key: string, value: string): void {
        fallback.set(key, value);
      },
      removeItem(key: string): void {
        fallback.delete(key);
      }
    };
  }

  private normalizeBaseUrl(value: string | null | undefined): string {
    if (!value) {
      return '';
    }

    return value.trim().replace(/\/+$/, '');
  }
}
