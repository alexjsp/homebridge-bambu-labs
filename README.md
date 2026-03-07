# Homebridge Bambu Labs

A [Homebridge](https://homebridge.io) plugin that exposes Bambu Labs 3D printers to Apple HomeKit via MQTT.

## Features

- **Print status sensor** — an occupancy sensor that activates when the printer is printing (including paused/preparing states)
- **Chamber light control** — a lightbulb accessory to toggle the chamber light on and off
- **Nozzle temperature sensor** — reports the current hotend temperature
- **Bed temperature sensor** — reports the current build plate temperature
- **Chamber temperature sensor** — reports the current enclosure temperature

All three temperature sensors can be individually disabled per-printer in the config.

## Prerequisites

- A Bambu Labs printer on your local network (X1, X1C, P1P, P1S, A1, etc.)
- The printer's **LAN Access Code** (found on the printer touchscreen under **Settings > Network > LAN Mode**)
- The printer's **serial number** and **IP address**
- [Homebridge](https://homebridge.io) v1.8+ or v2.0+
- Node.js 20.18+ or 22.10+

## Installation

### Via Homebridge UI

Search for `homebridge-bambu-labs` in the Homebridge plugin search and click install.

### Via npm

```sh
npm install -g homebridge-bambu-labs
```

## Configuration

Add a `BambuLabs` platform to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "BambuLabs",
      "name": "Bambu Labs",
      "printers": [
        {
          "name": "My Printer",
          "ip": "192.168.1.100",
          "serial": "YOUR_SERIAL_NUMBER",
          "accessCode": "YOUR_ACCESS_CODE",
          "enableNozzleTemperature": true,
          "enableBedTemperature": true,
          "enableChamberTemperature": true
        }
      ]
    }
  ]
}
```

### Printer options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `name` | Yes | — | Display name for the printer in HomeKit |
| `ip` | Yes | — | Printer's local IP address |
| `serial` | Yes | — | Printer serial number |
| `accessCode` | Yes | — | 8-character LAN Access Code |
| `enableNozzleTemperature` | No | `true` | Show nozzle temperature sensor |
| `enableBedTemperature` | No | `true` | Show bed temperature sensor |
| `enableChamberTemperature` | No | `true` | Show chamber temperature sensor |

You can configure multiple printers by adding more entries to the `printers` array.

## Development

```sh
# Clone the repository
git clone https://github.com/alexjsp/homebridge-bambu-labs.git
cd homebridge-bambu-labs

# Install dependencies
npm install

# Build
npm run build

# Watch for changes during development
npm run watch
```

To test locally with Homebridge, link the plugin:

```sh
npm link
# Then in your Homebridge installation directory:
npm link homebridge-bambu-labs
```

## How it works

The plugin connects to each configured printer over MQTT (port 8883, TLS) using the local LAN Access Code. It subscribes to status reports and pushes characteristic updates to HomeKit in real time. Light control commands are sent back to the printer over the same MQTT connection.
