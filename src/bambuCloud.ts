import type { Logging } from 'homebridge';

const API_BASE = 'https://api.bambulab.com';
const API_BASE_CN = 'https://api.bambulab.cn';
const TFA_BASE = 'https://bambulab.com';
const TFA_BASE_CN = 'https://bambulab.cn';

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'bambu_network_agent/01.09.05.01',
  'X-BBL-Client-Name': 'OrcaSlicer',
  'X-BBL-Client-Type': 'slicer',
  'X-BBL-Client-Version': '01.09.05.51',
  'X-BBL-Language': 'en-US',
  'X-BBL-OS-Type': 'linux',
  'X-BBL-OS-Version': '6.2.0',
  'X-BBL-Agent-Version': '01.09.05.01',
  'X-BBL-Agent-OS-Type': 'linux',
  'Content-Type': 'application/json',
  'Accept': 'application/json',
};

export interface CloudDevice {
  serial: string;
  name: string;
  online: boolean;
  model: string;
  accessCode: string;
}

export interface CloudCredentials {
  username: string;
  token: string;
}

export type CloudRegion = 'global' | 'china';

export class BambuCloud {
  private readonly apiBase: string;
  private readonly tfaBase: string;

  constructor(
    private readonly region: CloudRegion,
    private readonly log: Logging,
  ) {
    this.apiBase = region === 'china' ? API_BASE_CN : API_BASE;
    this.tfaBase = region === 'china' ? TFA_BASE_CN : TFA_BASE;
  }

  async login(email: string, password: string): Promise<CloudCredentials> {
    const res = await fetch(`${this.apiBase}/v1/user-service/user/login`, {
      method: 'POST',
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({ account: email, password }),
    });

    if (!res.ok) {
      throw new Error(`Login failed with status ${res.status}`);
    }

    const data = await res.json() as Record<string, unknown>;

    if (typeof data.accessToken === 'string') {
      return this.credentialsFromToken(data.accessToken);
    }

    if (data.loginType === 'verifyCode') {
      throw new Error(
        'Bambu Labs account requires email verification code login. '
        + 'Please log in via Bambu Studio or OrcaSlicer first to trust this network, '
        + 'or provide an auth token directly in the plugin config.',
      );
    }

    if (data.loginType === 'tfa') {
      throw new Error(
        'Bambu Labs account requires two-factor authentication. '
        + 'Please provide an auth token directly in the plugin config instead. '
        + 'You can obtain the token from Bambu Studio or OrcaSlicer.',
      );
    }

    throw new Error(`Unexpected login response: ${JSON.stringify(data)}`);
  }

  async loginWithToken(token: string): Promise<CloudCredentials> {
    return this.credentialsFromToken(token);
  }

  async getDevices(token: string): Promise<CloudDevice[]> {
    const res = await fetch(`${this.apiBase}/v1/iot-service/api/user/bind`, {
      method: 'GET',
      headers: {
        ...DEFAULT_HEADERS,
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch devices: status ${res.status}`);
    }

    const data = await res.json() as Record<string, unknown>;
    const devices = data.devices as Array<Record<string, unknown>> | undefined;

    if (!Array.isArray(devices)) {
      return [];
    }

    return devices.map((d) => ({
      serial: String(d.dev_id ?? ''),
      name: String(d.name ?? 'Unknown Printer'),
      online: Boolean(d.online),
      model: String(d.dev_product_name ?? d.dev_model_name ?? 'Unknown'),
      accessCode: String(d.dev_access_code ?? ''),
    }));
  }

  private credentialsFromToken(token: string): CloudCredentials {
    const username = this.extractUsername(token);
    return { username, token };
  }

  private extractUsername(token: string): string {
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(
          Buffer.from(parts[1]!, 'base64').toString('utf-8'),
        ) as Record<string, unknown>;
        if (typeof payload.username === 'string') {
          return payload.username;
        }
      }
    } catch {
      // Not a valid JWT, fall through
    }
    throw new Error(
      'Could not extract username from auth token. '
      + 'Ensure the token is a valid Bambu Labs JWT.',
    );
  }

  static mqttHost(region: CloudRegion): string {
    return region === 'china' ? 'cn.mqtt.bambulab.com' : 'us.mqtt.bambulab.com';
  }
}
