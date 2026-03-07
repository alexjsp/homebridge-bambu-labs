# Homebridge Bambu Labs

A [Homebridge](https://homebridge.io) plugin that exposes Bambu Labs 3D printers to Apple HomeKit via MQTT.

## Features

- **Print status sensor** — an occupancy sensor that activates when the printer is printing (including paused/preparing states)
- **Chamber light control** — a lightbulb accessory to toggle the chamber light on and off
- **Nozzle temperature sensor** — reports the current hotend temperature
- **Bed temperature sensor** — reports the current build plate temperature
- **Chamber temperature sensor** — reports the current enclosure temperature
- **LAN and Cloud modes** — connect directly over your local network, or via Bambu Labs cloud for remote access
- **Auto-discovery** — in cloud mode, printers are automatically discovered from your account

All three temperature sensors can be individually disabled per-printer in the config.

## Prerequisites

- A Bambu Labs printer (X1, X1C, P1P, P1S, A1, etc.)
- [Homebridge](https://homebridge.io) v1.8+ or v2.0+
- Node.js 20.18+ or 22.10+

**For LAN mode:**
- Printer on your local network
- The printer's **LAN Access Code** (found on the printer touchscreen under **Settings > Network > LAN Mode**)
- The printer's **serial number** and **IP address**

**For Cloud mode:**
- A Bambu Labs account with your printer(s) registered
- Your account email/password, or an auth token

## Installation

### Via Homebridge UI

Search for `homebridge-bambu-labs` in the Homebridge plugin search and click install.

### Via npm

```sh
npm install -g homebridge-bambu-labs
```

## Configuration

### LAN Mode (default)

Connects directly to printers on your local network using the LAN Access Code.

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
          "accessCode": "YOUR_ACCESS_CODE"
        }
      ]
    }
  ]
}
```

### Cloud Mode

Connects to printers via the Bambu Labs cloud MQTT broker. This allows remote access without requiring the printer to be on the same network.

**With email/password:**

```json
{
  "platforms": [
    {
      "platform": "BambuLabs",
      "name": "Bambu Labs",
      "cloudMode": true,
      "cloudEmail": "you@example.com",
      "cloudPassword": "your-password"
    }
  ]
}
```

When no `printers` array is provided in cloud mode, all printers linked to your account are auto-discovered.

**With auth token:**

If your account uses two-factor authentication (2FA) or email verification codes, you can provide an auth token directly instead of email/password. You can obtain the token from Bambu Studio or OrcaSlicer.

```json
{
  "platforms": [
    {
      "platform": "BambuLabs",
      "name": "Bambu Labs",
      "cloudMode": true,
      "cloudToken": "YOUR_AUTH_TOKEN"
    }
  ]
}
```

**With explicit printers:**

You can optionally list specific printers (by serial number) in cloud mode to control which printers are exposed and to set per-printer options:

```json
{
  "platforms": [
    {
      "platform": "BambuLabs",
      "name": "Bambu Labs",
      "cloudMode": true,
      "cloudEmail": "you@example.com",
      "cloudPassword": "your-password",
      "printers": [
        {
          "name": "Office Printer",
          "serial": "SERIAL_NUMBER_1",
          "enableChamberTemperature": false
        }
      ]
    }
  ]
}
```

### Platform options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `cloudMode` | No | `false` | Enable cloud mode |
| `cloudEmail` | Cloud | — | Bambu Labs account email |
| `cloudPassword` | Cloud | — | Bambu Labs account password |
| `cloudToken` | Cloud | — | Auth token (alternative to email/password) |
| `cloudRegion` | No | `global` | Cloud region: `global` or `china` |

### Printer options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `name` | Yes | — | Display name for the printer in HomeKit |
| `ip` | LAN | — | Printer's local IP address |
| `serial` | Yes | — | Printer serial number |
| `accessCode` | LAN | — | 8-character LAN Access Code |
| `enableNozzleTemperature` | No | `true` | Show nozzle temperature sensor |
| `enableBedTemperature` | No | `true` | Show bed temperature sensor |
| `enableChamberTemperature` | No | `true` | Show chamber temperature sensor |

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

The plugin connects to each configured printer over MQTT (port 8883, TLS). In **LAN mode**, it connects directly to the printer's IP using the LAN Access Code. In **cloud mode**, it authenticates with the Bambu Labs API and connects to the cloud MQTT broker (`us.mqtt.bambulab.com` or `cn.mqtt.bambulab.com`).

Both modes use the same MQTT topics and message formats — the plugin subscribes to status reports and pushes characteristic updates to HomeKit in real time. Light control commands are sent back to the printer over the same MQTT connection.
