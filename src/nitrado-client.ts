interface NitradoOptions {
  token: string;
  serviceId: string;
  fetch?: typeof fetch;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class NitradoClient {
  private readonly token: string;
  private readonly serviceId: string;
  private readonly fetch: typeof fetch;

  constructor(options: NitradoOptions) {
    this.token = options.token.trim();
    this.serviceId = options.serviceId.trim();
    this.fetch = options.fetch ?? fetch;
  }

  get configured() {
    return this.token.length > 0 && /^[1-9]\d*$/.test(this.serviceId);
  }

  async getStatus(): Promise<string> {
    const response = await this.request("");
    const data = response.data;
    const server = isObject(data) ? data.gameserver : undefined;
    if (!isObject(server) || typeof server.status !== "string") {
      throw new Error("Nitrado вернул некорректное состояние сервера");
    }
    return server.status;
  }

  async restart(message: string): Promise<void> {
    await this.request("/restart", message);
  }

  private async request(path: string, message?: string): Promise<Record<string, unknown>> {
    if (!this.configured) throw new Error("Укажите NITRADO_API_TOKEN и NITRADO_SERVICE_ID в .env");

    let response: Response;
    let payload: unknown;
    try {
      response = await this.fetch(`https://api.nitrado.net/services/${this.serviceId}/gameservers${path}`, {
        method: message === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: message === undefined ? undefined : JSON.stringify({ message }),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch {
      // Never include fetch errors or upstream bodies: they can contain credentials.
      throw new Error("Нет ответа от API Nitrado; проверьте состояние сервера в панели хостинга");
    }
    if (!response.ok) {
      if (response.status === 401) throw new Error("Токен Nitrado недействителен или истёк");
      if (response.status === 403) throw new Error("У токена Nitrado нет прав на управление сервером");
      if (response.status === 404) throw new Error("Сервер Nitrado не найден; проверьте NITRADO_SERVICE_ID");
      if (response.status === 429) throw new Error("Nitrado ограничил частоту запросов; попробуйте позже");
      throw new Error(`API Nitrado вернул ошибку HTTP ${response.status}; проверьте панель хостинга`);
    }
    try {
      payload = await response.json();
    } catch {
      throw new Error("API Nitrado вернул некорректный ответ; проверьте панель хостинга");
    }
    if (!isObject(payload) || payload.status !== "success") {
      throw new Error("API Nitrado не подтвердил выполнение запроса; проверьте панель хостинга");
    }
    return payload;
  }
}
