import type { Guild, VoiceState } from "discord.js";
import type { Logger } from "pino";
import type { Sql } from "postgres";

import {
  PresenceSessionType,
  SupervisorConfig,
  isCameraActive,
  isStreamActive,
  isVoiceActive
} from "../../../../packages/shared/src";
import type { MemberService } from "./member-service";

interface LiveSessionRow {
  guild_id: string;
  user_id: string;
  session_type: PresenceSessionType;
  channel_id: string;
  started_at: Date;
  last_confirmed_at: Date;
}

interface ServiceHeartbeatRow {
  last_seen_at: Date;
}

type CloseMode = "exact" | "confirmed";

export class PresenceService {
  private readonly bootedAt = new Date();

  constructor(
    private readonly sql: Sql,
    private readonly logger: Logger,
    private readonly memberService: MemberService,
    private readonly getConfig: () => SupervisorConfig
  ) {}

  async syncGuild(guild: Guild) {
    await this.reconcileGuild(guild, { recoverRestartSessions: true });
  }

  async reconcileGuild(guild: Guild, options: { recoverRestartSessions?: boolean } = {}) {
    const observedAt = new Date();
    let staleRows: LiveSessionRow[] = [];

    if (options.recoverRestartSessions) {
      const staleEndedAt = await this.getRestartCutoff();
      staleRows = await this.sql<LiveSessionRow[]>`
        SELECT guild_id, user_id, session_type, channel_id, started_at, last_confirmed_at
        FROM live_presence_sessions
        WHERE guild_id = ${guild.id}
          AND started_at < ${this.bootedAt}
      `;

      for (const row of staleRows) {
        await this.closeSession(row, this.resolveConfirmedEndedAt(row, staleEndedAt), "confirmed");
      }
    }

    const openRows = await this.sql<LiveSessionRow[]>`
      SELECT guild_id, user_id, session_type, channel_id, started_at, last_confirmed_at
      FROM live_presence_sessions
      WHERE guild_id = ${guild.id}
    `;

    const activeMap = new Map<string, { channelId: string }>();

    for (const [, voiceState] of guild.voiceStates.cache) {
      const member = voiceState.member;
      if (member && !member.user.bot) {
        await this.memberService.syncMember(member);
      }

      const snapshot = this.toStateSnapshot(voiceState);
      for (const sessionType of this.getActiveTypes(snapshot)) {
        if (voiceState.channelId) {
          activeMap.set(this.liveKey(voiceState.id, sessionType), {
            channelId: voiceState.channelId
          });
        }
      }
    }

    for (const row of openRows) {
      const current = activeMap.get(this.liveKey(row.user_id, row.session_type));
      if (!current || current.channelId !== row.channel_id) {
        await this.closeSession(
          row,
          this.resolveConfirmedEndedAt(row, observedAt),
          "confirmed"
        );
      }
    }

    for (const [key, current] of activeMap) {
      const [userId, sessionType] = key.split(":");
      await this.openSession(
        guild.id,
        userId,
        sessionType as PresenceSessionType,
        current.channelId,
        observedAt
      );
    }

    this.logger.info(
      {
        guildId: guild.id,
        staleSessionCount: staleRows.length,
        activeSessionCount: activeMap.size
      },
      "Voice state reconciliation completed."
    );
  }

