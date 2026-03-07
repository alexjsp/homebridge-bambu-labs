import { EventEmitter } from 'events';
import mqtt, { type MqttClient } from 'mqtt';
import type { Logging } from 'homebridge';

export interface PrinterStatus {
  gcodeState: string;
  lightOn: boolean;
  nozzleTemperature: number;
  bedTemperature: number;
  chamberTemperature: number;
}

export interface BambuClientConfig {
  ip: string;
  serial: string;
  accessCode: string;
}

export class BambuClient extends EventEmitter {
  private client: MqttClient | null = null;
  private status: PrinterStatus = {
    gcodeState: 'IDLE',
    lightOn: false,
    nozzleTemperature: 0,
    bedTemperature: 0,
    chamberTemperature: 0,
  };
  private sequenceId = 0;

  constructor(
    private readonly config: BambuClientConfig,
    private readonly log: Logging,
  ) {
    super();
  }

  get currentStatus(): PrinterStatus {
    return { ...this.status };
  }

  connect(): void {
    const url = `mqtts://${this.config.ip}:8883`;
    this.log.info('Connecting to printer at %s', this.config.ip);

    this.client = mqtt.connect(url, {
      username: 'bblp',
      password: this.config.accessCode,
      rejectUnauthorized: false,
      reconnectPeriod: 5000,
    });

    this.client.on('connect', () => {
      this.log.info('Connected to printer %s', this.config.serial);
      const reportTopic = `device/${this.config.serial}/report`;
      this.client!.subscribe(reportTopic, (err) => {
        if (err) {
          this.log.error('Failed to subscribe to %s: %s', reportTopic, err.message);
          return;
        }
        this.requestFullStatus();
      });
    });

    this.client.on('message', (_topic, payload) => {
      try {
        const data = JSON.parse(payload.toString());
        this.handleMessage(data);
      } catch {
        // Ignore non-JSON messages
      }
    });

    this.client.on('error', (err) => {
      this.log.error('MQTT error: %s', err.message);
    });

    this.client.on('close', () => {
      this.log.debug('MQTT connection closed, will reconnect');
    });
  }

  disconnect(): void {
    this.client?.end();
    this.client = null;
  }

  private requestFullStatus(): void {
    this.publish({
      pushing: {
        sequence_id: String(this.sequenceId++),
        command: 'pushall',
      },
    });
  }

  setLight(on: boolean): void {
    this.publish({
      system: {
        sequence_id: String(this.sequenceId++),
        command: 'ledctrl',
        led_node: 'chamber_light',
        led_mode: on ? 'on' : 'off',
        led_on_time: 500,
        led_off_time: 500,
        loop_times: 0,
        interval_time: 0,
      },
    });
  }

  private publish(payload: Record<string, unknown>): void {
    if (!this.client?.connected) {
      this.log.warn('Cannot publish, not connected');
      return;
    }
    const topic = `device/${this.config.serial}/request`;
    this.client.publish(topic, JSON.stringify(payload));
  }

  private handleMessage(data: Record<string, unknown>): void {
    const print = data.print as Record<string, unknown> | undefined;
    if (!print) {
      return;
    }

    let changed = false;

    if (typeof print.gcode_state === 'string') {
      const newState = print.gcode_state;
      if (newState !== this.status.gcodeState) {
        this.status.gcodeState = newState;
        changed = true;
      }
    }

    if (typeof print.nozzle_temper === 'number') {
      if (print.nozzle_temper !== this.status.nozzleTemperature) {
        this.status.nozzleTemperature = print.nozzle_temper;
        changed = true;
      }
    }

    if (typeof print.bed_temper === 'number') {
      if (print.bed_temper !== this.status.bedTemperature) {
        this.status.bedTemperature = print.bed_temper;
        changed = true;
      }
    }

    if (typeof print.chamber_temper === 'number') {
      if (print.chamber_temper !== this.status.chamberTemperature) {
        this.status.chamberTemperature = print.chamber_temper;
        changed = true;
      }
    }

    if (Array.isArray(print.lights_report)) {
      for (const light of print.lights_report) {
        if (light.node === 'chamber_light') {
          const newLightOn = light.mode === 'on';
          if (newLightOn !== this.status.lightOn) {
            this.status.lightOn = newLightOn;
            changed = true;
          }
        }
      }
    }

    if (changed) {
      this.emit('status', this.currentStatus);
    }
  }
}
