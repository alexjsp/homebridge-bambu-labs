import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { BambuClient } from './bambuClient.js';
import { PrinterAccessory } from './printerAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

interface PrinterConfig {
  name: string;
  ip: string;
  serial: string;
  accessCode: string;
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
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache: %s', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private discoverDevices(): void {
    const printers = (this.config.printers as PrinterConfig[]) || [];

    if (printers.length === 0) {
      this.log.warn('No printers configured');
      return;
    }

    for (const printer of printers) {
      if (!printer.ip || !printer.serial || !printer.accessCode) {
        this.log.warn('Skipping printer with missing configuration: %s', printer.name || 'unnamed');
        continue;
      }

      const uuid = this.api.hap.uuid.generate(printer.serial);
      this.discoveredUUIDs.push(uuid);

      const bambuClient = new BambuClient(
        { ip: printer.ip, serial: printer.serial, accessCode: printer.accessCode },
        this.log,
      );

      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info('Restoring accessory from cache: %s', printer.name);
        existingAccessory.context.bambuClient = bambuClient;
        existingAccessory.context.serial = printer.serial;
        new PrinterAccessory(this, existingAccessory);
      } else {
        this.log.info('Adding new accessory: %s', printer.name);
        const accessory = new this.api.platformAccessory(printer.name, uuid);
        accessory.context.bambuClient = bambuClient;
        accessory.context.serial = printer.serial;
        new PrinterAccessory(this, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // Remove stale cached accessories
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredUUIDs.includes(uuid)) {
        this.log.info('Removing stale accessory: %s', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
