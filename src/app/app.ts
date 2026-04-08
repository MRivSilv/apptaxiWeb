import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, Subscription } from 'rxjs';
import * as L from 'leaflet';
import {
  DriverSession,
  RealtimeLocationService,
  SessionLocation
} from './services/realtime-location.service';

interface AuthResponse {
  access_token: string;
  token_type: string;
  user_id: string;
  role: string;
  email: string;
  full_name: string;
  empresa?: string;
  company?: string;
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
  private readonly realtime = inject(RealtimeLocationService);
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
  readonly adminName = signal(this.storage.getItem('admin_name') || 'Admin Operaciones');
  readonly adminCompany = signal(this.storage.getItem('admin_company') || 'Empresa no disponible');
  readonly searchTerm = signal('');
  readonly wsConnected = signal(false);
  readonly transportMode = signal<'live' | 'fallback'>('fallback');
  readonly selectedSessionId = signal<string | null>(null);
  readonly hoveredSessionId = signal<string | null>(null);
  readonly hoveredPopupPosition = signal<{ left: number; top: number } | null>(null);
  readonly showAlert = signal(true);
  readonly lastRefresh = signal<Date | null>(null);
  readonly onlineLocations = signal<SessionLocation[]>([]);
  readonly activeSessions = signal<DriverSession[]>([]);

  private map?: L.Map;
  private markersLayer = L.layerGroup();
  private hasAutoCentered = false;
  private boundRealtimeStore = false;
  private readonly subscriptions = new Subscription();

