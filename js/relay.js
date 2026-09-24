// WebSocket connection to the DG-LAB V4 relay. The socket parts of DriverRelayClient / RiderRelayClient.

import { PING_INTERVAL_MS, STALE_AFTER_MS, pingFrame, describeClose } from './protocol.js';

export class RelaySocket {
  /**
   * @param {string} url full relay URL (with ?tid= for the Driver)
   * @param {{onOpen?:()=>void, onFrame:(frame:object)=>void, onClose:(info:{code:number, reason:string|null})=>void}} handlers
   */
  constructor(url, handlers) {
    this.handlers = handlers;
    this.lastMessageAt = Date.now();
    this.closedByUs = false;
    this.ended = false;

    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.lastMessageAt = Date.now();
      // App-level ping: keeps mobile networks from dropping the socket and feeds the stale watchdog
      this.pingTimer = setInterval(() => this.sendRaw(pingFrame()), PING_INTERVAL_MS);
      handlers.onOpen?.();
    };
    this.ws.onmessage = event => {
      this.lastMessageAt = Date.now();
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        console.warn('Relay sent non-JSON', event.data);
        return;
      }
      handlers.onFrame(frame);
    };
    this.ws.onclose = event => this.finish(event.code, describeClose(event.code));
    // onclose always follows onerror; only the text differs
    this.ws.onerror = () => { this.errored = true; };

    // A socket that goes quiet (no pong in 10s) is treated as dropped
    this.watchdog = setInterval(() => {
      if (this.isOpen && Date.now() - this.lastMessageAt > STALE_AFTER_MS) {
        this.ws.close();
        this.finish(-1, 'Connection lost');
      }
    }, 1000);
  }

  get isOpen() {
    return this.ws.readyState === WebSocket.OPEN;
  }

  sendRaw(text) {
    if (this.isOpen) this.ws.send(text);
  }

  close() {
    this.closedByUs = true;
    // close() lets frames already queued (such as an E-STOP) go out first
    if (this.ws.readyState <= WebSocket.OPEN) this.ws.close(1000);
    this.finish(1000, null);
  }

  finish(code, reason) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.pingTimer);
    clearInterval(this.watchdog);
    if (!reason && this.errored && !this.closedByUs) reason = 'Could not reach relay';
    this.handlers.onClose({ code, reason });
  }
}
