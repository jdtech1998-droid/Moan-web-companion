// Remote Play sessions over the relay. The routing of RiderRelayClient and DriverRelayClient; what the
// commands do is up to app.js.

import { RelaySocket } from './relay.js';
import { messageFrame, parseCommand, urlWithTid } from './protocol.js';

/**
 * Rider: the relay's "controller". The relay's hello gives the pairing code, and exactly one Driver may bind.
 * hooks: onCode(code), onDriverAttached(), onDriverLeft(), onCommand(parsed), onError(text), onEnded(reason)
 */
export class RiderSession {
  constructor(relayUrl, hooks) {
    this.hooks = hooks;
    this.driverId = null;
    this.code = '';
    this.socket = new RelaySocket(relayUrl, {
      onFrame: frame => this.handleFrame(frame),
      onClose: ({ reason }) => hooks.onEnded(reason),
    });
  }

  get bound() {
    return this.driverId != null;
  }

  handleFrame(frame) {
    switch (frame.type) {
      case 'hello':
        this.code = frame.clientId ?? '';
        this.hooks.onCode(this.code);
        break;
      case 'client_attached':
        // One Driver at a time: any extra client stays unbound and is ignored
        if (this.bound || !frame.clientId) return;
        this.driverId = frame.clientId;
        this.hooks.onDriverAttached();
        break;
      case 'client_disconnected':
        if (frame.clientId === this.driverId) {
          this.driverId = null;
          this.hooks.onDriverLeft();
        }
        break;
      case 'message': {
        // Only the bound Driver may control this Rider
        if (!frame.clientId || frame.clientId !== this.driverId) return;
        const parsed = parseCommand(frame.data?.cmd);
        if (parsed) this.hooks.onCommand(parsed);
        break;
      }
      case 'error':
        this.hooks.onError(`Relay error: ${frame.code}`);
        break;
    }
  }

  send(cmd) {
    if (this.driverId) this.socket.sendRaw(messageFrame(this.driverId, cmd));
  }

  close() {
    this.socket.close();
  }
}

/**
 * Driver: joins the Rider's session with ?tid=<code>.
 * hooks: onBound(), onCommand(parsed), onError(text), onEnded(reason)
 */
export class DriverSession {
  constructor(relayUrl, riderCode, hooks) {
    this.hooks = hooks;
    this.bound = false;
    this.socket = new RelaySocket(urlWithTid(relayUrl, riderCode), {
      onFrame: frame => this.handleFrame(frame),
      onClose: ({ reason }) => {
        this.bound = false;
        hooks.onEnded(this.endReason ?? reason);
      },
    });
  }

  handleFrame(frame) {
    switch (frame.type) {
      case 'controller_attached':
        this.bound = true;
        this.hooks.onBound();
        break;
      case 'controller_disconnected':
        this.bound = false;
        this.endReason = 'Rider ended the session';
        this.socket.close();
        break;
      case 'error':
        this.bound = false;
        if (frame.code === 'controller_not_found') {
          this.endReason = 'Rider not found - check the code';
          this.socket.close();
        } else {
          this.hooks.onError(`Relay error: ${frame.code}`);
        }
        break;
      case 'message': {
        const parsed = parseCommand(frame.data?.cmd);
        if (parsed) this.hooks.onCommand(parsed);
        break;
      }
    }
  }

  /** The relay routes a Driver's messages to the controller it attached to, so no target is needed. */
  send(cmd) {
    this.socket.sendRaw(messageFrame(null, cmd));
  }

  close() {
    this.socket.close();
  }
}
