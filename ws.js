"use strict";
/*
 * Minimal WebSocket server (RFC 6455) with no dependencies.
 * Supports text messages from browsers, ping/pong, close, and a payload size limit.
 */
const crypto = require("crypto");
const { EventEmitter } = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class Socket extends EventEmitter {
  constructor(sock, maxPayload) {
    super();
    this.sock = sock; this.maxPayload = maxPayload; this.readyState = 1; this.buf = Buffer.alloc(0);
    sock.on("data", (d) => this._data(d));
    sock.on("close", () => this._closed());
    sock.on("error", () => this._closed());
    sock.setNoDelay(true);
  }
  _closed() { if (this.readyState !== 3) { this.readyState = 3; this.emit("close"); } }
  _frame(opcode, payload) {
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([head, payload]);
  }
  send(text) { if (this.readyState === 1) this.sock.write(this._frame(1, Buffer.from(String(text)))); }
  close(code = 1000, reason = "") {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    const r = Buffer.from(reason).subarray(0, 120);
    const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
    this.sock.write(this._frame(8, p));
    this.sock.end();
  }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const opcode = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) return this.close(1009, "Message too big");
        len = Number(big); off = 10;
      }
      if (len > this.maxPayload) return this.close(1009, "Message too big");
      if (!masked) return this.close(1002, "Unmasked frame");
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (opcode === 1) this.emit("message", data.toString("utf8"));
      else if (opcode === 8) { this.close(1000); return; }
      else if (opcode === 9) this.sock.write(this._frame(10, data));
      // binary (2), pong (10), continuation (0) are ignored: the app only uses small text messages
    }
  }
}

function attachWebSocket(server, path, onConnection, maxPayload = 4096) {
  server.on("upgrade", (req, sock) => {
    const url = new URL(req.url, "http://x");
    const key = req.headers["sec-websocket-key"];
    if (url.pathname !== path || !key || String(req.headers.upgrade).toLowerCase() !== "websocket") {
      sock.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return sock.destroy();
    }
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    onConnection(new Socket(sock, maxPayload), req);
  });
}

module.exports = { attachWebSocket };