  ngAfterViewInit(): void {
    this.bindRealtimeStore();

    if (this.token()) {
      this.initializeMap();
      this.scheduleMapResizeRefresh();
      void this.startRealtimeFlow();
    }
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.realtime.stop();
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
      this.storage.setItem('admin_name', response.full_name || response.email);
      this.storage.setItem('admin_company', response.empresa || response.company || 'Empresa no disponible');
      this.apiBaseUrl.set(baseUrl);
      this.adminName.set(response.full_name || response.email);
      this.adminCompany.set(response.empresa || response.company || 'Empresa no disponible');

      this.bootMapAfterLogin();
    } catch {
      this.authError.set('No se pudo iniciar sesión. Revisa credenciales o URL del backend.');
    } finally {
      this.loading.set(false);
    }
  }

  logout(): void {
    this.realtime.stop();
    this.token.set('');
    this.onlineLocations.set([]);
    this.activeSessions.set([]);
    this.lastRefresh.set(null);
    this.mapError.set('');
    this.transportMode.set('fallback');
    this.wsConnected.set(false);
    this.storage.removeItem('admin_token');
    this.storage.removeItem('admin_name');
    this.storage.removeItem('admin_company');
    this.adminName.set('Admin Operaciones');
    this.adminCompany.set('Empresa no disponible');
    this.hoveredSessionId.set(null);
    this.hoveredPopupPosition.set(null);
    this.map?.remove();
    this.map = undefined;
    this.markersLayer = L.layerGroup();
    this.hasAutoCentered = false;
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
    await this.startRealtimeFlow();
  }

  async refreshMapData(): Promise<void> {
    if (!this.token()) {
      return;
    }

    this.mapLoading.set(true);
    try {
      await this.realtime.forceHttpSync(true);
      this.mapError.set('');
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

  filteredLocations(): SessionLocation[] {
    const term = this.searchTerm().trim().toLowerCase();
    const rows = this.onlineLocations();
    if (!term) {
      return rows;
    }

    return rows.filter((location) => {
      const haystack = [location.session_id, location.nombre_completo, location.patente, location.empresa]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return haystack.includes(term);
    });
  }

  hoveredLocation(): SessionLocation | undefined {
    const hoveredSession = this.hoveredSessionId();
    if (!hoveredSession) {
      return undefined;
    }

    return this.onlineLocations().find((row) => row.session_id === hoveredSession);
  }

  inTransitCount(): number {
    return this.onlineLocations().length;
  }

  idleCount(): number {
    return Math.max(this.activeSessions().length - this.onlineLocations().length, 0);
  }

  telemetryProgressPercent(): number {
    const total = this.activeSessions().length || this.onlineLocations().length;
    if (!total) {
      return 10;
    }

    const progress = Math.round((this.onlineLocations().length / total) * 100);
    return Math.max(10, Math.min(progress, 100));
  }

  selectLocation(sessionId: string): void {
    this.selectedSessionId.set(sessionId);
  }

  zoomIn(): void {
    this.map?.zoomIn();
  }

  zoomOut(): void {
    this.map?.zoomOut();
  }

  recenterMap(): void {
    if (!this.map) {
      return;
    }

    const points = this.onlineLocations().map((location) => [location.latitude, location.longitude] as L.LatLngExpression);
    if (points.length === 1) {
      this.map.setView(points[0], 15);
      return;
    }

    if (points.length > 1) {
      this.map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
      return;
    }

    this.map.setView([-33.4489, -70.6693], 11);
  }

  dismissAlert(): void {
    this.showAlert.set(false);
  }

  private bindRealtimeStore(): void {
    if (this.boundRealtimeStore) {
      return;
    }

    this.boundRealtimeStore = true;

    this.subscriptions.add(
      this.realtime.locations$.subscribe((locations) => {
        this.onlineLocations.set(locations);
        this.lastRefresh.set(new Date());
        this.syncSelectedSession(locations);
        this.syncHoveredSession(locations);
        this.drawMarkers(locations);
      })
    );

    this.subscriptions.add(
      this.realtime.activeSessions$.subscribe((sessions) => {
        this.activeSessions.set(sessions);
      })
    );

    this.subscriptions.add(
      this.realtime.connected$.subscribe((connected) => {
        this.wsConnected.set(connected);
      })
    );

    this.subscriptions.add(
      this.realtime.transportMode$.subscribe((mode) => {
        this.transportMode.set(mode);
      })
    );
  }

  private async startRealtimeFlow(): Promise<void> {
    const baseUrl = this.normalizeBaseUrl(this.apiBaseUrl());
    const token = this.token();
    if (!baseUrl || !token) {
      return;
    }

    this.mapLoading.set(true);
    this.mapError.set('');

    try {
      await this.realtime.start(baseUrl, token);
    } catch {
      this.mapError.set('No se pudo iniciar el monitoreo en tiempo real.');
    } finally {
      this.mapLoading.set(false);
    }
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

    this.map.on('move zoom', () => {
      this.repositionHoveredPopup();
    });

    this.markersLayer.addTo(this.map);
  }

  private drawMarkers(locations: SessionLocation[]): void {
    if (!this.map) {
      return;
    }

    this.markersLayer.clearLayers();

    const points: L.LatLngExpression[] = [];
    for (const location of locations) {
      const isSelected = location.session_id === this.selectedSessionId();
      const marker = L.circleMarker([location.latitude, location.longitude], {
        radius: isSelected ? 10 : 8,
        color: isSelected ? '#003f9f' : '#0b4f8a',
        weight: isSelected ? 3 : 2,
        fillColor: isSelected ? '#0056d2' : '#1d9bf0',
        fillOpacity: isSelected ? 1 : 0.9
      });

      marker.on('mouseover', () => {
        this.hoveredSessionId.set(location.session_id);
        this.repositionHoveredPopup(location);
      });

      marker.on('mouseout', () => {
        this.hoveredSessionId.set(null);
        this.hoveredPopupPosition.set(null);
      });

      marker.addTo(this.markersLayer);
      points.push([location.latitude, location.longitude]);
    }

    if (points.length === 1) {
      if (!this.hasAutoCentered) {
        this.map.setView(points[0], 15);
        this.hasAutoCentered = true;
      }
    } else if (points.length > 1) {
      if (!this.hasAutoCentered) {
        this.map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
        this.hasAutoCentered = true;
      }
    }
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

  private bootMapAfterLogin(): void {
    let attempts = 0;
    const maxAttempts = 20;

    const tryBoot = () => {
      attempts += 1;

      if (!this.mapContainer?.nativeElement) {
        if (attempts < maxAttempts) {
          setTimeout(tryBoot, 50);
        }
        return;
      }

      this.initializeMap();
      this.scheduleMapResizeRefresh();
      void this.startRealtimeFlow();
    };

    setTimeout(tryBoot, 0);
  }

  private scheduleMapResizeRefresh(): void {
    const refresh = () => {
      this.map?.invalidateSize();
    };

    setTimeout(refresh, 0);
    setTimeout(refresh, 120);
  }

  private syncSelectedSession(locations: SessionLocation[]): void {
    if (!locations.length) {
      this.selectedSessionId.set(null);
      return;
    }

    const selected = this.selectedSessionId();
    if (selected && locations.some((location) => location.session_id === selected)) {
      return;
    }

    this.selectedSessionId.set(locations[0].session_id);
  }

  private syncHoveredSession(locations: SessionLocation[]): void {
    const hovered = this.hoveredSessionId();
    if (!hovered) {
      return;
    }

    if (locations.some((location) => location.session_id === hovered)) {
      this.repositionHoveredPopup();
      return;
    }

    this.hoveredSessionId.set(null);
    this.hoveredPopupPosition.set(null);
  }

  private repositionHoveredPopup(target?: SessionLocation): void {
    if (!this.map) {
      return;
    }

    const location = target || this.hoveredLocation();
    if (!location) {
      this.hoveredPopupPosition.set(null);
      return;
    }

    const point = this.map.latLngToContainerPoint([location.latitude, location.longitude]);
    const size = this.map.getSize();
    const popupWidth = 285;
    const popupHeight = 200;
    const offsetX = 18;
    const offsetY = 18;

    const left = Math.max(12, Math.min(point.x + offsetX, size.x - popupWidth - 12));
    const top = Math.max(12, Math.min(point.y - popupHeight - offsetY, size.y - popupHeight - 12));

    this.hoveredPopupPosition.set({ left, top });
  }
}
