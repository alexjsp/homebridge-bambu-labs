import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { BambuClient, type BambuClientConfig } from './bambuClient.js';
import { BambuCloud, type CloudRegion } from './bambuCloud.js';
import { PrinterAccessory } from './printerAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export interface PrinterConfig {
  name: string;
  ip?: string;
  serial: string;
  accessCode?: string;
  enableNozzleTemperature?: boolean;
  enableBedTemperature?: boolean;
  enableChamberTemperature?: boolean;
}

export class BambuLabsPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly accessories: Map<string, PlatformAccessory> = new Map();
  private readonly discoveredUUIDs: string[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch((err) => {
        this.log.error('Device discovery failed: %s', (err as Error).message);
      });
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache: %s', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private async discoverDevices(): Promise<void> {
    const useCloud = this.config.cloudMode === true;
    const printers = (this.config.printers as PrinterConfig[]) || [];

    if (useCloud) {
      await this.discoverCloudDevices(printers);
    } else {
      this.discoverLanDevices(printers);
    }

    // Remove stale cached accessories
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredUUIDs.includes(uuid)) {
        this.log.info('Removing stale accessory: %s', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  private discoverLanDevices(printers: PrinterConfig[]): void {
    if (printers.length === 0) {
      this.log.warn('No printers configured');
      return;
    }

    for (const printer of printers) {
      if (!printer.ip || !printer.serial || !printer.accessCode) {
        this.log.warn('Skipping printer with missing LAN configuration: %s', printer.name || 'unnamed');
        continue;
      }

      const clientConfig: BambuClientConfig = {
        serial: printer.serial,
        host: printer.ip,
        username: 'bblp',
        password: printer.accessCode,
        useCloudTls: false,
      };

      this.registerPrinter(printer, clientConfig);
    }
  }

  private async discoverCloudDevices(printers: PrinterConfig[]): Promise<void> {
    const region = (this.config.cloudRegion as CloudRegion) || 'global';
    const email = this.config.cloudEmail as string | undefined;
    const password = this.config.cloudPassword as string | undefined;
    const token = this.config.cloudToken as string | undefined;

    const cloud = new BambuCloud(region, this.log);
    let credentials;

    if (token) {
      this.log.info('Authenticating with Bambu Labs cloud using token');
      credentials = await cloud.loginWithToken(token);
    } else if (email && password) {
      this.log.info('Authenticating with Bambu Labs cloud as %s', email);
      credentials = await cloud.login(email, password);
    } else {
      this.log.error('Cloud mode enabled but no credentials provided. Set cloudToken or cloudEmail/cloudPassword.');
      return;
    }

    this.log.info('Cloud auth successful, username: %s', credentials.username);

    const mqttHost = BambuCloud.mqttHost(region);

    if (printers.length > 0) {
      // Use explicitly configured printers
      for (const printer of printers) {
        if (!printer.serial) {
          this.log.warn('Skipping printer with missing serial: %s', printer.name || 'unnamed');
          continue;
        }

        const clientConfig: BambuClientConfig = {
          serial: printer.serial,
          host: mqttHost,
          username: credentials.username,
          password: credentials.token,
          useCloudTls: true,
        };

        this.registerPrinter(printer, clientConfig);
      }
    } else {
      // Auto-discover printers from the cloud account
      this.log.info('No printers configured, auto-discovering from cloud account...');
      const devices = await cloud.getDevices(credentials.token);

      if (devices.length === 0) {
        this.log.warn('No printers found in Bambu Labs account');
        return;
      }

      for (const device of devices) {
        this.log.info('Discovered printer: %s (%s) - %s', device.name, device.model, device.serial);

        const printer: PrinterConfig = {
          name: device.name,
          serial: device.serial,
        };

        const clientConfig: BambuClientConfig = {
          serial: device.serial,
          host: mqttHost,
          username: credentials.username,
          password: credentials.token,
          useCloudTls: true,
        };

        this.registerPrinter(printer, clientConfig);
      }
    }
  }

  private registerPrinter(printer: PrinterConfig, clientConfig: BambuClientConfig): void {
    const uuid = this.api.hap.uuid.generate(printer.serial);
    this.discoveredUUIDs.push(uuid);

    const bambuClient = new BambuClient(clientConfig, this.log);
    const existingAccessory = this.accessories.get(uuid);

    if (existingAccessory) {
      this.log.info('Restoring accessory from cache: %s', printer.name);
      existingAccessory.context.bambuClient = bambuClient;
      existingAccessory.context.serial = printer.serial;
      existingAccessory.context.printerConfig = printer;
      new PrinterAccessory(this, existingAccessory);
    } else {
      this.log.info('Adding new accessory: %s', printer.name);
      const accessory = new this.api.platformAccessory(printer.name, uuid);
      accessory.context.bambuClient = bambuClient;
      accessory.context.serial = printer.serial;
      accessory.context.printerConfig = printer;
      new PrinterAccessory(this, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }
}
