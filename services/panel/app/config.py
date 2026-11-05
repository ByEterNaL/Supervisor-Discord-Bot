from __future__ import annotations

import json
import os
from copy import deepcopy
from pathlib import Path
from urllib.parse import SplitResult, urlsplit, urlunsplit

from dotenv import load_dotenv

load_dotenv()

ROOT_DIR = Path(__file__).resolve().parents[3]
SETTINGS_FILE = ROOT_DIR / "settings.json"

DEFAULT_CONFIG = {
    "roles": {
        "staffRoleIds": [],
        "upperStaffRoleIds": [],
        "supervisorRoleIds": [],
        "banRoleIds": [],
        "kickRoleIds": [],
        "unbanRoleIds": [],
        "timeoutRoleIds": [],
        "warnRoleIds": [],
        "jailRoleIds": [],
        "messageModerationRoleIds": [],
        "channelModerationRoleIds": [],
        "historyRoleIds": [],
        "ticketRoleIds": [],
    },
    "voice": {
        "afkChannelId": None,
        "ignoredChannelIds": [],
        "ignoredCategoryIds": [],
    },
    "ticket": {
        "panelChannelIds": [],
        "activeCategoryMode": "auto",
        "categoryParentId": None,
        "archiveCategoryMode": "auto",
        "archiveCategoryId": None,
        "embedImageUrl": "",
        "embedTitle": "Destek Talebi",
        "embedDescription": "Destek almak icin asagidaki butona basarak ticket olusturabilirsiniz.",
        "welcomeTitle": "Hos geldin, {user}",
        "welcomeDescription": "Destek ekibimiz kisa sure icinde sizinle iletisime gececektir. Bu islemi kapatmak icin kapat dugmesine basin.",
        "joinWelcomeTitle": "Katilim Talebi: {user}",
        "joinWelcomeDescription": "Katilim basvurunuz inceleniyor. Girmis oldugunuz bilgiler asagida yer almaktadir. Lutfen yetkililerin donus yapmasini bekleyin.",
        "onboardingQuestion": "Katil islemleri icin mi geldiniz?",
        "onboardingYesLabel": "Evet",
        "onboardingNoLabel": "Hayir",
        "callCooldownSeconds": 600,
    },
    "alerts": {
        "staleTicketMinutes": 120,
        "unclaimedTicketMinutes": 20,
        "openTicketThreshold": 15,
    },
    "unproven": {
        "targetRoleIds": [],
        "proofChannelId": None,
    },
    "bannedWords": [],
    "channelAnalysis": {
        "rules": [],
    },
    "rankSystem": {
        "enabled": True,
        "curve": {
            "baseXp": 100,
            "linearXp": 35,
            "quadraticXp": 10,
        },
        "leaderboard": {
            "panelPageSize": 50,
            "commandTopSize": 10,
        },
        "text": {
            "enabled": True,
            "xpPerEligibleMessage": 5,
            "cooldownSeconds": 45,
            "minNormalizedLength": 8,
            "duplicateWindowMinutes": 10,
            "hourlyEligibleCap": 20,
            "ignoredChannelIds": [],
            "ignoredCategoryIds": [],
        },
        "voice": {
            "enabled": True,
            "xpPerActiveMinute": 2,
            "minAwardChunkSeconds": 60,
        },
        "rewards": {
            "roleRewardsEnabled": False,
            "levelUpMessagesEnabled": False,
            "announcementChannelId": None,
            "roleMode": "highest_only",
            "voiceRewards": [],
            "textRewards": [],
        },
    },
    "moderation": {
        "jailRoleId": None,
        "mutedRoleId": None,
        "logChannelId": None,
        "defaultDmEnabled": True,
        "defaultTimeoutMinutes": 10,
        "defaultWarnPoints": 1,
        "purgeMaxLimit": 200,
        "safeFlowEnabled": True,
        "globalBanEnabled": False,
        "roleLimits": [],
        "userLimits": [],
    },
    "ultraProtection": {
        "enabled": False,
        "quarantineRoleId": None,
        "whitelist": {
            "userIds": [],
            "roleIds": [],
        },
        "blacklist": {
            "userIds": [],
            "roleIds": [],
        },
        "schedule": {
            "enabled": False,
            "startHour": 0,
            "endHour": 8,
        },
        "channelGuard": {
            "enabled": False,
            "quarantine": True,
            "restoreOnDelete": True,
            "logOnly": False,
            "severityOverride": "inherit",
            "auditWindowSeconds": 180,
            "whitelistRoleIds": [],
            "cooldownSeconds": 0,
            "actionTier": "quarantine",
        },
        "categoryGuard": {
            "enabled": False,
            "quarantine": True,
            "restoreOnDelete": True,
            "logOnly": False,
            "severityOverride": "inherit",
            "auditWindowSeconds": 180,
            "whitelistRoleIds": [],
            "cooldownSeconds": 0,
            "actionTier": "quarantine",
        },
        "webhookGuard": {
            "enabled": False,
            "quarantine": True,
            "logOnly": False,
            "severityOverride": "inherit",
            "auditWindowSeconds": 180,
            "whitelistRoleIds": [],
            "cooldownSeconds": 0,
            "actionTier": "quarantine",
        },
        "botGuard": {
            "enabled": False,
            "quarantine": True,
            "kickUnauthorizedBots": True,
            "allowedBotIds": [],
            "logOnly": False,
            "severityOverride": "inherit",
            "auditWindowSeconds": 180,
            "whitelistRoleIds": [],
            "cooldownSeconds": 0,
            "actionTier": "quarantine",
        },
        "guildSettingsGuard": {
            "enabled": False,
            "quarantine": True,
            "logOnly": False,
            "severityOverride": "inherit",
            "auditWindowSeconds": 180,
            "whitelistRoleIds": [],
            "cooldownSeconds": 0,
            "actionTier": "quarantine",
        },
        "bulkActionGuard": {
            "enabled": False,
            "quarantine": True,
            "windowSeconds": 120,
            "maxActions": 3,
            "logOnly": False,
            "severityOverride": "inherit",
            "auditWindowSeconds": 180,
            "whitelistRoleIds": [],
            "cooldownSeconds": 0,
            "actionTier": "quarantine",
        },
        "manualActionGuard": {
            "enabled": False,
            "quarantine": True,
            "logOnly": False,
            "severityOverride": "inherit",
            "auditWindowSeconds": 180,
            "whitelistRoleIds": [],
            "cooldownSeconds": 0,
            "actionTier": "quarantine",
        },
        "roleGuard": {
            "enabled": False,
            "quarantine": True,
            "restrictedPermissions": [
                "Administrator",
                "ManageGuild",
                "ManageRoles",
                "ManageChannels",
                "ManageWebhooks",
                "BanMembers",
                "KickMembers",
            ],
            "autoDeleteRiskyNewRoles": True,
            "protectedRoleIds": [],
            "logOnly": False,
            "severityOverride": "inherit",
            "auditWindowSeconds": 180,
            "whitelistRoleIds": [],
            "cooldownSeconds": 0,
            "actionTier": "quarantine",
        },
        "antiRaidGuard": {
            "enabled": False,
            "quarantine": True,
            "windowSeconds": 30,
            "joinThreshold": 8,
            "minAccountAgeDays": 7,
            "raidAction": "kick",
            "raidModeCooldownMinutes": 15,
            "logOnly": False,
            "severityOverride": "inherit",
            "auditWindowSeconds": 180,
            "whitelistRoleIds": [],
            "cooldownSeconds": 0,
            "actionTier": "quarantine",
        },
        "inviteLinkGuard": {
            "enabled": False,
            "quarantine": True,
            "blockDiscordInvites": True,
            "allowedDomains": [],
            "exemptChannelIds": [],
            "actionOnViolation": "delete",
            "logOnly": False,
            "severityOverride": "inherit",
            "auditWindowSeconds": 180,
            "whitelistRoleIds": [],
            "cooldownSeconds": 0,
            "actionTier": "quarantine",
        },
        "messageNukeGuard": {
            "enabled": False,
            "quarantine": True,
            "windowSeconds": 30,
            "deleteThreshold": 10,
            "bulkDeleteThreshold": 2,
            "logOnly": False,
            "severityOverride": "inherit",
            "auditWindowSeconds": 180,
            "whitelistRoleIds": [],
            "cooldownSeconds": 0,
            "actionTier": "quarantine",
        },
        "settingsRollbackGuard": {
            "enabled": False,
            "rollbackFields": ["name", "iconUrl", "bannerUrl", "verificationLevel"],
            "cooldownSeconds": 30,
        },
        "serverBackup": {
            "enabled": False,
            "autoCreateOnBoot": True,
        },
    },
}

