import type IORedis from "ioredis";
import type { Logger } from "pino";
import type { Sql } from "postgres";
import { EventEmitter } from "events";

import {
  CONFIG_CHANGED_CHANNEL,
  CONFIG_KEY,
  SupervisorConfig,
  defaultConfig,
  mergeConfig
} from "../../../../packages/shared/src";

export class ConfigStore extends EventEmitter {
  private currentConfig: SupervisorConfig = defaultConfig;

  constructor(
    private readonly sql: Sql,
    private readonly subscriber: IORedis | null,
    private readonly logger: Logger
  ) {
    super();
  }

  async init() {
    await this.refresh();
    if (this.subscriber) {
      await this.subscriber.subscribe(CONFIG_CHANGED_CHANNEL);
      this.subscriber.on("message", async (channel) => {
        if (channel !== CONFIG_CHANGED_CHANNEL) {
          return;
        }

        this.logger.info("Received config change notification.");
        await this.refresh();
      });
    }

    setInterval(async () => {
      try {
        await this.refresh();
      } catch (error) {
        this.logger.error({ error }, "Config polling failed.");
      }
    }, 15_000).unref();
  }

  get() {
    return this.currentConfig;
  }

  async refresh() {
    try {
      const [row] = await this.sql<{ value: unknown }[]>`
        SELECT value
        FROM config_entries
        WHERE key = ${CONFIG_KEY}
        LIMIT 1
      `;

      this.currentConfig = mergeConfig(row?.value ?? defaultConfig);
      this.emit("configChange", this.currentConfig);
      return this.currentConfig;
    } catch (error) {
      this.logger.error({ error }, "Failed to load config from DB. Falling back to previous known config.");
      return this.currentConfig;
    }
  }
}
