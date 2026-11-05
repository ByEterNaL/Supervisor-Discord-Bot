import type { Client } from "discord.js";
import type IORedis from "ioredis";
import type { Logger } from "pino";
import type { Sql } from "postgres";

import type { RuntimeEnv } from "../../../packages/shared/src";
import type { ConfigStore } from "./services/config-store";
import type { MemberService } from "./services/member-service";
import type { ModerationCommandService } from "./services/moderation-command-service";
import type { ModersonService } from "./services/moderson-service";
import type { MessageSyncService } from "./services/message-sync-service";
import type { ModerationService } from "./services/moderation-service";
import type { PresenceService } from "./services/presence-service";
import type { GuardService } from "./services/guard-service";
import type { RankService } from "./services/rank-service";
import type { RoleChangeService } from "./services/role-change-service";
import type { StaffMessageAuditService } from "./services/staff-message-audit-service";
import type { TicketService } from "./services/ticket-service";

export interface BotContext {
  client: Client;
  env: RuntimeEnv;
  sql: Sql;
  redis: IORedis | null;
  logger: Logger;
  configStore: ConfigStore;
  memberService: MemberService;
  modersonService: ModersonService;
  moderationCommandService: ModerationCommandService;
  messageSyncService: MessageSyncService;
  presenceService: PresenceService;
  ticketService: TicketService;
  moderationService: ModerationService;
  guardService: GuardService;
  rankService: RankService;
  roleChangeService: RoleChangeService;
  staffMessageAuditService: StaffMessageAuditService;
}