def normalize_database_url(url: str) -> str:
    normalized = url
    if normalized.startswith("postgres://"):
        normalized = normalized.replace("postgres://", "postgresql+psycopg://", 1)
    elif normalized.startswith("postgresql://"):
        normalized = normalized.replace("postgresql://", "postgresql+psycopg://", 1)

    parsed = urlsplit(normalized)
    hostname = parsed.hostname or ""
    if hostname != "localhost":
        return normalized

    netloc = parsed.netloc
    userinfo = ""
    hostinfo = netloc
    if "@" in netloc:
        userinfo, hostinfo = netloc.rsplit("@", 1)

    if hostinfo.startswith("localhost:"):
        hostinfo = hostinfo.replace("localhost", "127.0.0.1", 1)
    elif hostinfo == "localhost":
        hostinfo = "127.0.0.1"

    rebuilt_netloc = f"{userinfo}@{hostinfo}" if userinfo else hostinfo
    return urlunsplit(
        SplitResult(
            scheme=parsed.scheme,
            netloc=rebuilt_netloc,
            path=parsed.path,
            query=parsed.query,
            fragment=parsed.fragment,
        )
    )


def deep_merge(base: dict, incoming: dict | None) -> dict:
    result = deepcopy(base)
    if not incoming:
        return result

    for key, value in incoming.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


