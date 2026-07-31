// Single auto-reconnecting WebSocket connection shared within a page.
// Receives config / aircraft / status; sends config patches.

import type {
  Aircraft,
  ClientMessage,
  Config,
  ServerMessage,
  SourceStatus,
} from "@shared/index.js";

export interface StreamState {
  connected: boolean;
  config: Config | null;
  now: number;
  aircraft: Aircraft[];
  status: SourceStatus | null;
}

type Listener = (state: StreamState) => void;

export class Connection {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  state: StreamState = {
    connected: false,
    config: null,
    now: 0,
    aircraft: [],
    status: null,
  };

  constructor(private role: "display" | "control") {}

  connect(): void {
    this.closed = false;
    this.open();
  }

  private url(): string {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws`;
  }

  private open(): void {
    try {
      this.ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.send({ type: "hello", role: this.role });
      this.update({ connected: true });
    };
    this.ws.onclose = () => {
      this.update({ connected: false });
      this.scheduleReconnect();
    };
    this.ws.onerror = () => this.ws?.close();
    this.ws.onmessage = (ev) => this.onMessage(ev.data as string);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.open();
    }, 1500);
  }

  private onMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "config":
        this.update({ config: msg.config });
        break;
      case "aircraft":
        this.update({ now: msg.now, aircraft: msg.aircraft });
        break;
      case "status":
        this.update({ status: msg.status });
        break;
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  patchConfig(patch: Partial<Config>): void {
    this.send({ type: "patchConfig", patch });
  }
  resetConfig(): void {
    this.send({ type: "resetConfig" });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private update(partial: Partial<StreamState>): void {
    this.state = { ...this.state, ...partial };
    for (const fn of this.listeners) fn(this.state);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
