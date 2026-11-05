import { Queue, Worker } from "bullmq";
import net from "node:net";

import {
  createLogger,
  createSqlClient,
  getRuntimeEnv,
  recordServiceHeartbeat
} from "../../../packages/shared/src";
import {
  ensureFuturePartitions,
  refreshAlerts,
  refreshDailyMetrics,
  refreshMonthlyMetrics,
  refreshWeeklyMetrics,
  checkUnprovenActions
} from "./jobs";
import { processRankBackfill, processRankVoiceXp } from "./rank-jobs";

async function canReachRedis(redisUrl: string, timeoutMs = 2500) {
  try {
    const parsed = new URL(redisUrl);
    const port = Number(parsed.port || "6379");
    const host = parsed.hostname || "127.0.0.1";

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };

      socket.setTimeout(timeoutMs);
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("timeout", () => onError(new Error("Redis reachability timed out.")));
      socket.once("error", onError);
    });

    return true;
  } catch {
    return false;
  }
}

async function main() {
  const env = getRuntimeEnv();
  const bootedAt = new Date();
  const logger = createLogger(env.logLevel);
  const sql = createSqlClient(env.databaseUrl);

  const startHeartbeat = (mode: string) => {
    const writeHeartbeat = async () => {
      await recordServiceHeartbeat(sql, "worker", bootedAt, {
        mode,
        timezone: env.timezone
      });
    };

    writeHeartbeat().catch((error) => {
      logger.error({ error }, "Worker heartbeat update failed.");
    });

    setInterval(async () => {
      try {
        await writeHeartbeat();
      } catch (error) {
        logger.error({ error }, "Worker heartbeat update failed.");
      }
    }, 30_000).unref();
  };

  if (!env.redisUrl) {
    logger.warn("Redis devre disi. Worker local interval modunda calisacak.");
    startHeartbeat("local");
    await runLocalScheduler(sql, env.discordGuildId, env.timezone, logger);
    return;
  }

  const redisReachable = await canReachRedis(env.redisUrl);
  if (!redisReachable) {
    logger.warn("Redis erisilemedi. Worker local interval moduna geciyor.");
    startHeartbeat("local");
    await runLocalScheduler(sql, env.discordGuildId, env.timezone, logger);
    return;
  }

  try {
    const queueName = "supervisor-jobs";
    const redisUrl = new URL(env.redisUrl);
    const connection = {
      host: redisUrl.hostname,
      port: Number(redisUrl.port || "6379"),
      username: redisUrl.username || undefined,
      password: redisUrl.password || undefined,
      db: redisUrl.pathname ? Number(redisUrl.pathname.replace("/", "") || "0") : 0
    };
    const queue = new Queue(queueName, { connection });

    await queue.add(
      "rank-backfill",
      {},
      { repeat: { every: 1 * 60 * 1000 }, jobId: "rank-backfill" }
    );
    await queue.add(
      "rank-voice-xp",
      {},
      { repeat: { every: 1 * 60 * 1000 }, jobId: "rank-voice-xp" }
    );
    await queue.add(
      "daily-rollup",
      {},
      { repeat: { every: 5 * 60 * 1000 }, jobId: "daily-rollup" }
    );
    await queue.add(
      "weekly-rollup",
      {},
      { repeat: { every: 30 * 60 * 1000 }, jobId: "weekly-rollup" }
    );
    await queue.add(
      "monthly-rollup",
      {},
      { repeat: { every: 60 * 60 * 1000 }, jobId: "monthly-rollup" }
    );
    await queue.add(
      "alert-scan",
      {},
      { repeat: { every: 5 * 60 * 1000 }, jobId: "alert-scan" }
    );
    await queue.add(
      "partition-maintenance",
      {},
      { repeat: { every: 12 * 60 * 60 * 1000 }, jobId: "partition-maintenance" }
    );
    await queue.add(
      "check-unproven",
      {},
      { repeat: { every: 1 * 60 * 1000 }, jobId: "check-unproven" }
    );

    const worker = new Worker(
      queueName,
      async (job) => {
        logger.info({ jobName: job.name }, "Running scheduled worker job.");
        await runJob(job.name, sql, env.discordGuildId, env.timezone, logger);
      },
      { connection, concurrency: 1 }
    );

    worker.on("completed", (job) => {
      logger.info({ jobName: job.name }, "Worker job completed.");
    });

    worker.on("failed", (job, error) => {
      logger.error({ jobName: job?.name, error }, "Worker job failed.");
    });

    startHeartbeat("bullmq");
    logger.info("Worker started in BullMQ mode.");
  } catch (error) {
    logger.warn({ error }, "Redis baglantisi kurulamadi. Worker local interval moduna dusuyor.");
    startHeartbeat("local");
    await runLocalScheduler(sql, env.discordGuildId, env.timezone, logger);
  }
}

async function runJob(
  jobName: string,
  sql: ReturnType<typeof createSqlClient>,
  guildId: string,
  timezone: string,
  logger: ReturnType<typeof createLogger>
) {
  switch (jobName) {
    case "rank-backfill":
      await processRankBackfill(sql, logger, guildId, timezone);
      break;
    case "rank-voice-xp":
      await processRankVoiceXp(sql, logger, guildId);
      break;
    case "daily-rollup":
      await refreshDailyMetrics(sql, timezone);
      break;
    case "weekly-rollup":
      await refreshWeeklyMetrics(sql, timezone);
      break;
    case "monthly-rollup":
      await refreshMonthlyMetrics(sql, timezone);
      break;
    case "alert-scan":
      await refreshAlerts(sql, timezone);
      break;
    case "partition-maintenance":
      await ensureFuturePartitions(sql);
      break;
    case "check-unproven":
      await checkUnprovenActions(sql);
      break;
    default:
      logger.warn({ jobName }, "Unknown worker job received.");
  }
}

async function runLocalScheduler(
  sql: ReturnType<typeof createSqlClient>,
  guildId: string,
  timezone: string,
  logger: ReturnType<typeof createLogger>
) {
  const jobs: Array<{ name: string; everyMs: number }> = [
    { name: "rank-backfill", everyMs: 1 * 60 * 1000 },
    { name: "rank-voice-xp", everyMs: 1 * 60 * 1000 },
    { name: "daily-rollup", everyMs: 5 * 60 * 1000 },
    { name: "weekly-rollup", everyMs: 30 * 60 * 1000 },
    { name: "monthly-rollup", everyMs: 60 * 60 * 1000 },
    { name: "alert-scan", everyMs: 5 * 60 * 1000 },
    { name: "partition-maintenance", everyMs: 12 * 60 * 60 * 1000 },
    { name: "check-unproven", everyMs: 1 * 60 * 1000 }
  ];

  for (const job of jobs) {
    await runJob(job.name, sql, guildId, timezone, logger);
    setInterval(async () => {
      try {
        await runJob(job.name, sql, guildId, timezone, logger);
      } catch (error) {
        logger.error({ error, jobName: job.name }, "Local worker interval failed.");
      }
    }, job.everyMs);
  }

  logger.info("Worker started in local interval mode.");
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
