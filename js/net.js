// Realtime transport over a public MQTT (WebSocket) broker.
//  - presence: retained message on  <ns>/u/<uid>  (cleared automatically by the
//    broker's Last-Will when a client disappears)
//  - lobby chat:  <ns>/lobby/chat
//  - rooms:       <ns>/r/<roomId>
//  - inbox:       <ns>/i/<uid>   (invites)
import mqtt from 'mqtt';
import { Emitter, randId } from './util.js';

function topicMatch(filter, topic) {
  if (filter === topic) return true;
  const f = filter.split('/'), t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export class Net extends Emitter {
  constructor({ ns, uid, brokers }) {
    super();
    this.ns = ns;
    this.uid = uid;
    this.brokers = brokers;
    this.client = null;
    this.broker = null;
    this.status = 'idle';
    this.subs = new Map();
    this.presence = null;
    this._hb = null;
    window.addEventListener('pagehide', () => this._goodbye());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.client && !this.client.connected && !this.closed) {
        try { this.client.reconnect(); } catch { /* ignore */ }
      }
    });
  }

  t(path) { return `${this.ns}/${path}`; }
  get online() { return !!this.client?.connected; }

  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  async connect(prefer = 'auto') {
    if (this._connecting) return this._connecting;
    const list = [...this.brokers];
    const i = list.findIndex((b) => b.id === prefer);
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
    this._setStatus('connecting');
    this._connecting = (async () => {
      let lastErr;
      for (const b of list) {
        try {
          await this._open(b);
          return b;
        } catch (e) {
          lastErr = e;
          console.warn('[net] broker failed:', b.id, e?.message || e);
        }
      }
      this._setStatus('failed');
      throw lastErr || new Error('connect failed');
    })();
    try {
      return await this._connecting;
    } finally {
      this._connecting = null;
    }
  }

  _open(b) {
    return new Promise((resolve, reject) => {
      const client = mqtt.connect(b.url, {
        clientId: 'cl_' + this.uid.replace(/-/g, '').slice(0, 10) + '_' + randId(6),
        clean: true,
        keepalive: 30,
        reconnectPeriod: 0, // switched on after the first successful connect
        connectTimeout: 7000,
        protocolVersion: 4,
        resubscribe: true,
        username: b.username,
        password: b.password,
        will: { topic: this.t('u/' + this.uid), payload: '', retain: true, qos: 1 },
      });
      let done = false;
      const fail = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { client.end(true); } catch { /* ignore */ }
        reject(err || new Error('failed'));
      };
      const timer = setTimeout(() => fail(new Error('timeout')), 8500);
      client.once('connect', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.client = client;
        this.broker = b;
        client.options.reconnectPeriod = 2000;
        this._wire(client);
        this._setStatus('online');
        // (re)subscribe anything registered before the connection existed
        for (const filter of this.subs.keys()) client.subscribe(filter, { qos: 1 });
        resolve(b);
      });
      client.on('error', (e) => { if (!done) fail(e); });
      client.on('close', () => { if (!done) fail(new Error('closed')); });
    });
  }

  _wire(client) {
    client.on('message', (topic, payload, packet) => this._dispatch(topic, payload, packet));
    client.on('connect', () => {
      this._setStatus('online');
      this._publishPresence();
      this.emit('reconnected');
    });
    client.on('reconnect', () => this._setStatus('reconnecting'));
    client.on('offline', () => this._setStatus('reconnecting'));
    client.on('close', () => { if (this.status === 'online') this._setStatus('reconnecting'); });
    client.on('error', (e) => console.warn('[net]', e?.message || e));
  }

  _dispatch(topic, payload, packet) {
    let data = null;
    if (payload && payload.length) {
      try {
        data = JSON.parse(payload.toString());
      } catch {
        return;
      }
    }
    for (const [filter, set] of this.subs) {
      if (!topicMatch(filter, topic)) continue;
      for (const h of [...set]) {
        try { h(data, topic, packet); } catch (e) { console.error('[net handler]', e); }
      }
    }
  }

  subscribe(filter, handler) {
    let set = this.subs.get(filter);
    const isNew = !set;
    if (!set) { set = new Set(); this.subs.set(filter, set); }
    set.add(handler);
    if (!isNew || !this.client) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.client.subscribe(filter, { qos: 1 }, (err) => resolve(!err));
      setTimeout(() => resolve(false), 6000);
    });
  }

  unsubscribe(filter, handler) {
    const set = this.subs.get(filter);
    if (!set) return;
    if (handler) set.delete(handler); else set.clear();
    if (!set.size) {
      this.subs.delete(filter);
      try { this.client?.unsubscribe(filter); } catch { /* ignore */ }
    }
  }

  publish(topic, obj, { retain = false, qos = 0 } = {}) {
    if (!this.client) return false;
    const payload = obj == null ? '' : JSON.stringify(obj);
    this.client.publish(topic, payload, { retain, qos });
    return true;
  }

  // ---------------------------------------------------------------- presence
  setPresence(p) {
    this.presence = p;
    this._publishPresence();
    if (!this._hb) this._hb = setInterval(() => this._publishPresence(), 25000);
  }

  _publishPresence() {
    if (!this.presence || !this.client?.connected) return;
    this.presence.ts = Date.now();
    this.client.publish(this.t('u/' + this.uid), JSON.stringify(this.presence), { retain: true, qos: 1 });
  }

  clearPresence() {
    this.presence = null;
    clearInterval(this._hb);
    this._hb = null;
    if (this.client?.connected) this.client.publish(this.t('u/' + this.uid), '', { retain: true, qos: 1 });
  }

  _goodbye() {
    // best effort: clear our presence right away (the Last-Will covers the rest)
    try {
      if (this.client?.connected && this.presence) this.client.publish(this.t('u/' + this.uid), '', { retain: true, qos: 0 });
    } catch { /* ignore */ }
  }

  close() {
    this.closed = true;
    this.clearPresence();
    clearInterval(this._hb);
    try { this.client?.end(false); } catch { /* ignore */ }
    this._setStatus('closed');
  }
}
