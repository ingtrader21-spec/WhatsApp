export class W3Metrics {
  constructor() {
    this.counters = new Map();
    this.gauges = new Map();
  }

  inc(name, labels = {}, value = 1) {
    const key = this.#key(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + value);
  }

  set(name, labels = {}, value = 0) {
    this.gauges.set(this.#key(name, labels), Number(value));
  }

  #key(name, labels) {
    const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify([name, sorted]);
  }

  #decode(key) {
    const [name, entries] = JSON.parse(key);
    return { name, labels: Object.fromEntries(entries) };
  }

  #formatLabels(labels) {
    const entries = Object.entries(labels);
    if (!entries.length) return "";
    return `{${entries.map(([k, v]) => `${k}="${String(v).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(",")}}`;
  }

  render() {
    const lines = [
      "# Codestra WhatsApp W3 metrics",
      "# TYPE codestra_whatsapp_w3_info gauge",
      'codestra_whatsapp_w3_info{version="1"} 1'
    ];
    for (const [key, value] of [...this.counters.entries()].sort()) {
      const { name, labels } = this.#decode(key);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name}${this.#formatLabels(labels)} ${value}`);
    }
    for (const [key, value] of [...this.gauges.entries()].sort()) {
      const { name, labels } = this.#decode(key);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name}${this.#formatLabels(labels)} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