class Settings:
    def __init__(self) -> None:
        payload = self._load_settings()
        discord = payload.get("discord", {})
        runtime = payload.get("runtime", {})
        panel = payload.get("panel", {})

        self.discord_token = os.getenv("DISCORD_TOKEN", discord.get("token", ""))
        self.discord_client_id = os.getenv("DISCORD_CLIENT_ID", discord.get("clientId", ""))
        self.discord_guild_id = os.getenv("DISCORD_GUILD_ID", discord.get("guildId", ""))
        self.owner_id = os.getenv("OWNER_ID", discord.get("ownerId"))
        self.database_url = normalize_database_url(
            os.getenv(
                "DATABASE_URL",
                runtime.get("databaseUrl", "postgresql+psycopg://postgres:postgres@localhost:5432/discord_supervisor"),
            )
        )
        self.redis_url = os.getenv("REDIS_URL", runtime.get("redisUrl", ""))
        self.timezone = os.getenv("SUPERVISOR_TIMEZONE", runtime.get("timezone", "Europe/Istanbul"))
        self.log_level = os.getenv("LOG_LEVEL", runtime.get("logLevel", "info"))
        self.host = os.getenv("PANEL_HOST", panel.get("host", "127.0.0.1"))
        self.port = int(os.getenv("PANEL_PORT", panel.get("port", 5231)))

    @staticmethod
    def _load_settings() -> dict:
        if not SETTINGS_FILE.exists():
            return {}

        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))


settings = Settings()
