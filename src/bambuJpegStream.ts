import tls from 'tls';
import { EventEmitter } from 'events';
import type { Logging } from 'homebridge';

/**
 * Client for the proprietary Bambu JPEG camera stream (port 6000).
 * Used by A1, A1 Mini, P1P, P1S printers that don't support RTSP.
 */
export class BambuJpegStream extends EventEmitter {
  private socket: tls.TLSSocket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private _latestFrame: Buffer | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ip: string,
    private readonly accessCode: string,
    private readonly log: Logging,
  ) {
    super();
  }

  get latestFrame(): Buffer | null {
    return this._latestFrame;
  }

  connect(): void {
    this.socket = tls.connect({
      host: this.ip,
      port: 6000,
      rejectUnauthorized: false,
    }, () => {
      this.log.info('Connected to JPEG stream at %s:6000', this.ip);
      this.sendAuth();
    });

    this.socket.on('data', (data) => this.onData(data));

    this.socket.on('error', (err) => {
      this.log.error('JPEG stream error: %s', err.message);
    });

    this.socket.on('close', () => {
      this.log.debug('JPEG stream closed, reconnecting in 5s');
      this.scheduleReconnect();
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.buffer = Buffer.alloc(0);
      this.connect();
    }, 5000);
  }

  private sendAuth(): void {
    const auth = Buffer.alloc(80);
    auth.writeUInt32LE(0x40, 0);
    auth.writeUInt32LE(0x3000, 4);
    // bytes 8-15: zeros (already zero from alloc)
    auth.write('bblp', 16, 'utf-8');
    auth.write(this.accessCode, 48, 'utf-8');
    this.socket!.write(auth);
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.parseFrames();
  }

  private parseFrames(): void {
    while (this.buffer.length >= 16) {
      const payloadSize = this.buffer.readUInt32LE(0);

      // Sanity check: skip invalid frame headers
      if (payloadSize === 0 || payloadSize > 10_000_000) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      const totalSize = 16 + payloadSize;
      if (this.buffer.length < totalSize) {
        break; // Wait for more data
      }

      const jpeg = this.buffer.subarray(16, totalSize);
      this.buffer = this.buffer.subarray(totalSize);

      // Validate JPEG start marker (SOI: FF D8)
      if (jpeg.length >= 2 && jpeg[0] === 0xFF && jpeg[1] === 0xD8) {
        this._latestFrame = Buffer.from(jpeg);
        this.emit('frame', this._latestFrame);
      }
    }
  }
}
