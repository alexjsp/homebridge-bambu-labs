import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { BambuLabsPlatform } from './platform.js';
import type { BambuClient, PrinterStatus } from './bambuClient.js';

const PRINTING_STATES = new Set(['RUNNING', 'PAUSE', 'PREPARE']);

export class PrinterAccessory {
  private readonly lightService: Service;
  private readonly printingSensorService: Service;
  private readonly bambuClient: BambuClient;

  constructor(
    private readonly platform: BambuLabsPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.bambuClient = accessory.context.bambuClient as BambuClient;

    // Accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Bambu Lab')
      .setCharacteristic(this.platform.Characteristic.Model, 'Bambu Printer')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.serial as string);

    // Occupancy sensor for printing status (occupied = printing)
    this.printingSensorService =
      this.accessory.getService(this.platform.Service.OccupancySensor)
      || this.accessory.addService(this.platform.Service.OccupancySensor, 'Printing');

    this.printingSensorService.setCharacteristic(
      this.platform.Characteristic.Name,
      'Printing',
    );

    this.printingSensorService.getCharacteristic(this.platform.Characteristic.OccupancyDetected)
      .onGet(this.getIsPrinting.bind(this));

    // Lightbulb for chamber light
    this.lightService =
      this.accessory.getService(this.platform.Service.Lightbulb)
      || this.accessory.addService(this.platform.Service.Lightbulb, 'Chamber Light');

    this.lightService.setCharacteristic(
      this.platform.Characteristic.Name,
      'Chamber Light',
    );

    this.lightService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getLightOn.bind(this))
      .onSet(this.setLightOn.bind(this));

    // Listen for status updates from the MQTT client
    this.bambuClient.on('status', (status: PrinterStatus) => {
      this.updateCharacteristics(status);
    });

    // Connect to the printer
    this.bambuClient.connect();
  }

  private updateCharacteristics(status: PrinterStatus): void {
    const isPrinting = PRINTING_STATES.has(status.gcodeState);

    this.printingSensorService.updateCharacteristic(
      this.platform.Characteristic.OccupancyDetected,
      isPrinting
        ? this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );

    this.lightService.updateCharacteristic(
      this.platform.Characteristic.On,
      status.lightOn,
    );

    this.platform.log.debug(
      'Updated status: gcode_state=%s, light=%s',
      status.gcodeState,
      status.lightOn ? 'on' : 'off',
    );
  }

  private getIsPrinting(): CharacteristicValue {
    const status = this.bambuClient.currentStatus;
    return PRINTING_STATES.has(status.gcodeState)
      ? this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
      : this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  private getLightOn(): CharacteristicValue {
    return this.bambuClient.currentStatus.lightOn;
  }

  private async setLightOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    this.platform.log.info('Setting chamber light %s', on ? 'on' : 'off');
    this.bambuClient.setLight(on);
  }
}
