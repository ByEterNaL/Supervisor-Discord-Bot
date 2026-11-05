import { endOfMonth, startOfDay, startOfMonth, startOfWeek } from "date-fns";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";

export const DEFAULT_TIMEZONE = "Europe/Istanbul";

export function nowIso() {
  return new Date().toISOString();
}

export function currentDateKey(timezone: string) {
  return formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
}

export function normalizePeriodStart(period: "day" | "week" | "month", timezone: string, date = new Date()) {
  const zoned = toZonedTime(date, timezone);
  if (period === "day") {
    return startOfDay(zoned);
  }
  if (period === "week") {
    return startOfWeek(zoned, { weekStartsOn: 1 });
  }
  return startOfMonth(zoned);
}

export function currentMonthRange(timezone: string, date = new Date()) {
  const zoned = toZonedTime(date, timezone);
  return {
    start: startOfMonth(zoned),
    end: endOfMonth(zoned)
  };
}