  async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) {
      return;
    }

    await this.memberService.syncMember(member);

    const previousSnapshot = this.toStateSnapshot(oldState);
    const nextSnapshot = this.toStateSnapshot(newState);
    const previousTypes = new Set(this.getActiveTypes(previousSnapshot));
    const nextTypes = new Set(this.getActiveTypes(nextSnapshot));
    const now = new Date();

    const sessionTypes: PresenceSessionType[] = ["voice", "camera", "stream"];
    for (const sessionType of sessionTypes) {
      const wasActive = previousTypes.has(sessionType);
      const isActive = nextTypes.has(sessionType);
      const previousChannel = oldState.channelId;
      const nextChannel = newState.channelId;

      if (wasActive && (!isActive || previousChannel !== nextChannel)) {
        const existing = await this.findLiveSession(member.guild.id, member.id, sessionType);
        if (existing) {
          await this.closeSession(existing, now, "exact");
        }
      }

      if (isActive && nextChannel) {
        await this.openSession(member.guild.id, member.id, sessionType, nextChannel, now);
      }
    }
  }

  private toStateSnapshot(state: VoiceState) {
    return {
      channelId: state.channelId,
      parentId: state.channel?.parentId ?? null,
      selfMute: state.selfMute ?? false,
      serverMute: state.serverMute ?? false,
      selfDeaf: state.selfDeaf ?? false,
      serverDeaf: state.serverDeaf ?? false,
      streaming: state.streaming ?? false,
      selfVideo: state.selfVideo ?? false
    };
  }

  private getActiveTypes(snapshot: ReturnType<PresenceService["toStateSnapshot"]>) {
    const config = this.getConfig().voice;
    const activeTypes: PresenceSessionType[] = [];

    if (isVoiceActive(snapshot, config)) {
      activeTypes.push("voice");
    }

    if (isCameraActive(snapshot, config)) {
      activeTypes.push("camera");
    }

    if (isStreamActive(snapshot, config)) {
      activeTypes.push("stream");
    }

    return activeTypes;
  }

  private liveKey(userId: string, sessionType: PresenceSessionType) {
    return `${userId}:${sessionType}`;
  }

  private async getRestartCutoff() {
    const [row] = await this.sql<ServiceHeartbeatRow[]>`
      SELECT last_seen_at
      FROM service_heartbeats
      WHERE service_name = 'bot'
      LIMIT 1
    `;

    if (!row?.last_seen_at) {
      return this.bootedAt;
    }

    const lastSeenAt = new Date(row.last_seen_at);
    if (Number.isNaN(lastSeenAt.getTime())) {
      return this.bootedAt;
    }

    return lastSeenAt.getTime() > this.bootedAt.getTime() ? this.bootedAt : lastSeenAt;
  }

  private clampEndedAt(startedAt: Date, endedAt: Date) {
    const started = new Date(startedAt);
    if (Number.isNaN(started.getTime())) {
      return endedAt;
    }

    return endedAt.getTime() < started.getTime() ? started : endedAt;
  }

  private resolveConfirmedEndedAt(row: LiveSessionRow, fallbackEndedAt: Date) {
    const startedAt = new Date(row.started_at);
    const confirmedAt = new Date(row.last_confirmed_at);
    const safeConfirmedAt =
      Number.isNaN(confirmedAt.getTime()) || confirmedAt.getTime() < startedAt.getTime()
        ? startedAt
        : confirmedAt;

    return this.clampEndedAt(
      startedAt,
      new Date(Math.min(fallbackEndedAt.getTime(), safeConfirmedAt.getTime()))
    );
  }

  private async findLiveSession(
    guildId: string,
    userId: string,
    sessionType: PresenceSessionType
  ) {
    const [row] = await this.sql<LiveSessionRow[]>`
      SELECT guild_id, user_id, session_type, channel_id, started_at, last_confirmed_at
      FROM live_presence_sessions
      WHERE guild_id = ${guildId}
        AND user_id = ${userId}
        AND session_type = ${sessionType}
      LIMIT 1
    `;

    return row;
  }

  private async openSession(
    guildId: string,
    userId: string,
    sessionType: PresenceSessionType,
    channelId: string,
    observedAt = new Date()
  ) {
    await this.sql`
      INSERT INTO live_presence_sessions (
        guild_id,
        user_id,
        session_type,
        channel_id,
        started_at,
        last_confirmed_at
      )
      VALUES (${guildId}, ${userId}, ${sessionType}, ${channelId}, ${observedAt}, ${observedAt})
      ON CONFLICT (guild_id, user_id, session_type)
      DO UPDATE SET
        channel_id = EXCLUDED.channel_id,
        started_at = CASE
          WHEN live_presence_sessions.channel_id = EXCLUDED.channel_id
            AND live_presence_sessions.started_at >= ${this.bootedAt}
            THEN live_presence_sessions.started_at
          ELSE EXCLUDED.started_at
        END,
        last_confirmed_at = EXCLUDED.last_confirmed_at
    `;
  }

  private async closeSession(row: LiveSessionRow, endedAt: Date, closeMode: CloseMode) {
    const [claimedRow] = await this.sql<LiveSessionRow[]>`
      DELETE FROM live_presence_sessions
      WHERE guild_id = ${row.guild_id}
        AND user_id = ${row.user_id}
        AND session_type = ${row.session_type}
      RETURNING guild_id, user_id, session_type, channel_id, started_at, last_confirmed_at
    `;

    if (!claimedRow) {
      return;
    }

    const effectiveEndedAt =
      closeMode === "exact"
        ? this.clampEndedAt(claimedRow.started_at, endedAt)
        : this.resolveConfirmedEndedAt(claimedRow, endedAt);
    const durationSeconds = Math.floor(
      (effectiveEndedAt.getTime() - new Date(claimedRow.started_at).getTime()) / 1000
    );
    const segmentTable = this.getSegmentTable(claimedRow.session_type);

    if (durationSeconds > 0) {
      await this.sql`SELECT ensure_month_partition(${segmentTable}, ${claimedRow.started_at}::date)`;
      await this.sql.unsafe(
        `
          INSERT INTO ${segmentTable}
            (guild_id, user_id, channel_id, started_at, ended_at, duration_seconds)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT DO NOTHING
        `,
        [
          claimedRow.guild_id,
          claimedRow.user_id,
          claimedRow.channel_id,
          claimedRow.started_at,
          effectiveEndedAt,
          durationSeconds
        ]
      );
    }
  }

  private getSegmentTable(sessionType: PresenceSessionType) {
    if (sessionType === "camera") {
      return "camera_segments";
    }

    if (sessionType === "stream") {
      return "stream_segments";
    }

    return "voice_active_segments";
  }
}
