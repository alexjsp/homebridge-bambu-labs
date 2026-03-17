import { type ChildProcess, spawn } from 'child_process';
import { createSocket } from 'dgram';
import type {
  CameraStreamingDelegate,
  CameraStreamingOptions,
  Logging,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge';
import {
  H264Level,
  H264Profile,
  SRTPCryptoSuites,
  StreamRequestTypes,
} from 'homebridge';
import type { BambuJpegStream } from './bambuJpegStream.js';

interface SessionInfo {
  address: string;
  addressVersion: 'ipv4' | 'ipv6';
  videoPort: number;
  videoSrtpKey: Buffer;
  videoSrtpSalt: Buffer;
  videoSSRC: number;
  localVideoPort: number;
  localVideoSocket: ReturnType<typeof createSocket>;
}

export interface BambuCameraConfig {
  ip: string;
  accessCode: string;
  /** 'rtsp' for X1/X1C/X1E/P2S/H2 series, 'jpeg' for A1/P1 series */
  cameraType: 'rtsp' | 'jpeg';
  ffmpegPath?: string;
}

export class BambuCameraStreamingDelegate implements CameraStreamingDelegate {
  private readonly sessions: Map<string, SessionInfo> = new Map();
  private readonly activeProcesses: Map<string, ChildProcess> = new Map();
  private readonly ffmpegPath: string;
  private jpegStream?: BambuJpegStream;

  constructor(
    private readonly config: BambuCameraConfig,
    private readonly log: Logging,
  ) {
    this.ffmpegPath = config.ffmpegPath ?? 'ffmpeg';
  }

  setJpegStream(stream: BambuJpegStream): void {
    this.jpegStream = stream;
  }

  static createStreamingOptions(): CameraStreamingOptions {
    return {
      supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
      video: {
        codec: {
          profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
          levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
        },
        resolutions: [
          [1920, 1080, 30],
          [1280, 720, 30],
          [640, 480, 30],
          [640, 360, 30],
          [320, 240, 15],
        ],
      },
    };
  }

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    if (this.config.cameraType === 'jpeg' && this.jpegStream?.latestFrame) {
      // For JPEG stream cameras, return the latest frame (already JPEG)
      callback(undefined, this.jpegStream.latestFrame);
      return;
    }

    // For RTSP cameras (or JPEG stream with no frame yet), use ffmpeg
    const source = this.getSnapshotSource();
    const args = [
      ...source,
      '-frames:v', '1',
      '-vf', `scale=${request.width}:${request.height}`,
      '-f', 'mjpeg',
      '-hide_banner',
      '-loglevel', 'error',
      'pipe:1',
    ];

    this.log.debug('Snapshot ffmpeg args: %s', args.join(' '));

    const ffmpeg = spawn(this.ffmpegPath, args);
    const chunks: Buffer[] = [];

    ffmpeg.stdout.on('data', (data: Buffer) => chunks.push(data));
    ffmpeg.stderr.on('data', (data: Buffer) => {
      this.log.debug('Snapshot ffmpeg stderr: %s', data.toString().trim());
    });

    ffmpeg.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        callback(undefined, Buffer.concat(chunks));
      } else {
        this.log.warn('Snapshot ffmpeg exited with code %d', code);
        callback(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      ffmpeg.kill('SIGKILL');
    }, 10_000);
  }

  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    const socketType = request.addressVersion === 'ipv6' ? 'udp6' : 'udp4';
    const videoSocket = createSocket(socketType);

    videoSocket.bind(0, () => {
      const localVideoPort = videoSocket.address().port;
      const videoSSRC = Math.floor(Math.random() * 0xFFFFFFFF);

      const sessionInfo: SessionInfo = {
        address: request.targetAddress,
        addressVersion: request.addressVersion,
        videoPort: request.video.port,
        videoSrtpKey: request.video.srtp_key,
        videoSrtpSalt: request.video.srtp_salt,
        videoSSRC,
        localVideoPort,
        localVideoSocket: videoSocket,
      };

      this.sessions.set(request.sessionID, sessionInfo);

      const response: PrepareStreamResponse = {
        video: {
          port: localVideoPort,
          ssrc: videoSSRC,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
      };

      callback(undefined, response);
    });
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    if (request.type === StreamRequestTypes.START) {
      this.startStream(request, callback);
    } else if (request.type === StreamRequestTypes.STOP) {
      this.stopStream(request.sessionID);
      callback();
    } else {
      // RECONFIGURE - just acknowledge
      callback();
    }
  }

  private startStream(
    request: StartStreamRequest,
    callback: StreamRequestCallback,
  ): void {
    const sessionId = request.sessionID;
    const session = this.sessions.get(sessionId);
    if (!session) {
      callback(new Error('Session not found'));
      return;
    }

    const video = request.video;
    const srtpParams = Buffer.concat([session.videoSrtpKey, session.videoSrtpSalt]).toString('base64');

    const profileMap: Record<number, string> = {
      [H264Profile.BASELINE]: 'baseline',
      [H264Profile.MAIN]: 'main',
      [H264Profile.HIGH]: 'high',
    };

    const levelMap: Record<number, string> = {
      [H264Level.LEVEL3_1]: '3.1',
      [H264Level.LEVEL3_2]: '3.2',
      [H264Level.LEVEL4_0]: '4.0',
    };

    const source = this.getStreamSource();
    const args = [
      ...source,
      '-an', // no audio
      '-codec:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-color_range', 'mpeg',
      '-profile:v', profileMap[video.profile] ?? 'main',
      '-level:v', levelMap[video.level] ?? '3.1',
      '-b:v', `${video.max_bit_rate}k`,
      '-r', String(video.fps),
      '-s', `${video.width}x${video.height}`,
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-payload_type', String(video.pt),
      '-ssrc', String(session.videoSSRC),
      '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', srtpParams,
      `srtp://${session.address}:${session.videoPort}?rtcpport=${session.videoPort}&pkt_size=${video.mtu}`,
    ];

    this.log.debug('Stream ffmpeg args: %s', args.join(' '));

    const ffmpeg = spawn(this.ffmpegPath, args);

    // For JPEG stream cameras, pipe frames to ffmpeg stdin
    if (this.config.cameraType === 'jpeg' && this.jpegStream) {
      const onFrame = (frame: Buffer) => {
        if (!ffmpeg.killed && ffmpeg.stdin.writable) {
          ffmpeg.stdin.write(frame);
        }
      };
      this.jpegStream.on('frame', onFrame);
      ffmpeg.on('close', () => {
        this.jpegStream?.off('frame', onFrame);
      });
    }

    ffmpeg.stderr.on('data', (data: Buffer) => {
      this.log.debug('Stream ffmpeg: %s', data.toString().trim());
    });

    ffmpeg.on('error', (err) => {
      this.log.error('Stream ffmpeg error: %s', err.message);
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0 && code !== null) {
        this.log.warn('Stream ffmpeg exited with code %d', code);
      }
      this.activeProcesses.delete(sessionId);
    });

    this.activeProcesses.set(sessionId, ffmpeg);
    callback();
  }

  private stopStream(sessionId: string): void {
    const ffmpeg = this.activeProcesses.get(sessionId);
    if (ffmpeg) {
      ffmpeg.kill('SIGKILL');
      this.activeProcesses.delete(sessionId);
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.localVideoSocket.close();
      this.sessions.delete(sessionId);
    }
  }

  private getRtspUrl(): string {
    return `rtsps://bblp:${this.config.accessCode}@${this.config.ip}:322/streaming/live/1`;
  }

  private getSnapshotSource(): string[] {
    if (this.config.cameraType === 'rtsp') {
      return [
        '-rtsp_transport', 'tcp',
        '-tls_verify', '0',
        '-analyzeduration', '1000000',
        '-probesize', '500000',
        '-stimeout', '5000000',
        '-i', this.getRtspUrl(),
      ];
    }
    // JPEG stream: use pipe input (we'll send a single frame)
    return ['-f', 'mjpeg', '-i', 'pipe:0'];
  }

  private getStreamSource(): string[] {
    if (this.config.cameraType === 'rtsp') {
      return [
        '-rtsp_transport', 'tcp',
        '-tls_verify', '0',
        '-analyzeduration', '1000000',
        '-probesize', '500000',
        '-stimeout', '5000000',
        '-i', this.getRtspUrl(),
      ];
    }
    // JPEG stream: read from pipe
    return [
      '-f', 'mjpeg',
      '-framerate', '15',
      '-i', 'pipe:0',
    ];
  }
}
