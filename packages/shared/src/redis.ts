import IORedis from "ioredis";

export function createRedisClient(redisUrl: string) {
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    lazyConnect: true
  });
}
