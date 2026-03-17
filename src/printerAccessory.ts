import type { CameraController, CameraControllerOptions, CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { BambuLabsPlatform } from './platform.js';
import type { PrinterConfig } from './platform.js';
import type { BambuClient, PrinterStatus } from './bambuClient.js';
import { BambuCameraStreamingDelegate, type BambuCameraConfig } from './bambuCameraStream.js';
import { BambuJpegStream } from './bambuJpegStream.js';

const PRINTING_STATES = new Set(['RUNNING', 'PAUSE', 'PREPARE']);

export class PrinterAccessory {
  private readonly lightService: Service;
  private readonly printingSensorService: Service;
  private readonly bambuClient: BambuClient;
  private readonly printerConfig: PrinterConfig;
  private nozzleTempService?: Service;
  private bedTempService?: Service;
  private chamberTempService?: Service;
  private jpegStream?: BambuJpegStream;

  constructor(
    private readonly platform: BambuLabsPlatform,
    private readonly accessory: PlatformAccessory,
    bambuClient: BambuClient,
  ) {
    this.bambuClient = bambuClient;
    this.printerConfig = accessory.context.printerConfig as PrinterConfig;

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

    // Temperature sensors (enabled by default, can be disabled via config)
    this.setupTemperatureSensors();

    // Camera (opt-in, requires ffmpeg and LAN access)
    this.setupCamera();

    // Listen for status updates from the MQTT client
    this.bambuClient.on('status', (status: PrinterStatus) => {
      this.updateCharacteristics(status);
    });

    // Connect to the printer
    this.bambuClient.connect();
  }

  private setupTemperatureSensors(): void {
    const enableNozzle = this.printerConfig.enableNozzleTemperature !== false;
    const enableBed = this.printerConfig.enableBedTemperature !== false;
    const enableChamber = this.printerConfig.enableChamberTemperature !== false;

    this.nozzleTempService = this.manageTemperatureService(
      enableNozzle,
      'Nozzle Temperature',
      'nozzle-temp',
    );

    this.bedTempService = this.manageTemperatureService(
      enableBed,
      'Bed Temperature',
      'bed-temp',
    );

    this.chamberTempService = this.manageTemperatureService(
      enableChamber,
      'Chamber Temperature',
      'chamber-temp',
    );
  }

  private setupCamera(): void {
    if (!this.printerConfig.enableCamera) {
      return;
    }

    if (!this.printerConfig.ip) {
      this.platform.log.warn(
        'Camera enabled for %s but no IP address configured. Camera requires LAN access.',
        this.printerConfig.name,
      );
      return;
    }

    if (!this.printerConfig.accessCode) {
      this.platform.log.warn(
        'Camera enabled for %s but no access code configured. Camera requires the LAN access code.',
        this.printerConfig.name,
      );
      return;
    }

    const cameraType = this.printerConfig.cameraType ?? 'rtsp';
    this.platform.log.info('Setting up %s camera for %s', cameraType.toUpperCase(), this.printerConfig.name);

    const cameraConfig: BambuCameraConfig = {
      ip: this.printerConfig.ip,
      accessCode: this.printerConfig.accessCode,
      cameraType,
      ffmpegPath: this.printerConfig.ffmpegPath,
    };

    const delegate = new BambuCameraStreamingDelegate(cameraConfig, this.platform.log);

    if (cameraType === 'jpeg') {
      // For JPEG stream cameras (A1/P1 series), start the JPEG stream client
      this.jpegStream = new BambuJpegStream(
        this.printerConfig.ip,
        this.printerConfig.accessCode,
        this.platform.log,
      );
      delegate.setJpegStream(this.jpegStream);
      this.jpegStream.connect();
    } else {
      // For RTSP cameras, the printer must be told to start the live stream via MQTT
      this.bambuClient.on('connected', () => {
        this.platform.log.info('Starting RTSP liveview for %s', this.printerConfig.name);
        this.bambuClient.startLiveview();
      });
    }

    const controllerOptions: CameraControllerOptions = {
      cameraStreamCount: 2,
      delegate,
      streamingOptions: BambuCameraStreamingDelegate.createStreamingOptions(),
    };

    const controller: CameraController = new this.platform.api.hap.CameraController(controllerOptions);
    this.accessory.configureController(controller);
  }

  private manageTemperatureService(
    enabled: boolean,
    name: string,
    subtype: string,
  ): Service | undefined {
    const existing = this.accessory.getServiceById(
      this.platform.Service.TemperatureSensor,
      subtype,
    );

    if (!enabled) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return undefined;
    }

    const service = existing
      || this.accessory.addService(this.platform.Service.TemperatureSensor, name, subtype);

    service.setCharacteristic(this.platform.Characteristic.Name, name);

    service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .setProps({ minValue: -40, maxValue: 500 })
      .onGet(() => this.getTemperature(subtype));

    return service;
  }

  private getTemperature(subtype: string): CharacteristicValue {
    const status = this.bambuClient.currentStatus;
    switch (subtype) {
      case 'nozzle-temp':
        return status.nozzleTemperature;
      case 'bed-temp':
        return status.bedTemperature;
      case 'chamber-temp':
        return status.chamberTemperature;
      default:
        return 0;
    }
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

    this.nozzleTempService?.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      status.nozzleTemperature,
    );

    this.bedTempService?.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      status.bedTemperature,
    );

    this.chamberTempService?.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      status.chamberTemperature,
    );

    this.platform.log.debug(
      'Updated status: gcode_state=%s, light=%s, nozzle=%.1f°C, bed=%.1f°C, chamber=%.1f°C',
      status.gcodeState,
      status.lightOn ? 'on' : 'off',
      status.nozzleTemperature,
      status.bedTemperature,
      status.chamberTemperature,
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
