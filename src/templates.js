import { canonicalJson } from './canonical.js';
import { CHANNELS, boundedIdentifier } from './contracts.js';
import { ValidationError } from './errors.js';

const channelByteLimits = Object.freeze({ email: 65_536, push: 4_096, sms: 1_600 });
const placeholderPattern = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

function renderValue(value, variables) {
  if (typeof value === 'string') {
    return value.replace(placeholderPattern, (_, key) => {
      if (!Object.hasOwn(variables, key)) throw new ValidationError(`missing template variable: ${key}`);
      return variables[key];
    });
  }
  if (Array.isArray(value)) return value.map((item) => renderValue(item, variables));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderValue(item, variables)]));
  }
  throw new ValidationError('template payloads may contain only strings, arrays, and plain objects');
}

export class TemplateRegistry {
  constructor(definitions = []) {
    this.templates = new Map();
    for (const definition of definitions) this.register(definition);
  }

  register(definition) {
    if (!definition || typeof definition !== 'object') throw new ValidationError('template definition is required');
    const id = boundedIdentifier(definition.id, 'template id', { max: 64 });
    if (!Number.isInteger(definition.version) || definition.version < 1) {
      throw new ValidationError('template version must be a positive integer');
    }
    if (!Array.isArray(definition.variables) || new Set(definition.variables).size !== definition.variables.length) {
      throw new ValidationError('template variables must be a unique array');
    }
    const channels = definition.channels;
    if (!channels || typeof channels !== 'object') throw new ValidationError('template channels are required');
    for (const channel of Object.keys(channels)) {
      if (!CHANNELS.includes(channel)) throw new ValidationError(`unsupported template channel: ${channel}`);
    }
    const key = `${id}:${definition.version}`;
    if (this.templates.has(key)) throw new ValidationError('template version is already registered');
    this.templates.set(key, {
      id,
      version: definition.version,
      variables: [...definition.variables].sort(),
      channels: structuredClone(channels),
    });
    return this;
  }

  render(id, version, channel, variables) {
    const template = this.templates.get(`${id}:${version}`);
    if (!template) throw new ValidationError('template version was not found');
    if (!Object.hasOwn(template.channels, channel)) throw new ValidationError('template does not support the requested channel');
    const names = Object.keys(variables).sort();
    if (names.length !== template.variables.length || names.some((name, index) => name !== template.variables[index])) {
      throw new ValidationError('template variables must exactly match the registered schema');
    }
    const payload = renderValue(template.channels[channel], variables);
    const bytes = Buffer.byteLength(canonicalJson(payload));
    if (bytes > channelByteLimits[channel]) throw new ValidationError(`${channel} rendered payload exceeds its local limit`);
    return payload;
  }
}

export function createDefaultTemplateRegistry() {
  return new TemplateRegistry([{
    id: 'account-alert',
    version: 1,
    variables: ['body', 'title'],
    channels: {
      push: { title: '{{title}}', body: '{{body}}' },
      email: { subject: '{{title}}', text: '{{body}}' },
      sms: { text: '{{title}}: {{body}}' },
    },
  }]);
}
