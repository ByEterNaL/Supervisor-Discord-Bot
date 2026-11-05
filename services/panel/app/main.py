from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from math import ceil
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.exceptions import RequestValidationError
import urllib.parse

from .repository import (
    fetch_config,
    get_action_analytics,
    get_alerts,
    get_member_rank_detail,
    get_member_detail,
    get_member_directory_entry,
    get_message_history_sync_status,
    get_overview,
    get_rank_backfill_status,
    get_staff_message_audit_summary,
    get_system_health,
    get_ticket_analytics,
    get_voice_analytics,
    get_unproven_actions,
    get_unproven_count,
    clear_unproven_actions,
    create_server_backup,
    delete_server_backup,
    list_guild_channels,
    list_member_picker_options,
    list_channel_analysis_actions,
    list_moderation_actions,
    json_array,
    json_object,
    list_guard_log_events,
    list_server_backups,
    list_rank_leaderboard,
    list_recent_moderation_activity_for_member,
    list_moderation_cases,
    list_moderation_cases_for_member,
    list_role_change_events_for_member,
    list_role_change_events,
    list_guild_roles,
    list_members,
    list_staff_message_events,
    request_rank_reward_sync,
    request_message_history_sync,
    reset_rank_system,
    save_config,
)
from .config import settings

BASE_DIR = Path(__file__).resolve().parent
PANEL_STARTED_AT = datetime.now(timezone.utc)
PERMISSION_LABELS = {
    "CreateInstantInvite": "Anında Davet Oluştur",
    "KickMembers": "Üye At",
    "BanMembers": "Üye Yasakla",
    "Administrator": "Yönetici",
    "ManageChannels": "Kanalları Yönet",
    "ManageGuild": "Sunucuyu Yönet",
    "AddReactions": "Tepki Ekle",
    "ViewAuditLog": "Denetim Kaydını Görüntüle",
    "PrioritySpeaker": "Öncelikli Konuşmacı",
    "Stream": "Yayın Aç",
    "ViewChannel": "Kanalları Görüntüle",
    "SendMessages": "Mesaj Gönder",
    "SendTTSMessages": "TTS Mesajı Gönder",
    "ManageMessages": "Mesajları Yönet",
    "EmbedLinks": "Bağlantı Önizlemesi Ekle",
    "AttachFiles": "Dosya Ekle",
    "ReadMessageHistory": "Mesaj Geçmişini Gör",
    "MentionEveryone": "@everyone ve @here Kullan",
    "UseExternalEmojis": "Harici Emojileri Kullan",
    "ViewGuildInsights": "Sunucu İstatistiklerini Gör",
    "Connect": "Bağlan",
    "Speak": "Konuş",
    "MuteMembers": "Üyeleri Sustur",
    "DeafenMembers": "Üyeleri Sağırlaştır",
    "MoveMembers": "Üyeleri Taşı",
    "UseVAD": "Ses Etkinliğini Kullan",
    "ChangeNickname": "Takma Adını Değiştir",
    "ManageNicknames": "Takma Adları Yönet",
    "ManageRoles": "Rolleri Yönet",
    "ManageWebhooks": "Webhookları Yönet",
    "ManageEmojisAndStickers": "Emoji ve Çıkartmaları Yönet",
    "ManageGuildExpressions": "Sunucu İfadelerini Yönet",
    "UseApplicationCommands": "Uygulama Komutlarını Kullan",
    "RequestToSpeak": "Konuşma İste",
    "ManageEvents": "Etkinlikleri Yönet",
    "ManageThreads": "Başlıkları Yönet",
    "CreatePublicThreads": "Genel Başlık Oluştur",
    "CreatePrivateThreads": "Özel Başlık Oluştur",
    "UseExternalStickers": "Harici Çıkartmaları Kullan",
    "SendMessagesInThreads": "Başlıklarda Mesaj Gönder",
    "UseEmbeddedActivities": "Gömülü Etkinlikleri Kullan",
    "ModerateMembers": "Üyeleri Zaman Aşımına Al",
    "ViewCreatorMonetizationAnalytics": "Gelir İstatistiklerini Gör",
    "UseSoundboard": "Ses Tahtasını Kullan",
    "CreateGuildExpressions": "Sunucu İfadeleri Oluştur",
    "CreateEvents": "Etkinlik Oluştur",
    "UseExternalSounds": "Harici Sesleri Kullan",
    "SendVoiceMessages": "Sesli Mesaj Gönder",
    "SendPolls": "Anket Gönder",
    "UseExternalApps": "Harici Uygulamaları Kullan",
    "PinMessages": "Mesaj Sabitle",
    "BypassSlowmode": "Yavaş Modu Aş",
}
RISKY_PERMISSION_NAMES = {
    "Administrator",
    "BanMembers",
    "KickMembers",
    "ManageGuild",
    "ManageRoles",
    "ManageChannels",
    "ModerateMembers",
    "ViewAuditLog",
    "ManageWebhooks",
}

app = FastAPI(title="Supervisor Discord Bot Panel")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    msg = "Lütfen tüm alanları doğru formatta doldurun."
    referer = request.headers.get("referer")
    if not referer:
        referer = str(request.url).split("?")[0]
    sep = "&" if "?" in referer else "?"
    redirect_url = f"{referer}{sep}error={urllib.parse.quote(msg)}"
    return RedirectResponse(redirect_url, status_code=303)

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    import traceback
    return HTMLResponse('<pre>' + traceback.format_exc() + '</pre>', status_code=500)


def hours_value(value: Any) -> float:
    try:
        seconds = float(value or 0)
    except (TypeError, ValueError):
        return 0

    if seconds <= 0:
        return 0

    return round(seconds / 3600, 1)


def hours_label(value: Any) -> str:
    return f"{hours_value(value)} saat"


def hours_list(values: list[Any]) -> list[float]:
    return [hours_value(value) for value in values]


def visible_share(value: Any, values: list[Any]) -> int:
    current = max(hours_value(value), 0)
    total = sum(max(hours_value(item), 0) for item in values)
    if total <= 0 or current <= 0:
        return 0
    return int(round((current / total) * 100))


def local_now() -> datetime:
    return datetime.now(ZoneInfo(settings.timezone))


def format_timestamp(value: Any) -> str:
    if not isinstance(value, datetime):
        return "-"

    current = value
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)

    return current.astimezone(ZoneInfo(settings.timezone)).strftime("%d.%m.%Y %H:%M:%S")


def relative_timestamp(value: Any) -> str:
    if not isinstance(value, datetime):
        return "-"

    current = value
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)

    delta_seconds = int((local_now() - current.astimezone(ZoneInfo(settings.timezone))).total_seconds())
    if delta_seconds < 60:
        return f"{max(delta_seconds, 0)} sn önce"
    if delta_seconds < 3600:
        return f"{delta_seconds // 60} dk önce"
    if delta_seconds < 86400:
        return f"{delta_seconds // 3600} sa önce"
    return f"{delta_seconds // 86400} gün önce"


def humanize_permission_name(name: str) -> str:
    translated = PERMISSION_LABELS.get(name)
    if translated:
        return translated
    label = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name).replace("_", " ").strip()
    return label.title()


def bool_text(value: Any) -> str:
    return "Açık" if bool(value) else "Kapalı"


def parse_json_array(data: str | None) -> list:
    if not data or not data.strip():
        return []
    try:
        parsed = json.loads(data)
        if isinstance(parsed, list):
            return parsed
    except Exception:
        pass
    return []


def parse_datetime_value(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value

    if isinstance(value, str):
        normalized = value.strip()
        if not normalized:
            return None
        try:
            parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed

    return None


def format_minutes_label(value: Any) -> str:
    try:
        total_minutes = max(int(round(float(value or 0))), 0)
    except (TypeError, ValueError):
        total_minutes = 0

    days, remainder = divmod(total_minutes, 1440)
    hours, minutes = divmod(remainder, 60)
    parts: list[str] = []
    if days:
        parts.append(f"{days} gün")
    if hours:
        parts.append(f"{hours} saat")
    if minutes or not parts:
        parts.append(f"{minutes} dakika")
    return " ".join(parts)


def build_alert_scene(alerts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    channel_map = {
        str(item.get("channel_id")): item.get("channel_name") or f"Kanal {item.get('channel_id')}"
        for item in list_guild_channels()
    }
    alert_titles = {
        "unclaimed_ticket": "Üstlenilmemiş Ticket",
        "stale_ticket": "Uzun Süredir Açık Ticket",
        "ticket_overload": "Açık Ticket Yoğunluğu",
    }
    severity_badges = {
        "critical": {"label": "Kritik", "class_name": "nx-badge--red"},
        "warning": {"label": "Uyarı", "class_name": "nx-badge--orange"},
    }
    alert_actions = {
        "unclaimed_ticket": "Bir yetkili atayıp ilk yanıtı mümkün olan en kısa sürede verin.",
        "stale_ticket": "Ticket durumunu güncelleyip bekleyen kullanıcıya dönüş sağlayın.",
        "ticket_overload": "Açık ticket kuyruğunu azaltmak için ek ekip desteği planlayın.",
    }

    items: list[dict[str, Any]] = []
    for alert in alerts:
        payload = alert.get("payload") or {}
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except ValueError:
                payload = {}
        if not isinstance(payload, dict):
            payload = {}

        alert_type = str(alert.get("alert_type") or "")
        ticket_id = payload.get("ticket_id")
        channel_id = payload.get("channel_id")
        channel_name = channel_map.get(str(channel_id), f"Kanal {channel_id}") if channel_id else None
        ticket_created_at = parse_datetime_value(payload.get("created_at"))
        alert_created_at = parse_datetime_value(alert.get("created_at"))
        severity = str(alert.get("severity") or "warning")
        severity_meta = severity_badges.get(severity, severity_badges["warning"])

        if alert_type == "unclaimed_ticket":
            summary = (
                f"Ticket #{ticket_id} henüz hiçbir yetkili tarafından üstlenilmedi."
                if ticket_id
                else "Bir ticket henüz hiçbir yetkili tarafından üstlenilmedi."
            )
        elif alert_type == "stale_ticket":
            summary = (
                f"Ticket #{ticket_id} uzun süredir açık bekliyor ve müdahale gerektiriyor."
                if ticket_id
                else "Uzun süredir açık bekleyen bir ticket var."
            )
        elif alert_type == "ticket_overload":
            open_ticket_count = payload.get("open_ticket_count")
            summary = (
                f"Sunucudaki açık ticket sayısı {open_ticket_count} oldu ve eşik değer aşıldı."
                if open_ticket_count is not None
                else "Açık ticket sayısı belirlenen eşik değeri aştı."
            )
        else:
            summary = "Müdahale gerektiren bir alarm oluştu."

        details: list[dict[str, str]] = []
        if ticket_id is not None:
            details.append({"label": "Ticket", "value": f"#{ticket_id}"})
        if channel_name:
            details.append({"label": "Kanal", "value": str(channel_name)})
        if ticket_created_at:
            details.append({"label": "Oluşturulma", "value": format_timestamp(ticket_created_at)})
        if alert_type == "stale_ticket" and payload.get("minutes_open") is not None:
            details.append(
                {
                    "label": "Açık Kalma",
                    "value": format_minutes_label(payload.get("minutes_open")),
                }
            )
        if alert_created_at:
            details.append({"label": "Alarm Zamanı", "value": format_timestamp(alert_created_at)})

        items.append(
            {
                **alert,
                "title": alert_titles.get(alert_type, "Sistem Alarmı"),
                "summary": summary,
                "details": details,
                "severity_label": severity_meta["label"],
                "severity_badge_class": severity_meta["class_name"],
                "severity_note": "Hızlı müdahale gerekli" if severity == "critical" else "Takip edilmesi önerilir",
                "action_text": alert_actions.get(alert_type, "Alarmı inceleyip uygun aksiyonu alın."),
                "created_relative": relative_timestamp(alert_created_at) if alert_created_at else "-",
            }
        )

    return items


def build_role_history_summary(text: str, is_risky: bool = False) -> dict[str, Any]:
    return {
        "text": text,
        "is_risky": is_risky,
    }


def build_role_history_scene(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    field_labels = {
        "name": "Ad",
        "color": "Renk",
        "position": "Konum",
        "mentionable": "Etiketlenebilir",
        "managed": "Yönetilen",
        "hoist": "Ayrık Görünüm",
    }
    action_meta = {
        "create": {"label": "Oluşturuldu", "tone": "#59d0c2"},
        "update": {"label": "Güncellendi", "tone": "#ff9d3f"},
        "delete": {"label": "Silindi", "tone": "#ff5d6c"},
        "assign": {"label": "Verildi", "tone": "#7ad1ff"},
        "unassign": {"label": "Alındı", "tone": "#ff7aa2"},
    }

    items: list[dict[str, Any]] = []
    for event in events:
        payload = event.get("change_payload") or {}
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except ValueError:
                payload = {}
        action_type = event.get("action_type") or "update"
        summaries: list[str] = []

        if action_type == "update":
            for change in payload.get("changes", []):
                field_name = str(change.get("field") or "")
                if field_name == "permissions":
                    added_raw = list(change.get("addedPermissions") or [])
                    removed_raw = list(change.get("removedPermissions") or [])
                    added = [
                        humanize_permission_name(item)
                        for item in added_raw
                    ]
                    removed = [
                        humanize_permission_name(item)
                        for item in removed_raw
                    ]
                    if added:
                        summaries.append(
                            build_role_history_summary(
                                f"İzin eklendi: {', '.join(added)}",
                                is_risky=any(item in RISKY_PERMISSION_NAMES for item in added_raw),
                            )
                        )
                    if removed:
                        summaries.append(
                            build_role_history_summary(
                                f"İzin kaldırıldı: {', '.join(removed)}"
                            )
                        )
                    continue

                old_value = change.get("oldValue")
                new_value = change.get("newValue")
                if isinstance(old_value, bool) or isinstance(new_value, bool):
                    old_value = bool_text(old_value)
                    new_value = bool_text(new_value)
                summaries.append(
                    build_role_history_summary(
                        f"{field_labels.get(field_name, field_name.title())}: {old_value} -> {new_value}"
                    )
                )
        elif action_type in {"assign", "unassign"}:
            target_member = payload.get("targetMember") or {}
            target_member_name = (
                target_member.get("displayName")
                or target_member.get("username")
                or target_member.get("id")
                or "Bilinmeyen üye"
            )
            summaries = [
                build_role_history_summary(f"Hedef üye: {target_member_name}"),
                build_role_history_summary(f"Üye ID: {target_member.get('id') or '-'}"),
            ]
        else:
            snapshot = payload.get("snapshot") or {}
            permission_count = len(snapshot.get("permissions") or [])
            summaries = [
                build_role_history_summary(f"Ad: {snapshot.get('name') or event.get('role_name')}"),
                build_role_history_summary(f"Konum: {snapshot.get('position') or 0}"),
                build_role_history_summary(f"İzin sayısı: {permission_count}"),
                build_role_history_summary(f"Etiketlenebilir: {bool_text(snapshot.get('mentionable'))}"),
            ]

        actor_name = event.get("actor_name") or (
            f"Kullanıcı {event['actor_id']}" if event.get("actor_id") else "Bilinmiyor"
        )
        meta = action_meta.get(action_type, action_meta["update"])
        items.append(
            {
                **event,
                "action_label": meta["label"],
                "action_tone": meta["tone"],
                "actor_display": actor_name,
                "created_at_label": format_timestamp(event.get("created_at")),
                "created_at_relative": relative_timestamp(event.get("created_at")),
                "summaries": summaries or [build_role_history_summary("Değişiklik özeti yok.")],
            }
        )

    return items


def build_health_scene(health_data: dict[str, Any], sync_status: dict[str, Any]) -> dict[str, Any]:
    now_value = health_data.get("database", {}).get("checked_at") or datetime.now(timezone.utc)

    def status_meta(status: str) -> dict[str, str]:
        mapping = {
            "healthy": {"label": "Sağlıklı", "tone": "#55d07b"},
            "warning": {"label": "Yavaş / Riskli", "tone": "#ff9d3f"},
            "critical": {"label": "Kritik", "tone": "#ff5d6c"},
            "disabled": {"label": "Kapalı", "tone": "#7ad1ff"},
        }
        return mapping.get(status, mapping["warning"])

    def heartbeat_status(service_name: str, label: str, note: str) -> dict[str, Any]:
        row = (health_data.get("heartbeats") or {}).get(service_name)
        if not row:
            meta = status_meta("critical")
            return {
                "key": service_name,
                "label": label,
                "status": "critical",
                "status_label": meta["label"],
                "tone": meta["tone"],
                "note": note,
                "detail": "Heartbeat gelmiyor",
                "last_seen_label": "-",
                "age_label": "-",
                "started_at_label": "-",
            }

        last_seen = row.get("last_seen_at")
        started_at = row.get("started_at")
        age_seconds = (
            int((now_value - last_seen).total_seconds())
            if isinstance(last_seen, datetime)
            else 999999
        )
        status = "healthy"
        if age_seconds > 300:
            status = "critical"
        elif age_seconds > 90:
            status = "warning"
        meta = status_meta(status)
        heartbeat_payload = row.get("payload") or {}
        if not isinstance(heartbeat_payload, dict):
            heartbeat_payload = {}
        extra = []
        if heartbeat_payload.get("mode"):
            extra.append(f"Mod: {heartbeat_payload['mode']}")
        if heartbeat_payload.get("userTag"):
            extra.append(str(heartbeat_payload["userTag"]))
        return {
            "key": service_name,
            "label": label,
            "status": status,
            "status_label": meta["label"],
            "tone": meta["tone"],
            "note": note,
            "detail": " - ".join(extra) if extra else "Heartbeat aktif",
            "last_seen_label": format_timestamp(last_seen),
            "age_label": relative_timestamp(last_seen),
            "started_at_label": format_timestamp(started_at),
        }

    database = health_data.get("database") or {}
    database_meta = status_meta(database.get("status", "critical"))
    redis_payload = health_data.get("redis") or {}
    redis_meta = status_meta(redis_payload.get("status", "disabled"))

    sync_state = sync_status.get("status") or "idle"
    if sync_state == "failed":
        sync_health = "critical"
    elif sync_state == "requested":
        sync_health = "warning"
    else:
        sync_health = "healthy"
    sync_meta = status_meta(sync_health)

    services = [
        {
            "key": "panel",
            "label": "Panel",
            "status": "healthy",
            "status_label": status_meta("healthy")["label"],
            "tone": status_meta("healthy")["tone"],
            "note": "HTTP arayüzü cevap veriyor",
            "detail": "Web panel aktif",
            "last_seen_label": format_timestamp(now_value),
            "age_label": "şimdi",
            "started_at_label": format_timestamp(PANEL_STARTED_AT),
        },
        {
            "key": "database",
            "label": "Database",
            "status": database.get("status", "critical"),
            "status_label": database_meta["label"],
            "tone": database_meta["tone"],
            "note": "PostgreSQL bağlantısı",
            "detail": (
                f"Gecikme {database['latency_ms']} ms"
                if database.get("latency_ms") is not None
                else (database.get("error") or "Kontrol edilemedi")
            ),
            "last_seen_label": format_timestamp(database.get("checked_at")),
            "age_label": relative_timestamp(database.get("checked_at")),
            "started_at_label": "-",
        },
        {
            "key": "redis",
            "label": "Redis",
            "status": redis_payload.get("status", "disabled"),
            "status_label": redis_meta["label"],
            "tone": redis_meta["tone"],
            "note": "Queue ve pub/sub bağlantısı",
            "detail": (
                f"Gecikme {redis_payload['latency_ms']} ms"
                if redis_payload.get("latency_ms") is not None
                else (redis_payload.get("error") or "Redis devre dışı")
            ),
            "last_seen_label": format_timestamp(redis_payload.get("checked_at")),
            "age_label": relative_timestamp(redis_payload.get("checked_at")),
            "started_at_label": "-",
        },
        heartbeat_status("bot", "Discord Bot", "Gateway ve event işleme durumu"),
        heartbeat_status("worker", "Worker", "Rollup, alarm ve periyodik görevler"),
        {
            "key": "sync",
            "label": "Mesaj Senkronu",
            "status": sync_health,
            "status_label": sync_meta["label"],
            "tone": sync_meta["tone"],
            "note": "Geçmiş mesaj tarama hattı",
            "detail": (
                f"{sync_status['channels_completed']} / {sync_status['channels_total']} kanal - "
                f"{sync_status['scanned_messages']} mesaj"
            ),
            "last_seen_label": format_timestamp(
                sync_status.get("completed_at")
                or sync_status.get("started_at")
                or sync_status.get("requested_at")
            ),
            "age_label": relative_timestamp(
                sync_status.get("completed_at")
                or sync_status.get("started_at")
                or sync_status.get("requested_at")
            ),
            "started_at_label": format_timestamp(sync_status.get("started_at")),
        },
    ]

    healthy_count = sum(1 for item in services if item["status"] == "healthy")
    warning_count = sum(1 for item in services if item["status"] == "warning")
    critical_count = sum(1 for item in services if item["status"] == "critical")
    failed_sync_channels = safe_int(health_data.get("failed_sync_channel_count"))

    system_score = 100
    for item in services:
        if item["status"] == "warning":
            system_score -= 9
        elif item["status"] == "critical":
            system_score -= 18
    system_score = max(0, min(system_score, 100))

    data_confidence_score = 100
    if sync_state == "failed":
        data_confidence_score -= 30
    elif sync_state in {"requested", "running"}:
        data_confidence_score -= 12

    data_confidence_score -= min(failed_sync_channels * 8, 32)

    bot_status = next((item for item in services if item["key"] == "bot"), None)
    worker_status = next((item for item in services if item["key"] == "worker"), None)
    if bot_status and bot_status["status"] == "warning":
        data_confidence_score -= 12
    elif bot_status and bot_status["status"] == "critical":
        data_confidence_score -= 24
    if worker_status and worker_status["status"] == "warning":
        data_confidence_score -= 8
    elif worker_status and worker_status["status"] == "critical":
        data_confidence_score -= 18
    if database.get("status") == "critical":
        data_confidence_score -= 26
    data_confidence_score = max(0, min(data_confidence_score, 100))

    def score_meta(score: int) -> dict[str, str]:
        if score >= 90:
            return {"label": "Çok Güçlü", "tone": "#55d07b"}
        if score >= 75:
            return {"label": "İyi", "tone": "#7ad1ff"}
        if score >= 55:
            return {"label": "Temkinli", "tone": "#ff9d3f"}
        return {"label": "Düşük Güven", "tone": "#ff5d6c"}

    system_score_meta = score_meta(system_score)
    data_score_meta = score_meta(data_confidence_score)
    score_notes = []
    if failed_sync_channels:
        score_notes.append(f"{failed_sync_channels} kanal mesaj senkronunda hata verdi.")
    if sync_state == "failed":
        score_notes.append("Mesaj senkron görevi hata modunda.")
    elif sync_state in {"requested", "running"}:
        score_notes.append("Mesaj senkronu tamamlanmadığı için bazı sayılar değişebilir.")
    if bot_status and bot_status["status"] != "healthy":
        score_notes.append("Bot heartbeat gecikmeli, canlı veride boşluk olabilir.")
    if worker_status and worker_status["status"] != "healthy":
        score_notes.append("Worker gecikmesi periyodik metrikleri etkileyebilir.")
    if not score_notes:
        score_notes.append("Kritik veri hattında belirgin kopukluk görünmüyor.")

    return {
        "summary_cards": [
            {
                "label": "Sağlıklı Servis",
                "value": str(healthy_count),
                "note": "Anlık yanıt veren servisler.",
            },
            {
                "label": "Riskli Servis",
                "value": str(warning_count),
                "note": "Yavaşlayan veya bekleyen akışlar.",
            },
            {
                "label": "Kritik Servis",
                "value": str(critical_count),
                "note": "Müdahale gerektiren kalemler.",
            },
            {
                "label": "Açık Alarm",
                "value": str(health_data.get("open_alert_count") or 0),
                "note": "Çözülmemiş aktif alarm sayısı.",
            },
        ],
        "score_cards": [
            {
                "label": "Sistem Skoru",
                "value": str(system_score),
                "status_label": system_score_meta["label"],
                "tone": system_score_meta["tone"],
                "note": "Servis yanıtı, heartbeat ve temel bağlantı sağlığı.",
            },
            {
                "label": "Veri Güven Skoru",
                "value": str(data_confidence_score),
                "status_label": data_score_meta["label"],
                "tone": data_score_meta["tone"],
                "note": "Senkron tamlığı, veri boşluğu riski ve metrik tazeliği.",
            },
        ],
        "services": services,
        "score_notes": score_notes,
        "insights": [
            {
                "label": "Son 24 Saat Rol Değişikliği",
                "value": str(health_data.get("role_changes_last_day") or 0),
            },
            {
                "label": "Mesaj Senkron Durumu",
                "value": sync_status.get("status_label") or "Hazir",
            },
            {
                "label": "Aktif Kanal",
                "value": sync_status.get("current_channel_name") or "-",
            },
            {
                "label": "Son 24 Saat Mesaj Denetimi",
                "value": str(health_data.get("message_audit_events_last_day") or 0),
            },
        ],
    }


def build_media_distribution(
    voice_seconds: Any, camera_seconds: Any, stream_seconds: Any
) -> dict[str, Any]:
    items = [
        {
            "key": "voice",
            "label": "Aktif Ses",
            "seconds": max(int(voice_seconds or 0), 0),
            "color": "#ff9d3f",
        },
        {
            "key": "camera",
            "label": "Kamera",
            "seconds": max(int(camera_seconds or 0), 0),
            "color": "#59d0c2",
        },
        {
            "key": "stream",
            "label": "Yayin",
            "seconds": max(int(stream_seconds or 0), 0),
            "color": "#ff5d6c",
        },
    ]

    total_seconds = sum(item["seconds"] for item in items)
    display_totals = [item["seconds"] for item in items]
    visible_total_hours = sum(max(hours_value(item["seconds"]), 0) for item in items)
    gradient_parts: list[str] = []
    current_angle = 0.0

    for item in items:
        item["hours"] = hours_value(item["seconds"])
        item["percentage"] = visible_share(item["seconds"], display_totals)
        if visible_total_hours:
            sweep = (max(item["hours"], 0) / visible_total_hours) * 360
            start = current_angle
            end = current_angle + sweep
            gradient_parts.append(f"{item['color']} {start:.2f}deg {end:.2f}deg")
            current_angle = end

    return {
        "items": items,
        "total_seconds": total_seconds,
        "total_hours": hours_value(total_seconds),
        "has_data": visible_total_hours > 0,
        "gradient": ", ".join(gradient_parts)
        if gradient_parts
        else "rgba(255, 255, 255, 0.06) 0deg 360deg",
    }


def build_voice_scene(data: dict[str, Any]) -> dict[str, Any]:
    summary = data.get("summary", {})
    channel_palette = ["#ff9d3f", "#59d0c2", "#7ad1ff", "#ff5d6c", "#ffd36a", "#8df0b7"]

    total_media_seconds = (
        int(summary.get("staff_voice_seconds", 0) or 0)
        + int(summary.get("camera_seconds", 0) or 0)
        + int(summary.get("stream_seconds", 0) or 0)
    )

    media_mix = [
        {
            "label": "Aktif Ses",
            "seconds": int(summary.get("staff_voice_seconds", 0) or 0),
            "hours": hours_value(summary.get("staff_voice_seconds", 0) or 0),
            "tone": "#ff9d3f",
        },
        {
            "label": "Kamera",
            "seconds": int(summary.get("camera_seconds", 0) or 0),
            "hours": hours_value(summary.get("camera_seconds", 0) or 0),
            "tone": "#59d0c2",
        },
        {
            "label": "Yayin",
            "seconds": int(summary.get("stream_seconds", 0) or 0),
            "hours": hours_value(summary.get("stream_seconds", 0) or 0),
            "tone": "#ff5d6c",
        },
    ]

    media_mix_values = [item["seconds"] for item in media_mix]
    for item in media_mix:
        item["percentage"] = visible_share(item["seconds"], media_mix_values)

    channel_total_seconds = sum(int(item.get("total_seconds", 0) or 0) for item in data.get("channels", []))
    channels: list[dict[str, Any]] = []
    for index, item in enumerate(data.get("channels", [])):
        seconds = int(item.get("total_seconds", 0) or 0)
        channels.append(
            {
                **item,
                "hours": hours_value(seconds),
                "share_percentage": round((seconds / channel_total_seconds) * 100)
                if channel_total_seconds
                else 0,
                "accent": channel_palette[index % len(channel_palette)],
            }
        )

    staff_rows = data.get("staff", [])
    staff_peak_seconds = max(
        (
            int(item.get("voice_active_seconds", 0) or 0)
            + int(item.get("camera_seconds", 0) or 0)
            + int(item.get("stream_seconds", 0) or 0)
        )
        for item in staff_rows
    ) if staff_rows else 0

    staff: list[dict[str, Any]] = []
    for index, item in enumerate(staff_rows):
        total_seconds = (
            int(item.get("voice_active_seconds", 0) or 0)
            + int(item.get("camera_seconds", 0) or 0)
            + int(item.get("stream_seconds", 0) or 0)
        )
        name = item.get("display_name") or "Bilinmiyor"
        initials = "".join(part[:1] for part in str(name).split()[:2]).upper()[:2] or "?"
        staff.append(
            {
                **item,
                "rank": index + 1,
                "initials": initials,
                "voice_hours": hours_value(item.get("voice_active_seconds", 0) or 0),
                "camera_hours": hours_value(item.get("camera_seconds", 0) or 0),
                "stream_hours": hours_value(item.get("stream_seconds", 0) or 0),
                "total_hours": hours_value(total_seconds),
                "presence_percentage": round((total_seconds / staff_peak_seconds) * 100)
                if staff_peak_seconds
                else 0,
            }
        )

    user_rows = data.get("users", [])
    user_peak_seconds = max(
        (int(item.get("voice_active_seconds", 0) or 0) for item in user_rows), default=0
    )

    users: list[dict[str, Any]] = []
    for index, item in enumerate(user_rows):
        name = item.get("display_name") or "Bilinmiyor"
        initials = "".join(part[:1] for part in str(name).split()[:2]).upper()[:2] or "?"
        seconds = int(item.get("voice_active_seconds", 0) or 0)
        users.append(
            {
                **item,
                "rank": index + 1,
                "initials": initials,
                "voice_hours": hours_value(seconds),
                "presence_percentage": round((seconds / user_peak_seconds) * 100)
                if user_peak_seconds
                else 0,
            }
        )

    return {
        "summary": {
            **summary,
            "staff_voice_hours": hours_value(summary.get("staff_voice_seconds", 0) or 0),
            "camera_hours": hours_value(summary.get("camera_seconds", 0) or 0),
            "stream_hours": hours_value(summary.get("stream_seconds", 0) or 0),
            "user_voice_hours": hours_value(summary.get("user_voice_seconds", 0) or 0),
            "total_media_hours": hours_value(total_media_seconds),
        },
        "media_mix": media_mix,
        "channels": channels,
        "staff": staff,
        "users": users,
        "top_channel": channels[0] if channels else None,
        "top_staff": staff[0] if staff else None,
    }


def safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def parse_optional_int(value: Any) -> int | None:
    parsed = safe_int(value)
    return parsed if parsed > 0 else None


def build_member_channel_scene(rows: list[dict[str, Any]]) -> dict[str, Any]:
    valid_rows = [row for row in rows if safe_int(row.get("total_seconds")) > 0]
    total_seconds = sum(safe_int(row.get("total_seconds")) for row in valid_rows)
    accents = [
        "var(--nx-orange)",
        "var(--nx-teal)",
        "var(--nx-blue)",
        "var(--nx-red)",
        "var(--nx-purple)",
        "var(--nx-yellow)",
    ]
    items: list[dict[str, Any]] = []
    for index, row in enumerate(valid_rows[:6], start=1):
        total = safe_int(row.get("total_seconds"))
        share = percentage(total, total_seconds) if total_seconds > 0 else 0
        items.append(
            {
                "rank": index,
                "name": str(row.get("channel_name") or f"Kanal #{row.get('channel_id')}"),
                "channel_id": str(row.get("channel_id") or "-"),
                "hours_label": hours_label(total),
                "share_label": f"%{share}",
                "fill_percent": max(share, 8 if total > 0 else 0),
                "accent": accents[(index - 1) % len(accents)],
            }
        )
    return {
        "total_hours_label": hours_label(total_seconds),
        "items": items,
    }


def build_member_heatmap_scene(rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_hour = {
        safe_int(row.get("hour")): safe_int(row.get("total_seconds"))
        for row in rows
        if safe_int(row.get("hour")) >= 0
    }
    peak_seconds = max(by_hour.values(), default=0)
    cells: list[dict[str, Any]] = []
    for hour in range(24):
        total_seconds = by_hour.get(hour, 0)
        ratio = (total_seconds / peak_seconds) if peak_seconds > 0 else 0
        if ratio >= 0.75:
            intensity = "critical"
            intensity_label = "Zirve"
        elif ratio >= 0.45:
            intensity = "high"
            intensity_label = "Yuksek"
        elif ratio > 0:
            intensity = "medium"
            intensity_label = "Aktif"
        else:
            intensity = "empty"
            intensity_label = "Bos"
        cells.append(
            {
                "hour_label": f"{hour:02d}:00",
                "hours_label": hours_label(total_seconds),
                "fill_percent": int(round(ratio * 100)),
                "intensity_class": intensity,
                "intensity_label": intensity_label,
            }
        )
    hottest_hour = max(by_hour, key=by_hour.get) if peak_seconds > 0 else None
    return {
        "has_activity": peak_seconds > 0,
        "cells": cells,
        "peak_label": f"{hottest_hour:02d}:00" if hottest_hour is not None else "-",
        "peak_hours_label": hours_label(peak_seconds),
    }


def percentage(value: int | float, total: int | float) -> int:
    if total <= 0:
        return 0
    return int(round((value / total) * 100))


def build_identity(item: dict[str, Any], index: int) -> dict[str, Any]:
    display_name = str(item.get("display_name") or item.get("username") or "Bilinmiyor")
    initials = "".join(part[:1] for part in display_name.split()[:2]).upper()[:2] or "?"
    return {
        **item,
        "rank": index + 1,
        "display_name": display_name,
        "initials": initials,
        "avatar_url": item.get("avatar_url"),
    }


def rank_xp_for_next_level(level: int, curve: dict[str, Any]) -> int:
    safe_level = max(int(level or 0), 0)
    base_xp = max(safe_int(curve.get("baseXp")), 1)
    linear_xp = max(safe_int(curve.get("linearXp")), 0)
    quadratic_xp = max(safe_int(curve.get("quadraticXp")), 0)
    return max(1, base_xp + (linear_xp * safe_level) + (quadratic_xp * safe_level * safe_level))


def build_rank_progress(total_xp: Any, curve: dict[str, Any]) -> dict[str, int]:
    xp_left = max(safe_int(total_xp), 0)
    level = 0

    while xp_left >= rank_xp_for_next_level(level, curve):
        xp_left -= rank_xp_for_next_level(level, curve)
        level += 1

    next_level_xp = rank_xp_for_next_level(level, curve)
    progress_percent = percentage(xp_left, next_level_xp) if next_level_xp > 0 else 0
    return {
        "level": level,
        "total_xp": max(safe_int(total_xp), 0),
        "current_level_xp": xp_left,
        "next_level_xp": next_level_xp,
        "progress_percent": progress_percent,
    }


def resolve_rank_reward_names(
    level: int,
    rewards: list[dict[str, Any]],
    role_mode: str,
    role_lookup: dict[str, str],
) -> list[str]:
    normalized_rewards = sorted(
        [
            {"level": safe_int(item.get("level")), "roleId": str(item.get("roleId") or "").strip()}
            for item in rewards
            if safe_int(item.get("level")) > 0 and str(item.get("roleId") or "").strip()
        ],
        key=lambda item: item["level"],
    )

    if role_mode == "stacking":
        target_ids = [item["roleId"] for item in normalized_rewards if item["level"] <= level]
    else:
        target_ids = []
        for item in reversed(normalized_rewards):
            if item["level"] <= level:
                target_ids = [item["roleId"]]
                break

    return [role_lookup.get(role_id, role_id) for role_id in target_ids]


def build_rank_status_scene(status: dict[str, Any]) -> dict[str, Any]:
    status_labels = {
        "idle": "Hazır",
        "pending": "Bekliyor",
        "running": "Çalışıyor",
        "completed": "Tamamlandı",
        "failed": "Hata",
    }
    backfill_status = str(status.get("status") or "idle")
    reward_status = str(status.get("reward_sync_status") or "idle")

    return {
        **status,
        "status_label": status_labels.get(backfill_status, "Hazır"),
        "reward_sync_status_label": status_labels.get(reward_status, "Hazır"),
        "job_started_at_label": format_timestamp(status.get("job_started_at")),
        "voice_cutoff_at_label": format_timestamp(status.get("voice_cutoff_at")),
        "completed_at_label": format_timestamp(status.get("completed_at")),
        "reward_sync_requested_at_label": format_timestamp(status.get("reward_sync_requested_at")),
        "reward_sync_completed_at_label": format_timestamp(status.get("reward_sync_completed_at")),
    }


def build_rank_reward_form_rows(
    rewards: list[dict[str, Any]], minimum_rows: int = 6
) -> list[dict[str, Any]]:
    normalized = [
        {
            "level": safe_int(item.get("level")),
            "role_id": str(item.get("roleId") or "").strip(),
        }
        for item in rewards
        if safe_int(item.get("level")) > 0 or str(item.get("roleId") or "").strip()
    ]
    row_count = max(minimum_rows, len(normalized) + 2)
    rows = normalized[:row_count]
    while len(rows) < row_count:
        rows.append({"level": 0, "role_id": ""})
    return rows


def parse_rank_reward_rows(levels: list[str] | None, role_ids: list[str] | None) -> list[dict[str, Any]]:
    rewards: list[dict[str, Any]] = []
    level_values = levels or []
    role_values = role_ids or []
    total = max(len(level_values), len(role_values))
    for index in range(total):
        level_value = safe_int(level_values[index] if index < len(level_values) else 0)
        role_id = str(role_values[index] if index < len(role_values) else "").strip()
        if level_value > 0 and role_id:
            rewards.append({"level": level_value, "roleId": role_id})
    rewards.sort(key=lambda item: (safe_int(item.get("level")), str(item.get("roleId"))))
    return rewards


def build_rank_selected_picker_groups(
    config: dict[str, Any], channel_picker_options: list[dict[str, Any]]
) -> dict[str, list[dict[str, Any]]]:
    rank_config = config.get("rankSystem") or {}
    text_config = rank_config.get("text") or {}
    rewards = rank_config.get("rewards") or {}
    text_channels = [option for option in channel_picker_options if option.get("channel_kind") in {"text", "announcement", "forum", "media"}]
    categories = [option for option in channel_picker_options if option.get("channel_kind") == "category"]
    return {
        "rankAnnouncementChannelId": resolve_picker_items(
            [str(rewards.get("announcementChannelId"))] if rewards.get("announcementChannelId") else [],
            text_channels,
            "Kanal",
        ),
        "rankIgnoredChannelIds": resolve_picker_items(
            [str(item) for item in text_config.get("ignoredChannelIds", [])],
            text_channels,
            "Kanal",
        ),
        "rankIgnoredCategoryIds": resolve_picker_items(
            [str(item) for item in text_config.get("ignoredCategoryIds", [])],
            categories,
            "Kategori",
        ),
    }


def build_rank_board_scene(
    rows: list[dict[str, Any]],
    xp_type: str,
    member_scope: str,
    config: dict[str, Any],
    role_lookup: dict[str, str],
) -> dict[str, Any]:
    rank_config = config.get("rankSystem") or {}
    curve = rank_config.get("curve") or {}
    rewards = rank_config.get("rewards") or {}
    reward_rows = rewards.get("voiceRewards" if xp_type == "voice" else "textRewards", [])
    role_mode = str(rewards.get("roleMode") or "highest_only")
    items: list[dict[str, Any]] = []
    peak_total = max((safe_int(item.get("selected_xp")) for item in rows), default=0)

    for index, row in enumerate(rows):
        item = build_identity(row, index)
        progress = build_rank_progress(row.get("selected_xp"), curve)
        item.update(
            {
                "selected_xp": safe_int(row.get("selected_xp")),
                "selected_level": safe_int(row.get("selected_level")),
                "progress_percent": progress["progress_percent"],
                "current_level_xp": progress["current_level_xp"],
                "next_level_xp": progress["next_level_xp"],
                "reward_badges": resolve_rank_reward_names(
                    progress["level"], reward_rows, role_mode, role_lookup
                ),
                "total_percentage": percentage(safe_int(row.get("selected_xp")), peak_total),
                "voice_level": safe_int(row.get("voice_level")),
                "text_level": safe_int(row.get("text_level")),
                "voice_xp": safe_int(row.get("voice_xp")),
                "text_xp": safe_int(row.get("text_xp")),
            }
        )
        items.append(item)

    member_label = {
        "staff": "Yetkili",
        "all": "Genel",
        "user": "Üye",
    }.get(member_scope, "Üye")
    track_label = "Ses" if xp_type == "voice" else "Metin"

    return {
        "rows": items,
        "xp_type": xp_type,
        "member_scope": member_scope,
        "title": f"{member_label} {track_label} Rütbeleri",
        "description": (
            f"{member_label.lower()} tarafındaki {track_label.lower()} XP sıralamasını "
            "toplam birikim üzerinden gösterir."
        ),
        "summary": {
            "member_count": len(items),
            "top_xp": safe_int(items[0]["selected_xp"]) if items else 0,
            "top_level": max((item["selected_level"] for item in items), default=0),
            "track_label": track_label,
        },
    }


def build_member_rank_scene(
    rank_data: dict[str, Any],
    config: dict[str, Any],
    role_lookup: dict[str, str],
) -> dict[str, Any]:
    profile = rank_data.get("profile")
    if not profile:
        return {"profile": None, "events": []}

    rank_config = config.get("rankSystem") or {}
    curve = rank_config.get("curve") or {}
    rewards = rank_config.get("rewards") or {}
    voice_progress = build_rank_progress(profile.get("voice_xp"), curve)
    text_progress = build_rank_progress(profile.get("text_xp"), curve)
    events: list[dict[str, Any]] = []
    for event in rank_data.get("events", []):
        xp_type = str(event.get("xp_type") or "voice")
        type_label = "Ses" if xp_type == "voice" else "Metin"
        event_type = str(event.get("event_type") or "xp_gain")
        if event_type == "level_up":
            summary = f"{type_label} seviyesinde {safe_int(event.get('level_after'))}. seviyeye ulaştı."
        elif event_type == "backfill":
            summary = f"{type_label} geçmiş verisi içeri taşındı."
        else:
            summary = f"{type_label} için {safe_int(event.get('xp_delta'))} XP eklendi."
        events.append(
            {
                **event,
                "summary": summary,
                "created_at_label": format_timestamp(event.get("created_at")),
            }
        )

    return {
        "profile": {
            **profile,
            "voice_progress": voice_progress,
            "text_progress": text_progress,
            "voice_rewards": resolve_rank_reward_names(
                voice_progress["level"],
                rewards.get("voiceRewards", []),
                str(rewards.get("roleMode") or "highest_only"),
                role_lookup,
            ),
            "text_rewards": resolve_rank_reward_names(
                text_progress["level"],
                rewards.get("textRewards", []),
                str(rewards.get("roleMode") or "highest_only"),
                role_lookup,
            ),
        },
        "events": events,
    }


def build_spotlight(
    label: str,
    item: dict[str, Any] | None,
    metric: str,
    note: str,
    accent: str,
) -> dict[str, Any]:
    return {
        "label": label,
        "name": item.get("display_name") if item else "Veri yok",
        "metric": metric,
        "note": note,
        "accent": accent,
    }


def build_member_scene(members: list[dict[str, Any]], member_type: str) -> dict[str, Any]:
    is_staff = member_type == "staff"
    rows: list[dict[str, Any]] = []
    total_voice_seconds = 0
    total_camera_seconds = 0
    total_stream_seconds = 0
    total_ticket_focus = 0
    total_period_messages = 0
    total_actions = 0

    for item in members:
        voice_seconds = safe_int(item.get("voice_active_seconds"))
        camera_seconds = safe_int(item.get("camera_seconds"))
        stream_seconds = safe_int(item.get("stream_seconds"))
        period_messages = safe_int(item.get("server_message_count"))
        lifetime_messages = safe_int(item.get("total_message_count"))
        ticket_focus_count = safe_int(
            item.get("ticket_claim_count" if is_staff else "ticket_opened_count")
        )
        ban_count = safe_int(item.get("moderation_ban_count"))
        kick_count = safe_int(item.get("moderation_kick_count"))
        timeout_count = safe_int(item.get("moderation_timeout_count"))
        action_total = ban_count + kick_count + timeout_count if is_staff else 0
        media_total_seconds = voice_seconds + camera_seconds + stream_seconds
        period_message_score = ceil(period_messages / 25) if period_messages else 0
        impact_score = (
            hours_value(media_total_seconds)
            + (ticket_focus_count * (18 if is_staff else 14))
            + period_message_score
        )
        if is_staff:
            impact_score += action_total * 24

        total_voice_seconds += voice_seconds
        total_camera_seconds += camera_seconds
        total_stream_seconds += stream_seconds
        total_ticket_focus += ticket_focus_count
        total_period_messages += period_messages
        total_actions += action_total

        rows.append(
            {
                **item,
                "voice_seconds": voice_seconds,
                "camera_seconds": camera_seconds,
                "stream_seconds": stream_seconds,
                "voice_hours": hours_value(voice_seconds),
                "camera_hours": hours_value(camera_seconds),
                "stream_hours": hours_value(stream_seconds),
                "media_total_seconds": media_total_seconds,
                "media_total_hours": hours_value(media_total_seconds),
                "period_message_count": period_messages,
                "lifetime_message_count": lifetime_messages,
                "ticket_focus_count": ticket_focus_count,
                "action_total": action_total,
                "ban_count": ban_count,
                "kick_count": kick_count,
                "timeout_count": timeout_count,
                "impact_score": impact_score,
                "is_active": any(
                    (
                        media_total_seconds > 0,
                        ticket_focus_count > 0,
                        period_messages > 0,
                        action_total > 0,
                    )
                ),
            }
        )

    rows.sort(
        key=lambda current: (
            current["impact_score"],
            current["media_total_seconds"],
            current["ticket_focus_count"],
            current["period_message_count"],
            str(current.get("display_name") or current.get("username") or ""),
        ),
        reverse=True,
    )

    peak_impact = max((item["impact_score"] for item in rows), default=0)
    peak_messages = max((item["period_message_count"] for item in rows), default=0)
    peak_media = max((item["media_total_seconds"] for item in rows), default=0)

    ranked_rows: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        ranked = build_identity(row, index)
        ranked["impact_percentage"] = percentage(ranked["impact_score"], peak_impact)
        ranked["message_percentage"] = percentage(ranked["period_message_count"], peak_messages)
        ranked["media_percentage"] = percentage(ranked["media_total_seconds"], peak_media)
        ranked_rows.append(ranked)

    active_count = sum(1 for row in ranked_rows if row["is_active"])
    total_members = len(ranked_rows)
    total_media_seconds = total_voice_seconds + total_camera_seconds + total_stream_seconds

    media_mix = [
        {
            "label": "Aktif Ses",
            "value": hours_value(total_voice_seconds),
            "percentage": visible_share(
                total_voice_seconds,
                [total_voice_seconds, total_camera_seconds, total_stream_seconds],
            ),
            "note": "Temel aktif ses omurgasi",
            "tone": "#ff9d3f",
        },
        {
            "label": "Kamera",
            "value": hours_value(total_camera_seconds),
            "percentage": visible_share(
                total_camera_seconds,
                [total_voice_seconds, total_camera_seconds, total_stream_seconds],
            ),
            "note": "Gorunur katilim yogunlugu",
            "tone": "#59d0c2",
        },
        {
            "label": "Yayin",
            "value": hours_value(total_stream_seconds),
            "percentage": visible_share(
                total_stream_seconds,
                [total_voice_seconds, total_camera_seconds, total_stream_seconds],
            ),
            "note": "Ekran paylasimi / yayin izi",
            "tone": "#ff5d6c",
        },
    ]

    top_voice = max(ranked_rows, key=lambda row: row["voice_seconds"], default=None)
    top_ticket = max(ranked_rows, key=lambda row: row["ticket_focus_count"], default=None)
    top_messages = max(ranked_rows, key=lambda row: row["period_message_count"], default=None)
    top_special = max(
        ranked_rows,
        key=(lambda row: row["action_total"]) if is_staff else (lambda row: row["stream_seconds"]),
        default=None,
    )

    ticket_label = "Claim" if is_staff else "Acilan Ticket"
    special_label = "Yetki" if is_staff else "Yayin"

    return {
        "copy": {
            "eyebrow": "Yetkili Tablosu" if is_staff else "Topluluk DaÄŸÄ±lÄ±mÄ±",
            "title": (
                "Yetkililerin tÃ¼m istatistikleri tek ekranda"
                if is_staff
                else "Sunucudaki aktif Ã¼yeleri anÄ±nda gÃ¶r"
            ),
            "description": (
                "Seste geÃ§irilen sÃ¼re, Ã¼stlenilen ticketlar ve etkinlikler birleÅŸerek yetkili performansÄ±nÄ± belirler."
                if is_staff
                else "Ãœyelerin ses ve mesaj etkinliklerine gÃ¶re genel durum."
            ),
            "hero_note": (
                f"En yÃ¼ksek puan: {ranked_rows[0]['display_name']} - skor {ranked_rows[0]['impact_score']}"
                if ranked_rows
                else "GÃ¶sterilecek veri yok."
            ),
        },
        "summary": {
            "headline_hours": hours_value(total_voice_seconds),
            "active_count": active_count,
            "total_members": total_members,
            "ticket_focus_total": total_ticket_focus,
            "period_message_total": total_period_messages,
            "action_total": total_actions,
            "total_media_hours": hours_value(total_media_seconds),
        },
        "summary_cards": [
            {
                "label": "Aktif / toplam",
                "value": f"{active_count} / {total_members}",
                "note": "Bu periyotta pozitif veri ureten uye sayisi.",
            },
            {
                "label": ticket_label,
                "value": str(total_ticket_focus),
                "note": "Periyot icindeki destek dokunuslari.",
            },
            {
                "label": "Mesaj hacmi",
                "value": str(total_period_messages),
                "note": "Sunucu geneline yazilan periyot mesajlari.",
            },
        ]
        + (
            [
                {
                    "label": "Yetki toplam",
                    "value": str(total_actions),
                    "note": "Ban, kick ve timeout eylemleri.",
                }
            ]
            if is_staff
            else [
                {
                    "label": "Toplam medya",
                    "value": f"{hours_value(total_media_seconds)} dk",
                    "note": "Ses, kamera ve yayin toplami.",
                }
            ]
        ),
        "media_mix": media_mix,
        "leaders": ranked_rows[:6],
        "roster": ranked_rows,
        "ticket_label": ticket_label,
        "special_label": special_label,
        "spotlights": [
            build_spotlight(
                "En aktif ses",
                top_voice,
                f"{hours_value(top_voice['voice_seconds']) if top_voice else 0} dk",
                "Sesi en cok tasiyan isim.",
                "#ff9d3f",
            ),
            build_spotlight(
                ticket_label,
                top_ticket,
                str(top_ticket["ticket_focus_count"]) if top_ticket else "0",
                "Destek akisinda one cikan uye.",
                "#59d0c2",
            ),
            build_spotlight(
                "Mesaj hacmi",
                top_messages,
                str(top_messages["period_message_count"]) if top_messages else "0",
                "Periyot icinde sohbeti surukleyen isim.",
                "#7ad1ff",
            ),
            build_spotlight(
                special_label,
                top_special,
                (
                    str(top_special["action_total"])
                    if is_staff and top_special
                    else "0"
                    if is_staff
                    else f"{hours_value(top_special['stream_seconds']) if top_special else 0} dk"
                ),
                "Yetki veya yayin tarafinda ayrisan performans.",
                "#ff5d6c",
            ),
        ],
    }


def member_type_label(member_type: str) -> str:
    return "Yetkili" if member_type == "staff" else "Kullanıcı"


def moderation_action_label(action_type: str) -> str:
    labels = {
        "ban": "Ban",
        "unban": "Ban Kaldır",
        "kick": "Kick",
        "timeout": "Timeout",
        "untimeout": "Timeout Kaldır",
        "softban": "Softban",
        "warn": "Warn",
        "unwarn": "Warn Kaldır",
        "jail": "Jail",
        "unjail": "Jail Kaldır",
        "purge": "Purge",
        "lock": "Lock",
        "unlock": "Unlock",
        "slowmode": "Slowmode",
    }
    return labels.get(action_type, action_type.title())


def moderation_case_status_label(status: str) -> str:
    labels = {
        "pending": "Beklemede",
        "active": "Aktif",
        "completed": "Tamamlandı",
        "removed": "Kaldırıldı",
        "cancelled": "İptal Edildi",
        "failed": "Başarısız",
        "expired": "Süresi Doldu",
    }
    return labels.get(status, status.title())


def build_moderation_case_items(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for row in rows:
        metadata = json_object(row.get("metadata"))
        target_type = str(row.get("target_type") or "member")
        target_name = (
            str(row.get("target_channel_name") or row.get("target_member_name") or row.get("target_id") or "-")
            if target_type == "channel"
            else str(row.get("target_member_name") or row.get("target_id") or "-")
        )
        items.append(
            {
                **row,
                "case_label": moderation_action_label(str(row.get("case_type") or "")),
                "status_label": moderation_case_status_label(str(row.get("status") or "pending")),
                "created_at_label": format_timestamp(row.get("created_at")),
                "created_at_relative": relative_timestamp(row.get("created_at")),
                "resolved_at_label": format_timestamp(row.get("resolved_at")),
                "target_name": target_name,
                "duration_label": format_minutes_label(
                    ceil(max(float(row.get("duration_seconds") or 0), 0) / 60)
                )
                if row.get("duration_seconds")
                else None,
                "dm_status_label": (
                    "Gönderildi"
                    if row.get("dm_status") == "sent"
                    else "Gönderilemedi"
                    if row.get("dm_status") == "failed"
                    else "Gönderilmedi"
                ),
                "proof_url": row.get("proof_url"),
                "points": safe_int(row.get("points")),
                "metadata": metadata,
            }
        )
    return items


def build_moderation_action_items(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for row in rows:
        target_type = str(row.get("target_type") or "member")
        target_name = (
            str(row.get("target_channel_name") or row.get("target_member_name") or row.get("target_id") or "-")
            if target_type == "channel"
            else str(row.get("target_member_name") or row.get("target_id") or "-")
        )
        items.append(
            {
                **row,
                "action_label": moderation_action_label(str(row.get("action_type") or "")),
                "created_at_label": format_timestamp(row.get("created_at")),
                "created_at_relative": relative_timestamp(row.get("created_at")),
                "target_name": target_name,
                "source_label": "Bot"
                if row.get("source") == "bot"
                else "Denetim Kaydı"
                if row.get("source") == "audit-log"
                else "Worker"
                if row.get("source") == "worker"
                else str(row.get("source") or "-"),
            }
        )
    return items


def normalize_message_preview(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    return text if text else fallback


def build_message_event_items(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    meta = {
        "edit": {"label": "Düzenlendi", "tone": "#7ad1ff"},
        "delete": {"label": "Silindi", "tone": "#ff5d6c"},
    }
    items: list[dict[str, Any]] = []
    for event in events:
        event_meta = meta.get(event.get("event_type"), meta["edit"])
        before_attachments = list(event.get("before_attachment_urls") or [])
        after_attachments = list(event.get("after_attachment_urls") or [])
        items.append(
            {
                **event,
                "event_label": event_meta["label"],
                "event_tone": event_meta["tone"],
                "created_at_label": format_timestamp(event.get("created_at")),
                "created_at_relative": relative_timestamp(event.get("created_at")),
                "message_created_at_label": format_timestamp(event.get("message_created_at")),
                "before_preview": normalize_message_preview(
                    event.get("before_content"),
                    "Metin yok",
                ),
                "after_preview": normalize_message_preview(
                    event.get("after_content"),
                    "Mesaj artık görünmüyor",
                ),
                "before_attachment_count": len(before_attachments),
                "after_attachment_count": len(after_attachments),
                "message_url": (
                    f"https://discord.com/channels/{event.get('guild_id')}/"
                    f"{event.get('channel_id')}/{event.get('message_id')}"
                ),
            }
        )
    return items


def build_message_audit_scene(
    summary: dict[str, Any],
    events: list[dict[str, Any]],
    staff_options: list[dict[str, Any]],
    selected_user_id: int | None,
    selected_event_type: str | None,
    period: str,
) -> dict[str, Any]:
    return {
        "summary_cards": [
            {
                "label": "Toplam Olay",
                "value": str(safe_int(summary.get("total_events"))),
            },
            {
                "label": "Düzenleme",
                "value": str(safe_int(summary.get("edit_count"))),
            },
            {
                "label": "Silme",
                "value": str(safe_int(summary.get("delete_count"))),
            },
            {
                "label": "Aktif Yetkili",
                "value": str(safe_int(summary.get("active_staff_count"))),
            },
        ],
        "events": build_message_event_items(events),
        "staff_options": staff_options,
        "selected_user_id": str(selected_user_id) if selected_user_id else "",
        "selected_event_type": selected_event_type or "",
        "period": period,
    }


def build_channel_analysis_scene(
    config: dict[str, Any],
    channel_options: list[dict[str, Any]],
    recent_actions: list[dict[str, Any]],
) -> dict[str, Any]:
    channel_map = {str(item.get("channel_id")): item.get("channel_name") for item in channel_options}
    channel_analysis = config.get("channelAnalysis") or {}
    raw_rules = channel_analysis.get("rules") if isinstance(channel_analysis, dict) else []
    rules: list[dict[str, Any]] = []

    for rule in raw_rules or []:
        channel_id = str(rule.get("channelId") or "").strip()
        if not channel_id:
            continue

        max_messages_per_hour = max(safe_int(rule.get("maxMessagesPerHour")), 1)
        timeout_minutes = max(safe_int(rule.get("timeoutMinutes")), 1)
        rules.append(
            {
                "id": str(rule.get("id") or channel_id),
                "channel_id": channel_id,
                "channel_name": channel_map.get(channel_id) or "Bilinmeyen Kanal",
                "max_messages_per_hour": max_messages_per_hour,
                "timeout_minutes": timeout_minutes,
                "timeout_label": format_minutes_label(timeout_minutes),
                "summary": (
                    f"Son 1 saat içinde {max_messages_per_hour} mesaj sınırı aşılırsa otomatik timeout uygulanır."
                ),
            }
        )

    rules.sort(key=lambda item: (str(item["channel_name"]).lower(), item["channel_id"]))

    actions: list[dict[str, Any]] = []
    for action in recent_actions:
        reason = str(action.get("reason") or "").strip()
        readable_reason = reason.replace("Kanal Analizi: ", "", 1) if reason else "Otomatik timeout uygulandı."
        status = str(action.get("status") or "timeout")
        actions.append(
            {
                **action,
                "target_name": action.get("target_name") or action.get("target_id") or "Bilinmeyen Üye",
                "reason_label": readable_reason,
                "created_at_label": format_timestamp(action.get("created_at")),
                "created_at_relative": relative_timestamp(action.get("created_at")),
                "status_label": "Timeout" if status == "timeout" else "Uygulanamadı",
                "status_badge_class": "nx-badge--red" if status == "timeout" else "nx-badge--orange",
            }
        )

    return {
        "rules": rules,
        "recent_actions": actions,
    }


GUARD_FEATURE_DEFS: list[dict[str, Any]] = [
    {
        "key": "channelGuard",
        "form_prefix": "channel_guard",
        "title": "Kanal Guard",
        "description": "Kanal oluşturma, silme ve güncelleme işlemlerini denetler.",
        "icon": "fas fa-hashtag",
        "accent": "nx-badge--orange",
        "category": "yapi",
        "supports_advanced": True,
        "quarantine_label": "Tetiklenince karantina uygula",
        "extras": ["restoreOnDelete"],
    },
    {
        "key": "categoryGuard",
        "form_prefix": "category_guard",
        "title": "Kategori Guard",
        "description": "Kategori seviyesindeki değişimleri ayrı olarak korur.",
        "icon": "fas fa-folder-tree",
        "accent": "nx-badge--orange",
        "category": "yapi",
        "supports_advanced": True,
        "quarantine_label": "Tetiklenince karantina uygula",
        "extras": ["restoreOnDelete"],
    },
    {
        "key": "webhookGuard",
        "form_prefix": "webhook_guard",
        "title": "Webhook Guard",
        "description": "İzinsiz webhook açma, silme ve güncelleme hareketlerini izler.",
        "icon": "fas fa-link",
        "accent": "nx-badge--red",
        "category": "yapi",
        "supports_advanced": True,
        "quarantine_label": "Tetiklenince karantina uygula",
    },
    {
        "key": "botGuard",
        "form_prefix": "bot_guard",
        "title": "Bot Guard",
        "description": "Yetkisiz bot eklemelerini tespit eder ve istenirse botu atar.",
        "icon": "fas fa-robot",
        "accent": "nx-badge--red",
        "category": "yapi",
        "supports_advanced": True,
        "quarantine_label": "Ekleyen kişiye karantina uygula",
        "extras": ["kickUnauthorizedBots", "allowedBotIds"],
    },
    {
        "key": "guildSettingsGuard",
        "form_prefix": "guild_settings_guard",
        "title": "Sunucu Ayar Guard",
        "description": "İsim, ikon, banner ve doğrulama seviyesi değişimlerini denetler.",
        "icon": "fas fa-castle",
        "accent": "nx-badge--orange",
        "category": "sunucu",
        "supports_advanced": True,
        "quarantine_label": "Tetiklenince karantina uygula",
    },
    {
        "key": "roleGuard",
        "form_prefix": "role_guard",
        "title": "Rol Guard",
        "description": "Yeni yüksek yetkili roller, izin yükseltme ve kritik rol silme olaylarını yakalar.",
        "icon": "fas fa-user-shield",
        "accent": "nx-badge--red",
        "category": "sunucu",
        "supports_advanced": True,
        "quarantine_label": "Tetiklenince karantina uygula",
        "extras": [
            "restrictedPermissions",
            "autoDeleteRiskyNewRoles",
            "protectedRoleIds",
        ],
    },
    {
        "key": "settingsRollbackGuard",
        "form_prefix": "settings_rollback_guard",
        "title": "Ayar Rollback Guard",
        "description": "Sunucu isim/ikon/banner/güvenlik değişikliklerini otomatik olarak geri alır.",
        "icon": "fas fa-rotate-left",
        "accent": "nx-badge--purple",
        "category": "sunucu",
        "supports_advanced": False,
        "extras": ["rollbackFields", "cooldownSeconds"],
    },
    {
        "key": "bulkActionGuard",
        "form_prefix": "bulk_action_guard",
        "title": "Toplu İşlem Guard",
        "description": "Kısa sürede art arda gelen riskli işlemleri patlama olarak işler.",
        "icon": "fas fa-burst",
        "accent": "nx-badge--red",
        "category": "davranis",
        "supports_advanced": True,
        "quarantine_label": "Eşik aşılınca karantina uygula",
        "extras": ["windowSeconds", "maxActions"],
    },
    {
        "key": "manualActionGuard",
        "form_prefix": "manual_action_guard",
        "title": "Manuel İşlem Guard",
        "description": "Bot komutları dışında audit log'dan gelen ban, kick ve timeoutları izler.",
        "icon": "fas fa-hand-paper",
        "accent": "nx-badge--orange",
        "category": "davranis",
        "supports_advanced": True,
        "quarantine_label": "Tetiklenince karantina uygula",
    },
    {
        "key": "antiRaidGuard",
        "form_prefix": "anti_raid_guard",
        "title": "Anti-Raid Guard",
        "description": "Kısa sürede çok sayıda katılımı algılar ve genç hesapları otomatik engeller.",
        "icon": "fas fa-users-slash",
        "accent": "nx-badge--red",
        "category": "davranis",
        "supports_advanced": True,
        "quarantine_label": "Raid modunda genç hesaplara karantina uygula",
        "extras": [
            "windowSeconds",
            "joinThreshold",
            "minAccountAgeDays",
            "raidAction",
            "raidModeCooldownMinutes",
        ],
    },
    {
        "key": "inviteLinkGuard",
        "form_prefix": "invite_link_guard",
        "title": "Davet / Link Guard",
        "description": "Discord davet bağlantılarını ve izinsiz dış linkleri yakalar.",
        "icon": "fas fa-square-arrow-up-right",
        "accent": "nx-badge--orange",
        "category": "mesaj",
        "supports_advanced": True,
        "quarantine_label": "İhlal halinde karantina uygula",
        "extras": [
            "blockDiscordInvites",
            "allowedDomains",
            "exemptChannelIds",
            "actionOnViolation",
        ],
    },
    {
        "key": "messageNukeGuard",
        "form_prefix": "message_nuke_guard",
        "title": "Mesaj Nuke Guard",
        "description": "Kısa sürede çok sayıda mesaj silen veya bulk-delete yapan aktörleri durdurur.",
        "icon": "fas fa-eraser",
        "accent": "nx-badge--red",
        "category": "mesaj",
        "supports_advanced": True,
        "quarantine_label": "Eşik aşılınca karantina uygula",
        "extras": ["windowSeconds", "deleteThreshold", "bulkDeleteThreshold"],
    },
    {
        "key": "autoModGuard",
        "form_prefix": "auto_mod_guard",
        "title": "AutoMod Kalkanı",
        "description": "Discord AutoMod ile mesajlar sunucuya düşmeden anında engellenir.",
        "icon": "fas fa-robot",
        "accent": "nx-badge--blue",
        "category": "mesaj",
        "supports_advanced": False,
        "extras": [
            "blockLinks",
            "blockInvites",
            "blockProfanity",
            "blockSpam",
            "blockMassMentions",
            "massMentionThreshold",
            "blockStaffMentions",
            "exemptRoleIds",
            "exemptChannelIds",
            "actionType",
            "timeoutMinutes",
            "alertChannelId"
        ]
    }
]

GUARD_CATEGORY_DEFS: list[dict[str, Any]] = [
    {
        "key": "yapi",
        "title": "Yapı Koruması",
        "description": "Kanal, kategori, webhook ve bot düzeyinde sunucu yapısını korur.",
        "icon": "fas fa-diagram-project",
    },
    {
        "key": "sunucu",
        "title": "Sunucu & Rol Koruması",
        "description": "Sunucu ayarları, roller ve izin yükseltmelerini denetler.",
        "icon": "fas fa-castle",
    },
    {
        "key": "davranis",
        "title": "Davranış Koruması",
        "description": "Toplu işlemler, manuel müdahaleler ve raid tespitleri.",
        "icon": "fas fa-chart-line",
    },
    {
        "key": "mesaj",
        "title": "Mesaj Koruması",
        "description": "Davet / link filtreleri ve mesaj silme patlamaları.",
        "icon": "fas fa-comments",
    },
]

GUARD_SEVERITY_OPTIONS: list[dict[str, str]] = [
    {"value": "inherit", "label": "Varsayılan (olaya göre)"},
    {"value": "info", "label": "Bilgi"},
    {"value": "warning", "label": "Uyarı"},
    {"value": "critical", "label": "Kritik"},
]

GUARD_ACTION_TIER_OPTIONS: list[dict[str, str]] = [
    {"value": "log", "label": "Sadece Logla"},
    {"value": "warn", "label": "DM Uyarı"},
    {"value": "timeout", "label": "Timeout (1 saat)"},
    {"value": "quarantine", "label": "Karantina"},
    {"value": "kick", "label": "Sunucudan At"},
    {"value": "ban", "label": "Yasakla"},
]

GUARD_ROLE_PERMISSION_OPTIONS: list[dict[str, str]] = [
    {"value": "Administrator", "label": "Administrator"},
    {"value": "ManageGuild", "label": "Sunucuyu Yönet"},
    {"value": "ManageRoles", "label": "Rolleri Yönet"},
    {"value": "ManageChannels", "label": "Kanalları Yönet"},
    {"value": "ManageWebhooks", "label": "Webhook Yönet"},
    {"value": "ManageGuildExpressions", "label": "Emoji/Stikerları Yönet"},
    {"value": "BanMembers", "label": "Yasakla"},
    {"value": "KickMembers", "label": "Sunucudan At"},
    {"value": "ModerateMembers", "label": "Üyeleri Yönet (timeout)"},
    {"value": "MentionEveryone", "label": "@everyone Bildirimi"},
]

POLICY_CAPABILITY_OPTIONS: list[dict[str, str]] = [
    {"value": "ban", "label": "Ban"},
    {"value": "unban", "label": "Ban Kaldır"},
    {"value": "kick", "label": "Kick"},
    {"value": "timeout", "label": "Timeout"},
    {"value": "untimeout", "label": "Timeout Kaldır"},
    {"value": "softban", "label": "Softban"},
    {"value": "warn", "label": "Warn"},
    {"value": "unwarn", "label": "Warn Kaldır"},
    {"value": "jail", "label": "Jail"},
    {"value": "unjail", "label": "Jail Kaldır"},
    {"value": "purge", "label": "Purge"},
    {"value": "lock", "label": "Kanal Kilitle"},
    {"value": "unlock", "label": "Kilit Kaldır"},
    {"value": "slowmode", "label": "Yavaş Mod"},
    {"value": "guard_quarantine", "label": "Guard: Karantina"},
    {"value": "guard_restore", "label": "Guard: Geri Yükle"},
    {"value": "guard_log", "label": "Guard: Log Kaydı"},
]

POLICY_ACTION_TYPE_OPTIONS: list[dict[str, str]] = [
    {"value": "ban", "label": "Ban"},
    {"value": "unban", "label": "Ban Kaldır"},
    {"value": "kick", "label": "Kick"},
    {"value": "timeout", "label": "Timeout"},
    {"value": "untimeout", "label": "Timeout Kaldır"},
    {"value": "softban", "label": "Softban"},
    {"value": "warn", "label": "Warn"},
    {"value": "unwarn", "label": "Warn Kaldır"},
    {"value": "jail", "label": "Jail"},
    {"value": "unjail", "label": "Jail Kaldır"},
    {"value": "purge", "label": "Purge"},
]

GUARD_ROLLBACK_FIELD_OPTIONS: list[dict[str, str]] = [
    {"value": "name", "label": "Sunucu Adı"},
    {"value": "iconUrl", "label": "Sunucu İkonu"},
    {"value": "bannerUrl", "label": "Sunucu Bannerı"},
    {"value": "verificationLevel", "label": "Doğrulama Seviyesi"},
    {"value": "explicitContentFilter", "label": "Explicit İçerik Filtresi"},
    {"value": "defaultMessageNotifications", "label": "Varsayılan Bildirim"},
    {"value": "systemChannelId", "label": "Sistem Kanalı"},
    {"value": "rulesChannelId", "label": "Kurallar Kanalı"},
    {"value": "publicUpdatesChannelId", "label": "Topluluk Güncelleme Kanalı"},
]

GUARD_ANTIRAID_ACTION_OPTIONS: list[dict[str, str]] = [
    {"value": "quarantine", "label": "Karantina"},
    {"value": "kick", "label": "Sunucudan At"},
    {"value": "ban", "label": "Yasakla"},
]

GUARD_INVITE_ACTION_OPTIONS: list[dict[str, str]] = [
    {"value": "delete", "label": "Mesajı Sil"},
    {"value": "timeout", "label": "Mesajı Sil + Timeout (10 dk)"},
    {"value": "quarantine", "label": "Mesajı Sil + Karantina"},
]


def build_ultra_protection_scene(
    config: dict[str, Any], backups: list[dict[str, Any]]
) -> dict[str, Any]:
    protection = config.get("ultraProtection") or {}

    features: list[dict[str, Any]] = []
    for definition in GUARD_FEATURE_DEFS:
        guard_cfg = protection.get(definition["key"]) or {}
        features.append(
            {
                **definition,
                "enabled": bool(guard_cfg.get("enabled")),
                "config": guard_cfg,
            }
        )

    categories: list[dict[str, Any]] = []
    for cat_def in GUARD_CATEGORY_DEFS:
        items = [feat for feat in features if feat.get("category") == cat_def["key"]]
        if not items:
            continue
        categories.append(
            {
                **cat_def,
                "features": items,
                "active_count": sum(1 for feat in items if feat["enabled"]),
            }
        )

    active_feature_count = sum(1 for item in features if item["enabled"])

    backup_rows = []
    for backup in backups:
        summary = backup.get("summary") or {}
        backup_rows.append(
            {
                **backup,
                "type_label": "Otomatik Açılış" if backup.get("backup_type") == "auto-boot" else "Manuel",
                "created_at_label": format_timestamp(backup.get("created_at")),
                "created_at_relative": relative_timestamp(backup.get("created_at")),
                "role_count": safe_int(summary.get("roleCount")),
                "channel_count": safe_int(summary.get("channelCount")),
            }
        )

    return {
        "enabled": bool(protection.get("enabled")),
        "features": features,
        "categories": categories,
        "severity_options": GUARD_SEVERITY_OPTIONS,
        "action_tier_options": GUARD_ACTION_TIER_OPTIONS,
        "role_permission_options": GUARD_ROLE_PERMISSION_OPTIONS,
        "rollback_field_options": GUARD_ROLLBACK_FIELD_OPTIONS,
        "antiraid_action_options": GUARD_ANTIRAID_ACTION_OPTIONS,
        "invite_action_options": GUARD_INVITE_ACTION_OPTIONS,
        "summary_cards": [
            {"label": "Aktif Guard", "value": str(active_feature_count)},
            {
                "label": "Whitelist Üye",
                "value": str(len((protection.get("whitelist") or {}).get("userIds", []))),
            },
            {
                "label": "Blacklist Üye",
                "value": str(len((protection.get("blacklist") or {}).get("userIds", []))),
            },
            {"label": "Yedek Sayısı", "value": str(len(backup_rows))},
        ],
        "backups": backup_rows,
    }


def guard_log_source_meta(source: str) -> dict[str, str]:
    mapping = {
        "guard": {
            "label": "Guard Olayı",
            "icon": "fas fa-shield-halved",
            "badge_class": "nx-badge--red",
        },
        "role": {
            "label": "Rol Geçmişi",
            "icon": "fas fa-user-tag",
            "badge_class": "nx-badge--orange",
        },
        "moderation": {
            "label": "Moderasyon",
            "icon": "fas fa-gavel",
            "badge_class": "nx-badge--blue",
        },
        "backup": {
            "label": "Yedek",
            "icon": "fas fa-box-archive",
            "badge_class": "nx-badge--teal",
        },
    }
    return mapping.get(source, mapping["guard"])


def guard_log_feature_label(feature_key: str) -> str:
    labels = {
        "channel-guard": "Kanal Guard",
        "category-guard": "Kategori Guard",
        "webhook-guard": "Webhook Guard",
        "bot-guard": "Bot Guard",
        "guild-settings-guard": "Sunucu Ayar Guard",
        "bulk-action-guard": "Toplu İşlem Guard",
        "manual-action-guard": "Manuel İşlem Guard",
        "role-history": "Rol Geçmişi",
        "moderation": "Bot Moderasyonu",
        "server-backup": "Sunucu Yedeği",
    }
    return labels.get(feature_key, feature_key.replace("-", " ").title())


def guard_log_event_label(source: str, event_type: str) -> str:
    if source == "role":
        mapping = {
            "create": "Rol Oluşturuldu",
            "update": "Rol Güncellendi",
            "delete": "Rol Silindi",
            "assign": "Rol Verildi",
            "unassign": "Rol Alındı",
        }
        return mapping.get(event_type, event_type.title())

    if source == "moderation":
        mapping = {
            "ban": "Ban",
            "kick": "Kick",
            "timeout": "Timeout",
        }
        return mapping.get(event_type, event_type.title())

    if source == "backup":
        mapping = {
            "manual": "Manuel Yedek",
            "auto-boot": "Açılış Yedeği",
        }
        return mapping.get(event_type, event_type.title())

    mapping = {
        "create": "Oluşturma",
        "update": "Güncelleme",
        "delete": "Silme",
        "bot-add": "Bot Ekleme",
        "ban": "Manuel Ban",
        "kick": "Manuel Kick",
        "timeout": "Manuel Timeout",
        "burst": "Toplu İşlem Patlaması",
    }
    return mapping.get(event_type, event_type.title())


def guard_log_action_label(action_taken: str) -> str:
    mapping = {
        "kanal-silindi": "Kanal geri alındı",
        "kanal-silinmedi": "Kanal geri alınamadı",
        "webhook-silindi": "Webhook silindi",
        "webhook-silinmedi": "Webhook silinemedi",
        "webhook-bulunamadi": "Webhook bulunamadı",
        "bot-korundu": "Bot korundu",
        "bot-atildi": "Bot atıldı",
        "bot-atilamadi": "Bot atılamadı",
        "karantinaya-alindi": "Karantinaya alındı",
        "karantina-zaten-aktif": "Karantina zaten aktif",
        "karantina-rolu-yok": "Karantina rolü tanımlı değil",
        "karantina-rolu-bulunamadi": "Karantina rolü bulunamadı",
        "uye-bulunamadi": "Üye bulunamadı",
        "uye-yonetilemiyor": "Üye yönetilemiyor",
        "karantina-basarisiz": "Karantina başarısız",
        "kurucu-muaf": "Kurucu muaf",
        "uyari": "Uyarı olarak kaydedildi",
        "whitelist-muaf": "Whitelist nedeniyle pas geçildi",
        "sadece-log": "Sadece kayıt alındı",
        "pasif-mod-logu": "Pasif modda yalnızca kaydedildi",
        "karantina-atlandi": "Karantina uygulanmadı",
        "ek-aksiyon-yok": "Ek aksiyon uygulanmadı",
        "Rol Kaydı": "Rol kaydı oluşturuldu",
        "Moderasyon Kaydı": "Moderasyon kaydı oluşturuldu",
        "Bot Moderasyonu": "Bot moderasyonu işlendi",
        "Yedek Oluşturuldu": "Yedek oluşturuldu",
    }
    parts = [part.strip() for part in str(action_taken or "").split("+") if part.strip()]
    if not parts:
        return "Kaydedildi"
    return " + ".join(mapping.get(part, part.replace("-", " ").title()) for part in parts)


def guard_log_severity_meta(severity: str) -> dict[str, str]:
    mapping = {
        "info": {"label": "Bilgi", "badge_class": "nx-badge--teal"},
        "warning": {"label": "Uyarı", "badge_class": "nx-badge--orange"},
        "critical": {"label": "Kritik", "badge_class": "nx-badge--red"},
    }
    return mapping.get(severity, mapping["warning"])


def guard_log_field_label(name: str) -> str:
    labels = {
        "id": "Kimlik",
        "name": "Ad",
        "type": "Tür",
        "rawType": "Ham Tür",
        "parentId": "Kategori Kimliği",
        "parentName": "Kategori",
        "position": "Konum",
        "topic": "Konu",
        "nsfw": "NSFW",
        "rateLimitPerUser": "Yavaş Mod",
        "bitrate": "Bit Hızı",
        "userLimit": "Kullanıcı Sınırı",
        "rtcRegion": "RTC Bölgesi",
        "videoQualityMode": "Video Kalitesi",
        "permissionsLocked": "İzin Kilidi",
        "permissionOverwrites": "İzin Üzerine Yazmaları",
        "iconUrl": "İkon",
        "bannerUrl": "Banner",
        "verificationLevel": "Doğrulama Seviyesi",
        "defaultMessageNotifications": "Varsayılan Bildirim",
        "explicitContentFilter": "İçerik Filtresi",
        "afkChannelId": "AFK Kanalı",
        "systemChannelId": "Sistem Kanalı",
        "rulesChannelId": "Kurallar Kanalı",
        "publicUpdatesChannelId": "Duyuru Kanalı",
        "username": "Kullanıcı Adı",
        "displayName": "Görünen Ad",
        "avatarUrl": "Avatar",
        "createdAt": "Oluşturulma",
        "joinedAt": "Katılım",
        "roleIds": "Roller",
        "applicationId": "Uygulama Kimliği",
        "ownerId": "Sahip Kimliği",
        "channelId": "Kanal Kimliği",
        "permissions": "İzinler",
        "colorHex": "Renk",
        "mentionable": "Etiketlenebilir",
        "managed": "Yönetilen",
        "hoist": "Ayrı Görünüm",
    }
    translated = labels.get(name)
    if translated:
        return translated
    return re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name).replace("_", " ").strip().title()


def guard_log_value_text(value: Any) -> str:
    if isinstance(value, bool):
        return "Açık" if value else "Kapalı"
    if isinstance(value, datetime):
        return format_timestamp(value)
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        if not value:
            return "-"
        if all(isinstance(item, (str, int, float, bool)) for item in value):
            items = [guard_log_value_text(item) for item in value[:5]]
            if len(value) > 5:
                items.append(f"+{len(value) - 5} kayıt")
            return ", ".join(items)
        return f"{len(value)} kayıt"
    if isinstance(value, dict):
        return f"{len(value)} alan"
    if value in {None, ""}:
        return "-"
    return str(value)


def guard_log_snapshot_rows(snapshot: Any) -> list[dict[str, str]]:
    if not isinstance(snapshot, dict):
        return []

    rows: list[dict[str, str]] = []
    for key, value in snapshot.items():
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        if isinstance(value, (list, dict)) and not value:
            continue
        rows.append(
            {
                "label": guard_log_field_label(str(key)),
                "value": guard_log_value_text(value),
            }
        )
    return rows


def guard_log_changes(payload: dict[str, Any]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for change in json_array(payload.get("changes")):
        if not isinstance(change, dict):
            continue
        label = (
            str(change.get("label") or "")
            or guard_log_field_label(str(change.get("field") or "Değişiklik"))
        )
        items.append(
            {
                "label": label,
                "old_value": guard_log_value_text(change.get("oldValue")),
                "new_value": guard_log_value_text(change.get("newValue")),
            }
        )
    return items


def guard_log_snapshot_sections(source: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    candidates = [
        ("beforeSnapshot", "Önceki Durum"),
        ("afterSnapshot", "Yeni Durum"),
        ("snapshot", "Kayıt Snapshotı"),
        ("targetSnapshot", "Hedef Snapshotı"),
        ("roleSnapshot", "Rol Snapshotı"),
        ("targetMember", "Hedef Üye"),
    ]
    for key, title in candidates:
        rows = guard_log_snapshot_rows(payload.get(key))
        if rows:
            sections.append({"title": title, "rows": rows})

    if source == "backup":
        backup_payload = json_object(payload.get("payload"))
        summary_rows = guard_log_snapshot_rows(
            {
                "capturedAt": backup_payload.get("capturedAt"),
                "roles": len(json_array(backup_payload.get("roles"))),
                "channels": len(json_array(backup_payload.get("channels"))),
            }
        )
        if summary_rows:
            sections.append({"title": "Yedek Özeti", "rows": summary_rows})

    return sections


def build_guard_log_summary(item: dict[str, Any]) -> str:
    source = str(item.get("source") or "guard")
    target_name = str(item.get("target_name") or item.get("target_id") or "hedef")
    actor_name = str(item.get("actor_name") or item.get("actor_id") or "bilinmeyen kişi")
    event_label = guard_log_event_label(source, str(item.get("event_type") or "event")).lower()
    feature_label = guard_log_feature_label(str(item.get("feature_key") or "guard"))
    payload = item.get("payload") or {}

    if source == "backup":
        summary = json_object(payload.get("summary"))
        role_count = safe_int(summary.get("roleCount"))
        channel_count = safe_int(summary.get("channelCount"))
        return f"{role_count} rol ve {channel_count} kanal içeren bir sunucu yedeği oluşturuldu."

    if source == "role":
        target_member = json_object(payload.get("targetMember"))
        if target_member:
            member_name = (
                target_member.get("displayName")
                or target_member.get("username")
                or target_member.get("id")
                or "üye"
            )
            return f"{target_name} rolü {member_name} üzerinde {event_label} olarak kaydedildi."
        return f"{target_name} için rol geçmişinde {event_label} kaydı oluşturuldu."

    if source == "moderation":
        return f"{actor_name}, {target_name} üzerinde {event_label} işlemi uyguladı."

    return f"{feature_label}, {target_name} üzerinde {event_label} hareketini algıladı."


def build_guard_log_scene(
    events: list[dict[str, Any]],
    actor_options: list[dict[str, Any]],
    source: str,
    severity: str,
    feature: str,
    actor_id: int | None,
    query: str | None,
    limit: int,
) -> dict[str, Any]:
    event_cards: list[dict[str, Any]] = []
    critical_count = 0
    deletion_count = 0
    snapshot_count = 0

    for index, item in enumerate(events):
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
        payload = payload if isinstance(payload, dict) else {}
        severity_meta = guard_log_severity_meta(str(item.get("severity") or "warning"))
        source_meta = guard_log_source_meta(str(item.get("source") or "guard"))
        action_label = guard_log_action_label(str(item.get("action_taken") or ""))
        if severity_meta["label"] == "Kritik":
            critical_count += 1
        if str(item.get("event_type") or "") in {"delete", "ban", "kick", "unassign"}:
            deletion_count += 1

        snapshot_sections = guard_log_snapshot_sections(str(item.get("source") or ""), payload)
        if snapshot_sections:
            snapshot_count += 1

        detail_facts = [
            {"label": "Kaynak", "value": source_meta["label"]},
            {"label": "Modül", "value": guard_log_feature_label(str(item.get("feature_key") or ""))},
            {"label": "Olay", "value": guard_log_event_label(str(item.get("source") or ""), str(item.get("event_type") or ""))},
            {"label": "Aktör", "value": str(item.get("actor_name") or item.get("actor_id") or "Bilinmeyen")},
            {"label": "Hedef", "value": str(item.get("target_name") or item.get("target_id") or "—")},
            {"label": "Sonuç", "value": action_label},
        ]

        reason_text = str(item.get("reason") or "").strip()
        if reason_text:
            detail_facts.append({"label": "Sebep", "value": reason_text})

        guard_context = json_object(payload.get("guardContext"))
        if guard_context:
            if guard_context.get("isExempt"):
                detail_facts.append({"label": "Muafiyet", "value": "Whitelist muafı"})
            elif guard_context.get("isBlacklisted"):
                detail_facts.append({"label": "Muafiyet", "value": "Blacklist baskın"})
            if not guard_context.get("automationActive", True):
                detail_facts.append({"label": "Guard Modu", "value": "Sadece kayıt"})

        event_cards.append(
            {
                **item,
                "title": guard_log_event_label(str(item.get("source") or ""), str(item.get("event_type") or "")),
                "summary": build_guard_log_summary(item),
                "source_label": source_meta["label"],
                "source_icon": source_meta["icon"],
                "source_badge_class": source_meta["badge_class"],
                "feature_label": guard_log_feature_label(str(item.get("feature_key") or "")),
                "severity_label": severity_meta["label"],
                "severity_badge_class": severity_meta["badge_class"],
                "created_at_label": format_timestamp(item.get("created_at")),
                "created_at_relative": relative_timestamp(item.get("created_at")),
                "details": detail_facts,
                "action_label": action_label,
                "changes": guard_log_changes(payload),
                "snapshot_sections": snapshot_sections,
                "audit_changes": guard_log_changes({"changes": payload.get("auditChanges")}),
                "open_by_default": index < 4 or severity_meta["label"] == "Kritik",
            }
        )

    return {
        "events": event_cards,
        "has_data": bool(event_cards),
        "summary_cards": [
            {"label": "Yüklenen Kayıt", "value": str(len(event_cards))},
            {"label": "Kritik Olay", "value": str(critical_count)},
            {"label": "Silme / Ceza Kaydı", "value": str(deletion_count)},
            {"label": "Snapshot İçeren", "value": str(snapshot_count)},
        ],
        "filters": {
            "source": source,
            "severity": severity,
            "feature": feature,
            "actor_id": str(actor_id) if actor_id is not None else "",
            "query": query or "",
            "limit": str(limit),
            "source_options": [
                {"value": "all", "label": "Tüm Kaynaklar"},
                {"value": "guard", "label": "Guard Olayları"},
                {"value": "role", "label": "Rol Geçmişi"},
                {"value": "moderation", "label": "Moderasyon"},
                {"value": "backup", "label": "Yedekler"},
            ],
            "severity_options": [
                {"value": "all", "label": "Tüm Seviyeler"},
                {"value": "critical", "label": "Kritik"},
                {"value": "warning", "label": "Uyarı"},
                {"value": "info", "label": "Bilgi"},
            ],
            "feature_options": [
                {"value": "all", "label": "Tüm Modüller"},
                {"value": "channel-guard", "label": "Kanal Guard"},
                {"value": "category-guard", "label": "Kategori Guard"},
                {"value": "webhook-guard", "label": "Webhook Guard"},
                {"value": "bot-guard", "label": "Bot Guard"},
                {"value": "guild-settings-guard", "label": "Sunucu Ayar Guard"},
                {"value": "bulk-action-guard", "label": "Toplu İşlem Guard"},
                {"value": "manual-action-guard", "label": "Manuel İşlem Guard"},
                {"value": "role-history", "label": "Rol Geçmişi"},
                {"value": "moderation", "label": "Bot Moderasyonu"},
                {"value": "server-backup", "label": "Sunucu Yedeği"},
            ],
            "limit_options": [
                {"value": "40", "label": "40 kayıt"},
                {"value": "80", "label": "80 kayıt"},
                {"value": "120", "label": "120 kayıt"},
            ],
            "actor_options": [
                {
                    "value": str(item.get("user_id")),
                    "label": item.get("display_name") or item.get("username") or item.get("user_id"),
                }
                for item in actor_options
            ],
        },
    }


def build_staff_comparison_scene(
    staff_rows: list[dict[str, Any]],
    left_user_id: int | None,
    right_user_id: int | None,
    period: str,
) -> dict[str, Any]:
    ranked_rows = build_member_scene(staff_rows, "staff").get("roster", [])
    if not ranked_rows:
        return {
            "has_data": False,
            "options": [],
            "period": period,
        }

    options = [
        {
            "user_id": str(item["user_id"]),
            "label": f"{item['display_name']} (Skor {item['impact_score']})",
        }
        for item in ranked_rows
    ]
    row_by_id = {safe_int(item["user_id"]): item for item in ranked_rows}
    selected_left = row_by_id.get(left_user_id or -1) or ranked_rows[0]
    selected_right = row_by_id.get(right_user_id or -1)
    if not selected_right or safe_int(selected_right["user_id"]) == safe_int(selected_left["user_id"]):
        selected_right = next(
            (item for item in ranked_rows if item["user_id"] != selected_left["user_id"]),
            selected_left,
        )

    def metric(
        label: str,
        left_raw: float,
        right_raw: float,
        left_display: str,
        right_display: str,
        note: str,
    ) -> dict[str, Any]:
        max_value = max(left_raw, right_raw, 1)
        if left_raw > right_raw:
            winner = "left"
        elif right_raw > left_raw:
            winner = "right"
        else:
            winner = "tie"
        return {
            "label": label,
            "note": note,
            "left_raw": left_raw,
            "right_raw": right_raw,
            "left_display": left_display,
            "right_display": right_display,
            "left_percent": round((left_raw / max_value) * 100),
            "right_percent": round((right_raw / max_value) * 100),
            "winner": winner,
        }

    metrics = [
        metric(
            "Etki Skoru",
            float(selected_left["impact_score"]),
            float(selected_right["impact_score"]),
            str(selected_left["impact_score"]),
            str(selected_right["impact_score"]),
            "Ses, mesaj, ticket ve yetki toplam etkisi.",
        ),
        metric(
            "Aktif Ses",
            float(selected_left["voice_seconds"]),
            float(selected_right["voice_seconds"]),
            f"{selected_left['voice_hours']} sa",
            f"{selected_right['voice_hours']} sa",
            "Gerçek aktif ses süresi.",
        ),
        metric(
            "Kamera",
            float(selected_left["camera_seconds"]),
            float(selected_right["camera_seconds"]),
            f"{selected_left['camera_hours']} sa",
            f"{selected_right['camera_hours']} sa",
            "Kamera kullanım süresi.",
        ),
        metric(
            "Yayın",
            float(selected_left["stream_seconds"]),
            float(selected_right["stream_seconds"]),
            f"{selected_left['stream_hours']} sa",
            f"{selected_right['stream_hours']} sa",
            "Yayın / ekran paylaşımı izi.",
        ),
        metric(
            "Mesaj",
            float(selected_left["period_message_count"]),
            float(selected_right["period_message_count"]),
            str(selected_left["period_message_count"]),
            str(selected_right["period_message_count"]),
            "Periyot içindeki sunucu mesaj hacmi.",
        ),
        metric(
            "Claim",
            float(selected_left["ticket_focus_count"]),
            float(selected_right["ticket_focus_count"]),
            str(selected_left["ticket_focus_count"]),
            str(selected_right["ticket_focus_count"]),
            "Üstlenilen ticket sayısı.",
        ),
        metric(
            "Yetki",
            float(selected_left["action_total"]),
            float(selected_right["action_total"]),
            str(selected_left["action_total"]),
            str(selected_right["action_total"]),
            "Ban, kick ve timeout toplamı.",
        ),
    ]

    for item in metrics:
        if item["winner"] == "left":
            item["winner_label"] = f"{selected_left['display_name']} onde"
            item["winner_tone"] = "nx-badge--orange"
        elif item["winner"] == "right":
            item["winner_label"] = f"{selected_right['display_name']} onde"
            item["winner_tone"] = "nx-badge--teal"
        else:
            item["winner_label"] = "Denge"
            item["winner_tone"] = "nx-badge--blue"

    left_wins = sum(1 for item in metrics if item["winner"] == "left")
    right_wins = sum(1 for item in metrics if item["winner"] == "right")
    tied = sum(1 for item in metrics if item["winner"] == "tie")

    return {
        "has_data": True,
        "period": period,
        "options": options,
        "left": selected_left,
        "right": selected_right,
        "selected_left_user_id": str(selected_left["user_id"]),
        "selected_right_user_id": str(selected_right["user_id"]),
        "metrics": metrics,
        "summary_cards": [
            {
                "label": f"{selected_left['display_name']} üstün",
                "value": str(left_wins),
            },
            {
                "label": f"{selected_right['display_name']} üstün",
                "value": str(right_wins),
            },
            {
                "label": "Eşit metrik",
                "value": str(tied),
            },
        ],
    }


def assemble_investigation_package(user_id: int, period: str) -> dict[str, Any] | None:
    member = get_member_directory_entry(user_id)
    if not member:
        return None

    member_type = str(member.get("member_type") or "user")
    detail_payload = get_member_detail(user_id, member_type, period)
    return {
        "member": member,
        "member_type": member_type,
        "detail_payload": detail_payload,
        "message_events": (
            list_staff_message_events(period, author_id=user_id, limit=12)
            if member_type == "staff"
            else []
        ),
        "role_events": list_role_change_events_for_member(user_id, limit=12),
        "moderation_activity": list_recent_moderation_activity_for_member(
            user_id, member_type, period, limit=12
        ),
        "period": period,
    }


def build_investigation_package_scene(
    package: dict[str, Any] | None,
    member_options: list[dict[str, Any]],
    selected_user_id: int | None,
    period: str,
) -> dict[str, Any]:
    if not package:
        return {
            "has_data": False,
            "member_options": member_options,
            "selected_user_id": str(selected_user_id) if selected_user_id else "",
            "period": period,
        }

    detail = package.get("detail_payload", {}).get("detail") or {}
    member = package.get("member") or {}
    member_type = str(package.get("member_type") or "user")
    voice_seconds = safe_int(detail.get("voice_active_seconds"))
    camera_seconds = safe_int(detail.get("camera_seconds"))
    stream_seconds = safe_int(detail.get("stream_seconds"))
    message_count = safe_int(detail.get("server_message_count"))
    lifetime_messages = safe_int(detail.get("total_message_count"))
    ticket_count = safe_int(
        detail.get("ticket_claim_count" if member_type == "staff" else "ticket_opened_count")
    )
    moderation_total = (
        safe_int(detail.get("moderation_ban_count"))
        + safe_int(detail.get("moderation_kick_count"))
        + safe_int(detail.get("moderation_timeout_count"))
    )

    return {
        "has_data": True,
        "member_options": member_options,
        "selected_user_id": str(selected_user_id) if selected_user_id else "",
        "period": period,
        "member": member,
        "member_type_label": member_type_label(member_type),
        "summary_cards": [
            {"label": "Aktif Ses", "value": f"{hours_value(voice_seconds)} sa"},
            {"label": "Kamera", "value": f"{hours_value(camera_seconds)} sa"},
            {"label": "Yayın", "value": f"{hours_value(stream_seconds)} sa"},
            {"label": "Periyot Mesajı", "value": str(message_count)},
            {"label": "Toplam Mesaj", "value": str(lifetime_messages)},
            {
                "label": "Claim" if member_type == "staff" else "Açılan Ticket",
                "value": str(ticket_count),
            },
            {"label": "Yetki", "value": str(moderation_total)},
        ],
        "top_channels": [
            {
                **channel,
                "total_hours": hours_value(channel.get("total_seconds")),
            }
            for channel in (package.get("detail_payload", {}).get("channels") or [])[:5]
        ],
        "tickets": [
            {
                **ticket,
                "created_at_label": format_timestamp(ticket.get("created_at")),
            }
            for ticket in (package.get("detail_payload", {}).get("tickets") or [])
        ],
        "message_events": build_message_event_items(package.get("message_events") or []),
        "role_history": build_role_history_scene(package.get("role_events") or []),
        "moderation_activity": [
            {
                **item,
                "action_label": moderation_action_label(str(item.get("action_type") or "")),
                "created_at_label": format_timestamp(item.get("created_at")),
                "created_at_relative": relative_timestamp(item.get("created_at")),
            }
            for item in (package.get("moderation_activity") or [])
        ],
        "export_path": f"/packages/export?user_id={selected_user_id}&period={period}",
    }


def build_ticket_scene(data: dict[str, Any]) -> dict[str, Any]:
    summary = data.get("summary", {})
    total_tickets = safe_int(summary.get("total_tickets"))
    open_tickets = safe_int(summary.get("open_tickets"))
    claimed_tickets = safe_int(summary.get("claimed_tickets"))
    avg_first_response_seconds = safe_int(summary.get("avg_first_response_seconds"))
    avg_archive_seconds = safe_int(summary.get("avg_archive_seconds"))

    category_palette = ["#ff9d3f", "#59d0c2", "#7ad1ff", "#ff5d6c", "#ffd36a", "#8df0b7"]
    categories: list[dict[str, Any]] = []
    for index, item in enumerate(data.get("categories", [])):
        total = safe_int(item.get("total"))
        categories.append(
            {
                "label": item.get("category_key") or "Belirsiz",
                "total": total,
                "percentage": percentage(total, total_tickets),
                "tone": category_palette[index % len(category_palette)],
            }
        )

    def prepare_ticket_people(
        rows: list[dict[str, Any]],
        count_key: str,
        accent: str,
    ) -> list[dict[str, Any]]:
        peak_count = max((safe_int(item.get(count_key)) for item in rows), default=0)
        prepared: list[dict[str, Any]] = []
        for index, item in enumerate(rows):
            row = build_identity(item, index)
            row["count"] = safe_int(item.get(count_key))
            row["count_key"] = count_key
            row["accent"] = accent
            row["percentage"] = percentage(row["count"], peak_count)
            prepared.append(row)
        return prepared

    claimers = prepare_ticket_people(data.get("claimers", []), "ticket_claim_count", "#59d0c2")
    writers = prepare_ticket_people(data.get("writers", []), "message_count", "#ff9d3f")

    top_category = categories[0] if categories else None
    top_claimer = claimers[0] if claimers else None
    top_writer = writers[0] if writers else None
    coverage = percentage(claimed_tickets, total_tickets)

    return {
        "copy": {
            "eyebrow": "Ticket Ä°statistikleri",
            "title": "Ticket yoÄŸunluÄŸunu ve yetkilileri anÄ±nda incele",
            "description": (
                "AÃ§Ä±k ticketlar, Ã¼stlenen yetkililer, ilk yanÄ±t sÃ¼releri ve kategoriler."
            ),
            "hero_note": (
                f"En Ã§ok aÃ§Ä±lan kategori: {top_category['label']} - {top_category['total']} ticket"
                if top_category
                else "Bu periyotta ticket verisi yok."
            ),
        },
        "summary": {
            "total_tickets": total_tickets,
            "open_tickets": open_tickets,
            "claimed_tickets": claimed_tickets,
            "coverage": coverage,
            "avg_first_response_hours": hours_value(avg_first_response_seconds),
            "avg_archive_hours": hours_value(avg_archive_seconds),
        },
        "summary_cards": [
            {
                "label": "Toplam ticket",
                "value": str(total_tickets),
                "note": "Secilen periyotta acilan kayitlar.",
            },
            {
                "label": "Acik hat",
                "value": str(open_tickets),
                "note": "Hala kapanmamis ticket yogunlugu.",
            },
            {
                "label": "Ilk yanit",
                "value": f"{hours_value(avg_first_response_seconds)} dk",
                "note": "Kullaniciya ilk temas ortalamasi.",
            },
            {
                "label": "Arsiv hizi",
                "value": f"{hours_value(avg_archive_seconds)} dk",
                "note": "Ticketin kapanis / arsiv ortalamasi.",
            },
        ],
        "category_lanes": categories,
        "claimers": claimers,
        "writers": writers,
        "spotlights": [
            build_spotlight(
                "Claim kaptani",
                top_claimer,
                str(top_claimer["count"]) if top_claimer else "0",
                "En cok ticket ustlenen yetkili.",
                "#59d0c2",
            ),
            build_spotlight(
                "Mesaj basinci",
                top_writer,
                str(top_writer["count"]) if top_writer else "0",
                "Ticket metnini en cok tasiyan isim.",
                "#ff9d3f",
            ),
            build_spotlight(
                "Claim kapsami",
                {"display_name": "Sistem"},
                f"%{coverage}",
                "Claim atanmis ticket orani.",
                "#7ad1ff",
            ),
            build_spotlight(
                "Arsiv ritmi",
                {"display_name": "Sistem"},
                f"{hours_value(avg_archive_seconds)} dk",
                "Ticket kapanis hizi.",
                "#ff5d6c",
            ),
        ],
    }


def build_action_scene(data: dict[str, Any]) -> dict[str, Any]:
    summary = data.get("summary", {})
    total_actions = safe_int(summary.get("total_actions"))
    bans = safe_int(summary.get("bans"))
    kicks = safe_int(summary.get("kicks"))
    timeouts = safe_int(summary.get("timeouts"))

    mix = [
        {
            "label": "Ban",
            "count": bans,
            "percentage": percentage(bans, total_actions),
            "tone": "#ff5d6c",
            "note": "Kalici agir mudahale",
        },
        {
            "label": "Kick",
            "count": kicks,
            "percentage": percentage(kicks, total_actions),
            "tone": "#ff9d3f",
            "note": "Anlik uzaklastirma aksiyonu",
        },
        {
            "label": "Timeout",
            "count": timeouts,
            "percentage": percentage(timeouts, total_actions),
            "tone": "#59d0c2",
            "note": "Gecici kisitlama yogunlugu",
        },
    ]

    leader_rows = data.get("leaders", [])
    peak_action_total = max(
        (
            safe_int(item.get("bans")) + safe_int(item.get("kicks")) + safe_int(item.get("timeouts"))
            for item in leader_rows
        ),
        default=0,
    )
    leaders: list[dict[str, Any]] = []
    for index, item in enumerate(leader_rows):
        row = build_identity(item, index)
        row["bans"] = safe_int(item.get("bans"))
        row["kicks"] = safe_int(item.get("kicks"))
        row["timeouts"] = safe_int(item.get("timeouts"))
        row["total_actions"] = row["bans"] + row["kicks"] + row["timeouts"]
        row["percentage"] = percentage(row["total_actions"], peak_action_total)
        leaders.append(row)

    timeline_rows = data.get("timeline", [])[-12:]
    peak_timeline_total = max((safe_int(item.get("total")) for item in timeline_rows), default=0)
    timeline: list[dict[str, Any]] = []
    for item in timeline_rows:
        total = safe_int(item.get("total"))
        bans_count = safe_int(item.get("bans"))
        kicks_count = safe_int(item.get("kicks"))
        timeouts_count = safe_int(item.get("timeouts"))
        bucket = str(item.get("bucket") or "")
        label = bucket[5:16] if len(bucket) >= 16 else bucket
        timeline.append(
            {
                "label": label,
                "full_label": bucket,
                "total": total,
                "height_percentage": max(14, percentage(total, peak_timeline_total)) if total else 0,
                "ban_percentage": percentage(bans_count, total),
                "kick_percentage": percentage(kicks_count, total),
                "timeout_percentage": percentage(timeouts_count, total),
            }
        )

    hot_windows = sorted(timeline, key=lambda item: item["total"], reverse=True)[:4]
    top_leader = leaders[0] if leaders else None
    dominant_mix = max(mix, key=lambda item: item["count"], default=None)

    return {
        "copy": {
            "eyebrow": "Moderasyon GeÃ§miÅŸi",
            "title": "Moderasyon iÅŸlemlerini, sÃ¼releri ve oranlarÄ± tek ekranda gÃ¶r",
            "description": (
                "Ban, kick ve timeout oranlarÄ± saatlere gÃ¶re gÃ¶sterilir. "
                "Hangi gÃ¼n ve saatte hangi iÅŸlemlerin arttÄ±ÄŸÄ±nÄ± takip edebilirsin."
            ),
            "hero_note": (
                f"En Ã§ok iÅŸlem yapan: {top_leader['display_name']} - {top_leader['total_actions']} iÅŸlem"
                if top_leader
                else "Bu periyotta moderasyon iÅŸlemi yok."
            ),
        },
        "summary": {
            "total_actions": total_actions,
            "bans": bans,
            "kicks": kicks,
            "timeouts": timeouts,
            "dominant_label": dominant_mix["label"] if dominant_mix else "Veri yok",
        },
        "summary_cards": [
            {
                "label": "Ban",
                "value": str(bans),
                "note": "Kalici eylem adedi.",
            },
            {
                "label": "Kick",
                "value": str(kicks),
                "note": "Anlik cikarma akisi.",
            },
            {
                "label": "Timeout",
                "value": str(timeouts),
                "note": "Susturma / kisitlama hacmi.",
            },
            {
                "label": "Dominant tip",
                "value": dominant_mix["label"] if dominant_mix else "-",
                "note": "Periyotta en baskin aksiyon ailesi.",
            },
        ],
        "mix": mix,
        "leaders": leaders,
        "timeline": timeline,
        "hot_windows": hot_windows,
    }


templates.env.filters["hours_value"] = hours_value
templates.env.filters["hours_label"] = hours_label
templates.env.filters["hours_list"] = hours_list


def normalize_picker_ids(raw_values: list[str] | None) -> list[str]:
    return [value.strip() for value in (raw_values or []) if value and value.strip()]


def checkbox_enabled(value: str | None) -> bool:
    return value == "on"


def pick_single_id(raw_values: list[str] | None) -> str | None:
    values = normalize_picker_ids(raw_values)
    return values[0] if values else None


def build_role_picker_options(role_options: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "item_id": role["role_id"],
            "item_name": role["role_name"],
            "item_subtitle": role["role_id"],
            "item_color": role["color_hex"] or "rgba(255, 157, 63, 0.72)",
            "item_search": f"{role['role_name']} {role['role_id']}".lower(),
        }
        for role in role_options
    ]


def build_channel_picker_options(channel_options: list[dict[str, Any]]) -> list[dict[str, Any]]:
    kind_labels = {
        "category": "Kategori",
        "text": "Yazi",
        "announcement": "Duyuru",
        "voice": "Ses",
        "stage": "Stage",
        "forum": "Forum",
        "media": "Medya",
        "other": "Diger",
    }
    kind_colors = {
        "category": "#ff9d3f",
        "text": "#59d0c2",
        "announcement": "#ffc76d",
        "voice": "#55d07b",
        "stage": "#c37bff",
        "forum": "#7ac9ff",
        "media": "#ff5d6c",
        "other": "rgba(255, 255, 255, 0.45)",
    }

    return [
        {
            "item_id": channel["channel_id"],
            "item_name": channel["channel_name"],
            "item_subtitle": f"{kind_labels.get(channel['channel_kind'], 'Kanal')} - {channel['channel_id']}",
            "item_color": kind_colors.get(channel["channel_kind"], kind_colors["other"]),
            "item_search": (
                f"{channel['channel_name']} {channel['channel_id']} "
                f"{kind_labels.get(channel['channel_kind'], 'kanal')}"
            ).lower(),
            "channel_kind": channel["channel_kind"],
        }
        for channel in channel_options
    ]


def build_member_picker_options(member_options: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "item_id": member["user_id"],
            "item_name": member["display_name"],
            "item_subtitle": f"{member.get('username') or member['user_id']} - {member_type_label(str(member.get('member_type') or 'user'))}",
            "item_color": "#7ad1ff" if member.get("member_type") == "staff" else "#59d0c2",
            "item_search": (
                f"{member['display_name']} {member.get('username') or ''} {member['user_id']}"
            ).lower(),
        }
        for member in member_options
    ]


def resolve_picker_items(
    selected_ids: list[str], options: list[dict[str, Any]], fallback_prefix: str
) -> list[dict[str, Any]]:
    option_lookup = {option["item_id"]: option for option in options}
    resolved_items: list[dict[str, Any]] = []
    for item_id in selected_ids:
        resolved_items.append(
            option_lookup.get(
                item_id,
                {
                    "item_id": item_id,
                    "item_name": f"{fallback_prefix} #{item_id}",
                    "item_subtitle": item_id,
                    "item_color": "rgba(255, 255, 255, 0.45)",
                    "item_search": item_id.lower(),
                },
            )
        )
    return resolved_items


def build_selected_picker_groups(
    config: dict[str, Any],
    role_picker_options: list[dict[str, Any]],
    channel_picker_options: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    def resolve_single(value: str | None, options: list[dict[str, Any]], fallback_prefix: str):
        if not value:
            return []
        return resolve_picker_items([value], options, fallback_prefix)

    return {
        "staffRoleIds": resolve_picker_items(config["roles"]["staffRoleIds"], role_picker_options, "Rol"),
        "upperStaffRoleIds": resolve_picker_items(config["roles"]["upperStaffRoleIds"], role_picker_options, "Rol"),
        "supervisorRoleIds": resolve_picker_items(config["roles"]["supervisorRoleIds"], role_picker_options, "Rol"),
        "banRoleIds": resolve_picker_items(config["roles"]["banRoleIds"], role_picker_options, "Rol"),
        "kickRoleIds": resolve_picker_items(config["roles"]["kickRoleIds"], role_picker_options, "Rol"),
        "ticketRoleIds": resolve_picker_items(config["roles"].get("ticketRoleIds", []), role_picker_options, "Rol"),
        "afkChannelId": resolve_single(config["voice"]["afkChannelId"], channel_picker_options, "Kanal"),
        "ignoredChannelIds": resolve_picker_items(config["voice"]["ignoredChannelIds"], channel_picker_options, "Kanal"),
        "ignoredCategoryIds": resolve_picker_items(config["voice"]["ignoredCategoryIds"], channel_picker_options, "Kategori"),
        "panelChannelIds": resolve_picker_items(config["ticket"]["panelChannelIds"], channel_picker_options, "Kanal"),
        "categoryParentId": resolve_single(config["ticket"]["categoryParentId"], channel_picker_options, "Kategori"),
        "archiveCategoryId": resolve_single(config["ticket"]["archiveCategoryId"], channel_picker_options, "Kategori"),
        "unprovenTargetRoleIds": resolve_picker_items(config["unproven"]["targetRoleIds"], role_picker_options, "Rol"),
        "unprovenProofChannelId": resolve_single(config["unproven"]["proofChannelId"], channel_picker_options, "Kanal"),
    }


def build_guard_selected_picker_groups(
    config: dict[str, Any],
    role_picker_options: list[dict[str, Any]],
    member_picker_options: list[dict[str, Any]],
    channel_picker_options: list[dict[str, Any]] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    guard_config = config.get("ultraProtection") or {}
    whitelist = guard_config.get("whitelist") or {}
    blacklist = guard_config.get("blacklist") or {}

    def resolve_single(value: str | None, options: list[dict[str, Any]], fallback_prefix: str):
        if not value:
            return []
        return resolve_picker_items([value], options, fallback_prefix)

    selections: dict[str, list[dict[str, Any]]] = {
        "whitelistUserIds": resolve_picker_items(
            whitelist.get("userIds", []), member_picker_options, "Üye"
        ),
        "whitelistRoleIds": resolve_picker_items(
            whitelist.get("roleIds", []), role_picker_options, "Rol"
        ),
        "blacklistUserIds": resolve_picker_items(
            blacklist.get("userIds", []), member_picker_options, "Üye"
        ),
        "blacklistRoleIds": resolve_picker_items(
            blacklist.get("roleIds", []), role_picker_options, "Rol"
        ),
        "quarantineRoleId": resolve_single(
            guard_config.get("quarantineRoleId"), role_picker_options, "Rol"
        ),
    }

    # Per-guard advanced whitelist role pickers and guard-specific pickers
    for definition in GUARD_FEATURE_DEFS:
        guard_key = definition["key"]
        guard_cfg = guard_config.get(guard_key) or {}
        if definition.get("supports_advanced"):
            selections[f"{guard_key}_whitelistRoleIds"] = resolve_picker_items(
                guard_cfg.get("whitelistRoleIds", []), role_picker_options, "Rol"
            )

    # Role Guard: protectedRoleIds picker
    role_guard_cfg = guard_config.get("roleGuard") or {}
    selections["roleGuard_protectedRoleIds"] = resolve_picker_items(
        role_guard_cfg.get("protectedRoleIds", []), role_picker_options, "Rol"
    )

    # Bot Guard: allowedBotIds picker (rendered as member picker)
    bot_guard_cfg = guard_config.get("botGuard") or {}
    selections["botGuard_allowedBotIds"] = resolve_picker_items(
        bot_guard_cfg.get("allowedBotIds", []), member_picker_options, "Bot"
    )

    # Invite Guard: exemptChannelIds picker
    invite_cfg = guard_config.get("inviteLinkGuard") or {}
    if channel_picker_options is not None:
        selections["inviteLinkGuard_exemptChannelIds"] = resolve_picker_items(
            invite_cfg.get("exemptChannelIds", []), channel_picker_options, "Kanal"
        )

    # AutoMod Guard: exemptRoleIds, exemptChannelIds, alertChannelId pickers
    automod_cfg = guard_config.get("autoModGuard") or {}
    selections["autoModGuard_exemptRoleIds"] = resolve_picker_items(
        automod_cfg.get("exemptRoleIds", []), role_picker_options, "Rol"
    )
    if channel_picker_options is not None:
        selections["autoModGuard_exemptChannelIds"] = resolve_picker_items(
            automod_cfg.get("exemptChannelIds", []), channel_picker_options, "Kanal"
        )
        selections["autoModGuard_alertChannelId"] = resolve_single(
            automod_cfg.get("alertChannelId"), channel_picker_options, "Kanal"
        )

    return selections


def build_moderation_selected_picker_groups(
    config: dict[str, Any],
    role_picker_options: list[dict[str, Any]],
    channel_picker_options: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    moderation_config = config.get("moderation") or {}

    def resolve_single(value: str | None, options: list[dict[str, Any]], fallback_prefix: str):
        if not value:
            return []
        return resolve_picker_items([value], options, fallback_prefix)

    return {
        "banRoleIds": resolve_picker_items(config["roles"]["banRoleIds"], role_picker_options, "Rol"),
        "kickRoleIds": resolve_picker_items(config["roles"]["kickRoleIds"], role_picker_options, "Rol"),
        "unbanRoleIds": resolve_picker_items(config["roles"]["unbanRoleIds"], role_picker_options, "Rol"),
        "timeoutRoleIds": resolve_picker_items(config["roles"]["timeoutRoleIds"], role_picker_options, "Rol"),
        "warnRoleIds": resolve_picker_items(config["roles"]["warnRoleIds"], role_picker_options, "Rol"),
        "jailRoleIds": resolve_picker_items(config["roles"]["jailRoleIds"], role_picker_options, "Rol"),
        "messageModerationRoleIds": resolve_picker_items(
            config["roles"]["messageModerationRoleIds"], role_picker_options, "Rol"
        ),
        "channelModerationRoleIds": resolve_picker_items(
            config["roles"]["channelModerationRoleIds"], role_picker_options, "Rol"
        ),
        "historyRoleIds": resolve_picker_items(config["roles"]["historyRoleIds"], role_picker_options, "Rol"),
        "ticketRoleIds": resolve_picker_items(config["roles"].get("ticketRoleIds", []), role_picker_options, "Rol"),
        "moderationJailRoleId": resolve_single(moderation_config.get("jailRoleId"), role_picker_options, "Rol"),
        "moderationMutedRoleId": resolve_single(
            moderation_config.get("mutedRoleId"), role_picker_options, "Rol"
        ),
        "moderationLogChannelId": resolve_single(
            moderation_config.get("logChannelId"), channel_picker_options, "Kanal"
        ),
    }


def filter_channel_picker_options(
    channel_picker_options: list[dict[str, Any]], allowed_kinds: set[str]
) -> list[dict[str, Any]]:
    return [option for option in channel_picker_options if option.get("channel_kind") in allowed_kinds]


def template_context(request: Request, **kwargs: Any) -> dict[str, Any]:
    path = request.url.path
    segments = [segment for segment in path.split("/") if segment]
    active_section = segments[0] if segments else "overview"
    context = {
        "request": request,
        "active_path": path,
        "active_section": active_section,
        "period": request.query_params.get("period", "day"),
    }
    context.update(kwargs)
    return context


def render_page(request: Request, template_name: str, **kwargs: Any) -> HTMLResponse:
    context = template_context(request, **kwargs)
    html = templates.get_template(template_name).render(context)
    return HTMLResponse(content=html)


@app.get("/")
def root():
    return RedirectResponse("/overview", status_code=302)


@app.get("/health")
def health(request: Request):
    sync_status = get_message_history_sync_status()
    return render_page(
        request,
        "health.html",
        health=build_health_scene(get_system_health(), sync_status),
        sync_status=sync_status,
    )


@app.get("/message-audit")
def message_audit(
    request: Request,
    period: str = "day",
    author_id: str | None = None,
    event_type: str | None = None,
):
    author_id_val = parse_optional_int(author_id)
    normalized_event_type = event_type if event_type in {"edit", "delete"} else None
    staff_options = list_member_picker_options("staff")
    return render_page(
        request,
        "message_audit.html",
        audit=build_message_audit_scene(
            get_staff_message_audit_summary(period),
            list_staff_message_events(period, author_id=author_id_val, event_type=normalized_event_type),
            staff_options,
            author_id_val,
            normalized_event_type,
            period,
        ),
        period=period,
    )


@app.get("/staff-compare")
def staff_compare(
    request: Request,
    period: str = "day",
    left_user_id: str | None = None,
    right_user_id: str | None = None,
):
    left_id_val = parse_optional_int(left_user_id)
    right_id_val = parse_optional_int(right_user_id)
    staff_rows = list_members("staff", period)
    return render_page(
        request,
        "staff_compare.html",
        comparison=build_staff_comparison_scene(
            staff_rows,
            left_id_val,
            right_id_val,
            period,
        ),
        period=period,
    )


@app.get("/packages")
def packages(request: Request, period: str = "day", user_id: str | None = None):
    user_id_val = parse_optional_int(user_id)
    member_options = [
        {
            **item,
            "label": f"{item['display_name']} · {member_type_label(str(item['member_type']))}",
        }
        for item in list_member_picker_options()
    ]
    selected_user_id = user_id_val or (
        safe_int(member_options[0]["user_id"]) if member_options else None
    )
    package = assemble_investigation_package(selected_user_id, period) if selected_user_id else None
    return render_page(
        request,
        "packages.html",
        package=build_investigation_package_scene(
            package,
            member_options,
            selected_user_id,
            period,
        ),
        period=period,
    )


@app.get("/packages/export")
def export_package(user_id: int, period: str = "day"):
    package = assemble_investigation_package(user_id, period)
    if not package:
        return JSONResponse(status_code=404, content={"error": "Paket verisi bulunamadı."})

    return JSONResponse(content=json.loads(json.dumps(package, default=str)))


@app.get("/overview")
def overview(request: Request, period: str = "day"):
    overview_payload = get_overview(period)
    return render_page(
        request,
        "overview.html",
        overview=overview_payload,
        media=build_media_distribution(
            overview_payload["staff_voice_seconds"],
            overview_payload["camera_seconds"],
            overview_payload["stream_seconds"],
        ),
        alerts=build_alert_scene(get_alerts()),
        period=period,
    )


@app.get("/staff")
def staff(request: Request, period: str = "day"):
    members_payload = list_members("staff", period)
    return render_page(
        request,
        "staff.html",
        members=members_payload,
        scene=build_member_scene(members_payload, "staff"),
        period=period,
    )


@app.get("/staff/{user_id}")
def staff_detail(request: Request, user_id: int, period: str = "day"):
    member_data = get_member_detail(user_id, "staff", period)
    config = fetch_config()
    role_lookup = {
        str(role.get("role_id")): str(role.get("role_name") or role.get("role_id"))
        for role in list_guild_roles()
    }
    member_data["rank"] = build_member_rank_scene(
        get_member_rank_detail(user_id, "staff"), config, role_lookup
    )
    member_data["moderation_cases"] = build_moderation_case_items(
        list_moderation_cases_for_member(user_id)
    )
    member_data["channel_scene"] = build_member_channel_scene(member_data.get("channels", []))
    member_data["heatmap_scene"] = build_member_heatmap_scene(member_data.get("heatmap", []))
    return render_page(
        request,
        "member_detail.html",
        member_data=member_data,
        member_type="staff",
        period=period,
    )


@app.get("/members")
def members(request: Request, period: str = "day"):
    members_payload = list_members("user", period)
    return render_page(
        request,
        "members.html",
        members=members_payload,
        scene=build_member_scene(members_payload, "user"),
        period=period,
    )


@app.get("/members/{user_id}")
def member_detail(request: Request, user_id: int, period: str = "day"):
    member_data = get_member_detail(user_id, "user", period)
    config = fetch_config()
    role_lookup = {
        str(role.get("role_id")): str(role.get("role_name") or role.get("role_id"))
        for role in list_guild_roles()
    }
    member_data["rank"] = build_member_rank_scene(
        get_member_rank_detail(user_id, "user"), config, role_lookup
    )
    member_data["moderation_cases"] = build_moderation_case_items(
        list_moderation_cases_for_member(user_id)
    )
    member_data["channel_scene"] = build_member_channel_scene(member_data.get("channels", []))
    member_data["heatmap_scene"] = build_member_heatmap_scene(member_data.get("heatmap", []))
    return render_page(
        request,
        "member_detail.html",
        member_data=member_data,
        member_type="user",
        period=period,
    )


@app.get("/tickets")
def tickets(request: Request, period: str = "day"):
    ticket_data = get_ticket_analytics(period)
    return render_page(
        request,
        "tickets.html",
        data=ticket_data,
        scene=build_ticket_scene(ticket_data),
        period=period,
    )


@app.get("/actions")
def actions(request: Request, period: str = "day"):
    action_data = get_action_analytics(period)
    return render_page(
        request,
        "actions.html",
        data=action_data,
        scene=build_action_scene(action_data),
        period=period,
    )


@app.get("/voice")
def voice(request: Request, period: str = "day"):
    voice_data = get_voice_analytics(period)
    return render_page(
        request,
        "voice.html",
        data=voice_data,
        view=build_voice_scene(voice_data),
        period=period,
    )


@app.get("/unproven")
def unproven(request: Request, period: str = "day"):
    unproven_data = get_unproven_actions(period)
    return render_page(
        request,
        "unproven.html",
        actions=unproven_data,
        period=period,
    )


@app.delete("/unproven")
def clear_unproven_route():
    clear_unproven_actions()
    return HTMLResponse(content='<div class="nx-empty">TÃ¼m kanÄ±tsÄ±z iÅŸlemler baÅŸarÄ±yla temizlendi. Åu anda listelenecek iÅŸlem bulunmuyor.</div>')


@app.get("/roles")
def roles(request: Request, period: str = "day"):
    raw_roles = list_guild_roles()
    
    # Discord Permission Bitwise Flags
    # Administrator: 1 << 3 = 8
    # Ban Members: 1 << 2 = 4
    # Kick Members: 1 << 1 = 2
    # Manage Server: 1 << 5 = 32
    # Manage Roles: 1 << 28 = 268435456
    # Manage Channels: 1 << 4 = 16
    
    analyzed_roles = []
    for role in raw_roles:
        perm_val = int(role.get("permissions", "0"))
        
        is_admin = bool(perm_val & 8)
        can_ban = bool(perm_val & 4)
        can_kick = bool(perm_val & 2)
        can_manage_server = bool(perm_val & 32)
        can_manage_roles = bool(perm_val & 268435456)
        can_manage_channels = bool(perm_val & 16)
        
        flags = []
        if is_admin: flags.append("Yönetici")
        if can_ban: flags.append("Üye Yasakla")
        if can_kick: flags.append("Üye At")
        if can_manage_server: flags.append("Sunucu Yönet")
        if can_manage_roles: flags.append("Rol Yönet")
        if can_manage_channels: flags.append("Kanal Yönet")
        
        risk_level = "low"
        if is_admin:
            risk_level = "high"
        elif can_ban or can_manage_server or can_manage_roles:
            risk_level = "medium"
            
        # We also might want to display the standard discord color or default if missing
        color = role.get("color_hex")
        if not color or color == "#000000":
            color = "#80848e" # Discord's default role gray
            
        analyzed_roles.append({
            **role,
            "color_hex": color,
            "flags": flags,
            "risk_level": risk_level,
            "is_risky": len(flags) > 0
        })
        
    # Sort: High risk first, then medium risk, then others. Finally by position descending
    def sort_key(r):
        level_score = 0
        if r["risk_level"] == "high": level_score = 2
        elif r["risk_level"] == "medium": level_score = 1
        return (level_score, r["position"])
        
    analyzed_roles.sort(key=sort_key, reverse=True)

    return render_page(
        request,
        "roles.html",
        roles=analyzed_roles,
        role_history=build_role_history_scene(list_role_change_events()),
        period=period,
    )


@app.api_route("/api/unproven/badge", methods=["GET"])
def unproven_badge():
    count = get_unproven_count()
    if count > 0:
        return HTMLResponse(content=f'<span class="nav-badge" hx-get="/api/unproven/badge" hx-trigger="every 10s" hx-swap="outerHTML">{count}</span>')
    return HTMLResponse(content='<span class="nav-badge" hx-get="/api/unproven/badge" hx-trigger="every 10s" hx-swap="outerHTML" style="display: none;"></span>')


import uuid

@app.get("/filters")
def filters_page(request: Request):
    config = fetch_config()
    banned_words = config.get("bannedWords", [])
    channel_options = list_guild_channels()
    
    channels_map = {opt["channel_id"]: opt["channel_name"] for opt in channel_options}
    
    enriched_filters = []
    for rule in banned_words:
        enriched_filters.append({
            "id": rule.get("id"),
            "channel_id": rule.get("channelId"),
            "channel_name": channels_map.get(rule.get("channelId"), "Bilinmeyen Kanal"),
            "words": rule.get("words", [])
        })

    channel_picker_options = build_channel_picker_options(channel_options)
    text_channels = filter_channel_picker_options(
        channel_picker_options, {"text", "announcement", "forum"}
    )
    
    return render_page(
        request,
        "filters.html",
        filters=enriched_filters,
        text_channel_picker_options=text_channels,
    )


@app.post("/filters")
def filters_add(request: Request, channel_id: str = Form(...), words: str = Form(...)):
    is_htmx = request.headers.get("HX-Request") == "true"

    if not channel_id or not words.strip():
        if is_htmx:
            response = HTMLResponse()
            response.headers["HX-Refresh"] = "true"
            return response
        return RedirectResponse("/filters", status_code=303)
        
    word_list = [w.strip() for w in words.split(",") if w.strip()]
    if not word_list:
        if is_htmx:
            response = HTMLResponse()
            response.headers["HX-Refresh"] = "true"
            return response
        return RedirectResponse("/filters", status_code=303)
        
    config = fetch_config()
    banned_words = config.get("bannedWords", [])
    
    # Update existing rule for channel or create new
    existing_rule = next((r for r in banned_words if r.get("channelId") == channel_id), None)
    
    if existing_rule:
        existing_words = set(existing_rule.get("words", []))
        existing_words.update(word_list)
        existing_rule["words"] = list(existing_words)
    else:
        new_rule = {
            "id": str(uuid.uuid4()),
            "channelId": channel_id,
            "words": word_list
        }
        banned_words.append(new_rule)
        
    config["bannedWords"] = banned_words
    save_config(config)
    
    if is_htmx:
        response = HTMLResponse()
        response.headers["HX-Refresh"] = "true"
        return response

    return RedirectResponse("/filters", status_code=303)


@app.delete("/filters/{rule_id}")
def filters_remove(request: Request, rule_id: str):
    config = fetch_config()
    banned_words = config.get("bannedWords", [])
    
    new_banned_words = [r for r in banned_words if r.get("id") != rule_id]
    
    if len(new_banned_words) != len(banned_words):
        config["bannedWords"] = new_banned_words
        save_config(config)
        
    # Standard HTMX response strategy - let the client reload the table if they want, 
    # but since we hx-swap="outerHTML" on the list itself, we should return the updated list HTML,
    # or just trigger a page reload via response headers.
    response = HTMLResponse()
    response.headers["HX-Refresh"] = "true"
    return response


@app.get("/channel-analysis")
def channel_analysis_page(request: Request):
    config = fetch_config()
    channel_options = list_guild_channels()
    channel_picker_options = build_channel_picker_options(channel_options)
    analysis_channels = filter_channel_picker_options(
        channel_picker_options, {"text", "announcement", "forum", "media"}
    )

    return render_page(
        request,
        "channel_analysis.html",
        channel_analysis=build_channel_analysis_scene(
            config,
            channel_options,
            list_channel_analysis_actions(),
        ),
        analysis_channel_picker_options=analysis_channels,
    )


@app.get("/moderation")
def moderation_page(request: Request):
    config = fetch_config()
    role_options = list_guild_roles()
    channel_options = list_guild_channels()
    role_picker_options = build_role_picker_options(role_options)
    channel_picker_options = build_channel_picker_options(channel_options)
    log_channels = filter_channel_picker_options(channel_picker_options, {"text", "announcement"})
    return render_page(
        request,
        "moderation_settings.html",
        config=config,
        role_picker_options=role_picker_options,
        log_channel_picker_options=log_channels,
        selected_items=build_moderation_selected_picker_groups(
            config, role_picker_options, channel_picker_options
        ),
        saved=request.query_params.get("saved"),
    )


@app.post("/moderation")
def moderation_save(
    ban_role_ids: list[str] | None = Form(None),
    kick_role_ids: list[str] | None = Form(None),
    unban_role_ids: list[str] | None = Form(None),
    timeout_role_ids: list[str] | None = Form(None),
    warn_role_ids: list[str] | None = Form(None),
    jail_role_ids: list[str] | None = Form(None),
    message_moderation_role_ids: list[str] | None = Form(None),
    channel_moderation_role_ids: list[str] | None = Form(None),
    history_role_ids: list[str] | None = Form(None),
    ticket_role_ids: list[str] | None = Form(None),
    moderation_jail_role_id: list[str] | None = Form(None),
    moderation_muted_role_id: list[str] | None = Form(None),
    moderation_log_channel_id: list[str] | None = Form(None),
    moderation_default_dm_enabled: str | None = Form(None),
    moderation_default_timeout_minutes: int = Form(10),
    moderation_default_warn_points: int = Form(1),
    moderation_purge_max_limit: int = Form(200),
    moderation_safe_flow_enabled: str | None = Form(None),
    moderation_global_ban_enabled: str | None = Form(None),
    moderation_role_limits_json: str | None = Form(None),
    moderation_user_limits_json: str | None = Form(None),
):
    save_config(
        {
            "roles": {
                "banRoleIds": normalize_picker_ids(ban_role_ids),
                "kickRoleIds": normalize_picker_ids(kick_role_ids),
                "unbanRoleIds": normalize_picker_ids(unban_role_ids),
                "timeoutRoleIds": normalize_picker_ids(timeout_role_ids),
                "warnRoleIds": normalize_picker_ids(warn_role_ids),
                "jailRoleIds": normalize_picker_ids(jail_role_ids),
                "messageModerationRoleIds": normalize_picker_ids(message_moderation_role_ids),
                "channelModerationRoleIds": normalize_picker_ids(channel_moderation_role_ids),
                "historyRoleIds": normalize_picker_ids(history_role_ids),
                "ticketRoleIds": normalize_picker_ids(ticket_role_ids),
            },
            "moderation": {
                "jailRoleId": pick_single_id(moderation_jail_role_id),
                "mutedRoleId": pick_single_id(moderation_muted_role_id),
                "logChannelId": pick_single_id(moderation_log_channel_id),
                "defaultDmEnabled": checkbox_enabled(moderation_default_dm_enabled),
                "defaultTimeoutMinutes": max(safe_int(moderation_default_timeout_minutes), 1),
                "defaultWarnPoints": max(safe_int(moderation_default_warn_points), 1),
                "purgeMaxLimit": max(safe_int(moderation_purge_max_limit), 1),
                "safeFlowEnabled": checkbox_enabled(moderation_safe_flow_enabled),
                "globalBanEnabled": checkbox_enabled(moderation_global_ban_enabled),
                "roleLimits": parse_json_array(moderation_role_limits_json),
                "userLimits": parse_json_array(moderation_user_limits_json),
            },
        }
    )
    return RedirectResponse("/moderation?saved=1", status_code=303)


@app.get("/moderation-history")
def moderation_history_page(
    request: Request,
    case_type: str = "all",
    status: str = "all",
    actor_id: str | None = None,
    target_id: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: str = "80",
):
    actor_id_clean = actor_id if actor_id and str(actor_id).strip() else None
    target_id_clean = target_id if target_id and str(target_id).strip() else None
    limit_value = parse_optional_int(limit) or 80
    member_options = list_member_picker_options()
    rows = list_moderation_cases(
        limit=limit_value,
        case_type=case_type,
        status=status,
        actor_id=actor_id_clean,
        target_id=target_id_clean,
        date_from=date_from,
        date_to=date_to,
    )
    actions = list_moderation_actions(
        limit=limit_value,
        action_type=case_type,
        actor_id=actor_id_clean,
        target_id=target_id_clean,
        date_from=date_from,
        date_to=date_to,
    )
    return render_page(
        request,
        "moderation_history.html",
        moderation={
            "rows": build_moderation_case_items(rows),
            "actions": build_moderation_action_items(actions),
            "filters": {
                "case_type": case_type,
                "status": status,
                "actor_id": actor_id_clean or "",
                "target_id": target_id_clean or "",
                "date_from": date_from or "",
                "date_to": date_to or "",
                "limit": limit_value,
            },
            "member_options": member_options,
        },
    )


def build_moderation_limits_scene(config: dict[str, Any], role_lookup: dict[str, str], member_options: list[dict[str, Any]]):
    mod = config.get("moderation") or {}
    role_limits = mod.get("roleLimits") or []
    user_limits = mod.get("userLimits") or []
    
    rules = []
    member_lookup = {str(m.get("item_id")): m.get("item_name") for m in member_options}
    
    for entry in role_limits:
        tid = str(entry.get("targetId"))
        tname = role_lookup.get(tid, tid)
        for lim in entry.get("limits", []):
            rules.append({
                "target_type": "role",
                "target_id": tid,
                "target_name": tname,
                "action_type": lim.get("actionType"),
                "max_daily": lim.get("maxDaily"),
                "target_icon": "fa-user-shield",
                "type_label": "Rol"
            })
            
    for entry in user_limits:
        tid = str(entry.get("targetId"))
        tname = member_lookup.get(tid, tid)
        for lim in entry.get("limits", []):
            rules.append({
                "target_type": "user",
                "target_id": tid,
                "target_name": tname,
                "action_type": lim.get("actionType"),
                "max_daily": lim.get("maxDaily"),
                "target_icon": "fa-user",
                "type_label": "Kullanıcı"
            })
    return rules


@app.get("/moderation-limits")
def moderation_limits_page(request: Request):
    config = fetch_config()
    role_options = list_guild_roles()
    role_picker_options = build_role_picker_options(role_options)
    role_lookup = {str(r.get("item_id")): str(r.get("item_name")) for r in role_picker_options}
    member_options = list_member_picker_options()
    
    rules = build_moderation_limits_scene(config, role_lookup, member_options)
    
    return render_page(
        request,
        "moderation_limits.html",
        rules=rules,
        role_options=role_picker_options,
        member_options=member_options
    )


@app.post("/moderation-limits")
def moderation_limits_add(
    target_type: str = Form(...),
    target_id: str = Form(...),
    action_type: str = Form(...),
    max_daily: int = Form(...)
):
    normalized_target_id = target_id.strip()
    if not normalized_target_id:
        return RedirectResponse("/moderation-limits", status_code=303)

    config = fetch_config()
    mod_config = config.get("moderation")
    if not isinstance(mod_config, dict):
        mod_config = {}
        config["moderation"] = mod_config

    list_key = "userLimits" if target_type == "user" else "roleLimits"
    limits_list = list(mod_config.get(list_key) or [])
    
    entry = next((e for e in limits_list if e.get("targetId") == normalized_target_id), None)
    if not entry:
        entry = {"targetId": normalized_target_id, "limits": []}
        limits_list.append(entry)
        
    spec = next((l for l in entry.get("limits", []) if l.get("actionType") == action_type), None)
    if spec:
        spec["maxDaily"] = max(1, max_daily)
    else:
        if not isinstance(entry.get("limits"), list):
            entry["limits"] = []
        entry["limits"].append({"actionType": action_type, "maxDaily": max(1, max_daily)})
        
    mod_config[list_key] = limits_list
    save_config(config)
    return RedirectResponse("/moderation-limits", status_code=303)


@app.delete("/moderation-limits/{target_type}/{target_id}/{action_type}")
def moderation_limits_remove(target_type: str, target_id: str, action_type: str):
    config = fetch_config()
    mod_config = config.get("moderation") or {}
    list_key = "userLimits" if target_type == "user" else "roleLimits"
    limits_list = list(mod_config.get(list_key) or [])
    
    entry = next((e for e in limits_list if e.get("targetId") == target_id), None)
    if entry:
        old_limits = entry.get("limits", [])
        new_limits = [l for l in old_limits if l.get("actionType") != action_type]
        if len(new_limits) == 0:
            limits_list = [e for e in limits_list if e.get("targetId") != target_id]
        else:
            entry["limits"] = new_limits
        mod_config[list_key] = limits_list
        save_config(config)

    response = HTMLResponse()
    response.headers["HX-Refresh"] = "true"
    return response


@app.get("/levels")
def levels_page(request: Request):
    config = fetch_config()
    rank_config = config.get("rankSystem") or {}
    role_options = list_guild_roles()
    channel_options = list_guild_channels()
    role_picker_options = build_role_picker_options(role_options)
    channel_picker_options = build_channel_picker_options(channel_options)
    text_channels = filter_channel_picker_options(
        channel_picker_options, {"text", "announcement", "forum", "media"}
    )
    category_channels = filter_channel_picker_options(channel_picker_options, {"category"})

    return render_page(
        request,
        "rank_settings.html",
        config=config,
        rank_config=rank_config,
        role_options=role_options,
        text_channel_picker_options=text_channels,
        category_picker_options=category_channels,
        selected_items=build_rank_selected_picker_groups(config, channel_picker_options),
        voice_reward_rows=build_rank_reward_form_rows(
            (rank_config.get("rewards") or {}).get("voiceRewards", [])
        ),
        text_reward_rows=build_rank_reward_form_rows(
            (rank_config.get("rewards") or {}).get("textRewards", [])
        ),
        status=build_rank_status_scene(get_rank_backfill_status()),
        saved=request.query_params.get("saved"),
        reward_sync_requested=request.query_params.get("reward_sync_requested"),
        reset=request.query_params.get("reset"),
    )


@app.post("/levels")
def levels_save(
    rank_enabled: str | None = Form(None),
    rank_base_xp: int = Form(100),
    rank_linear_xp: int = Form(35),
    rank_quadratic_xp: int = Form(10),
    rank_panel_page_size: int = Form(50),
    rank_command_top_size: int = Form(10),
    rank_text_enabled: str | None = Form(None),
    rank_text_xp_per_message: int = Form(5),
    rank_text_cooldown_seconds: int = Form(45),
    rank_text_min_length: int = Form(8),
    rank_text_duplicate_window_minutes: int = Form(10),
    rank_text_hourly_cap: int = Form(20),
    rank_text_ignored_channel_ids: list[str] | None = Form(None),
    rank_text_ignored_category_ids: list[str] | None = Form(None),
    rank_voice_enabled: str | None = Form(None),
    rank_voice_xp_per_minute: int = Form(2),
    rank_voice_min_chunk_seconds: int = Form(60),
    rank_rewards_enabled: str | None = Form(None),
    rank_level_messages_enabled: str | None = Form(None),
    rank_announcement_channel_id: list[str] | None = Form(None),
    rank_role_mode: str = Form("highest_only"),
    voice_reward_levels: list[str] | None = Form(None),
    voice_reward_role_ids: list[str] | None = Form(None),
    text_reward_levels: list[str] | None = Form(None),
    text_reward_role_ids: list[str] | None = Form(None),
):
    save_config(
        {
            "rankSystem": {
                "enabled": checkbox_enabled(rank_enabled),
                "curve": {
                    "baseXp": max(safe_int(rank_base_xp), 1),
                    "linearXp": max(safe_int(rank_linear_xp), 0),
                    "quadraticXp": max(safe_int(rank_quadratic_xp), 0),
                },
                "leaderboard": {
                    "panelPageSize": max(safe_int(rank_panel_page_size), 10),
                    "commandTopSize": max(safe_int(rank_command_top_size), 3),
                },
                "text": {
                    "enabled": checkbox_enabled(rank_text_enabled),
                    "xpPerEligibleMessage": max(safe_int(rank_text_xp_per_message), 1),
                    "cooldownSeconds": max(safe_int(rank_text_cooldown_seconds), 0),
                    "minNormalizedLength": max(safe_int(rank_text_min_length), 1),
                    "duplicateWindowMinutes": max(
                        safe_int(rank_text_duplicate_window_minutes), 1
                    ),
                    "hourlyEligibleCap": max(safe_int(rank_text_hourly_cap), 1),
                    "ignoredChannelIds": normalize_picker_ids(rank_text_ignored_channel_ids),
                    "ignoredCategoryIds": normalize_picker_ids(rank_text_ignored_category_ids),
                },
                "voice": {
                    "enabled": checkbox_enabled(rank_voice_enabled),
                    "xpPerActiveMinute": max(safe_int(rank_voice_xp_per_minute), 1),
                    "minAwardChunkSeconds": max(safe_int(rank_voice_min_chunk_seconds), 1),
                },
                "rewards": {
                    "roleRewardsEnabled": checkbox_enabled(rank_rewards_enabled),
                    "levelUpMessagesEnabled": checkbox_enabled(rank_level_messages_enabled),
                    "announcementChannelId": pick_single_id(rank_announcement_channel_id),
                    "roleMode": rank_role_mode
                    if rank_role_mode in {"highest_only", "stacking"}
                    else "highest_only",
                    "voiceRewards": parse_rank_reward_rows(
                        voice_reward_levels, voice_reward_role_ids
                    ),
                    "textRewards": parse_rank_reward_rows(
                        text_reward_levels, text_reward_role_ids
                    ),
                },
            }
        }
    )
    return RedirectResponse("/levels?saved=1", status_code=303)


@app.post("/levels/sync-rewards")
def levels_sync_rewards():
    request_rank_reward_sync()
    return RedirectResponse("/levels?reward_sync_requested=1", status_code=303)


@app.post("/levels/reset")
def levels_reset():
    reset_rank_system()
    return RedirectResponse("/levels?reset=1", status_code=303)


@app.get("/member-ranks")
def member_ranks(
    request: Request,
    track: str = "voice",
    scope: str = "user",
):
    normalized_track = "text" if track == "text" else "voice"
    normalized_scope = scope if scope in {"user", "staff", "all"} else "user"
    config = fetch_config()
    role_lookup = {
        str(role.get("role_id")): str(role.get("role_name") or role.get("role_id"))
        for role in list_guild_roles()
    }
    limit = max(
        10,
        safe_int(
            ((config.get("rankSystem") or {}).get("leaderboard") or {}).get("panelPageSize", 50)
        ),
    )
    rows = list_rank_leaderboard(normalized_scope, normalized_track, limit)
    return render_page(
        request,
        "rank_board.html",
        board=build_rank_board_scene(rows, normalized_track, normalized_scope, config, role_lookup),
        period="all",
        track=normalized_track,
        scope=normalized_scope,
    )


@app.get("/staff-ranks")
def staff_ranks(request: Request, track: str = "voice"):
    normalized_track = "text" if track == "text" else "voice"
    config = fetch_config()
    role_lookup = {
        str(role.get("role_id")): str(role.get("role_name") or role.get("role_id"))
        for role in list_guild_roles()
    }
    limit = max(
        10,
        safe_int(
            ((config.get("rankSystem") or {}).get("leaderboard") or {}).get("panelPageSize", 50)
        ),
    )
    rows = list_rank_leaderboard("staff", normalized_track, limit)
    return render_page(
        request,
        "rank_board.html",
        board=build_rank_board_scene(rows, normalized_track, "staff", config, role_lookup),
        period="all",
        track=normalized_track,
        scope="staff",
    )


@app.post("/channel-analysis")
def channel_analysis_add(
    channel_id: str = Form(...),
    max_messages_per_hour: int = Form(...),
    timeout_minutes: int = Form(...),
):
    normalized_channel_id = channel_id.strip()
    hourly_limit = safe_int(max_messages_per_hour)
    timeout_limit = safe_int(timeout_minutes)

    if not normalized_channel_id or hourly_limit <= 0 or timeout_limit <= 0:
        return RedirectResponse("/channel-analysis", status_code=303)

    config = fetch_config()
    channel_analysis = config.get("channelAnalysis")
    if not isinstance(channel_analysis, dict):
        channel_analysis = {"rules": []}

    rules = list(channel_analysis.get("rules") or [])
    existing_rule = next(
        (rule for rule in rules if str(rule.get("channelId") or "").strip() == normalized_channel_id),
        None,
    )

    if existing_rule:
        existing_rule["maxMessagesPerHour"] = hourly_limit
        existing_rule["timeoutMinutes"] = timeout_limit
    else:
        rules.append(
            {
                "id": str(uuid.uuid4()),
                "channelId": normalized_channel_id,
                "maxMessagesPerHour": hourly_limit,
                "timeoutMinutes": timeout_limit,
            }
        )

    config["channelAnalysis"] = {"rules": rules}
    save_config(config)
    return RedirectResponse("/channel-analysis", status_code=303)


@app.delete("/channel-analysis/{rule_id}")
def channel_analysis_remove(rule_id: str):
    config = fetch_config()
    channel_analysis = config.get("channelAnalysis")
    if not isinstance(channel_analysis, dict):
        channel_analysis = {"rules": []}

    rules = list(channel_analysis.get("rules") or [])
    filtered_rules = [rule for rule in rules if str(rule.get("id")) != rule_id]
    if len(filtered_rules) != len(rules):
        config["channelAnalysis"] = {"rules": filtered_rules}
        save_config(config)

    response = HTMLResponse()
    response.headers["HX-Refresh"] = "true"
    return response


@app.get("/guard-logs")
def guard_logs_page(
    request: Request,
    source: str = "all",
    severity: str = "all",
    feature: str = "all",
    actor_id: str | None = None,
    q: str | None = None,
    limit: str = "80",
):
    actor_id_val = parse_optional_int(actor_id)
    member_options = list_member_picker_options()
    normalized_limit = max(20, min(parse_optional_int(limit) or 80, 120))
    return render_page(
        request,
        "guard_logs.html",
        logs=build_guard_log_scene(
            list_guard_log_events(
                limit=normalized_limit,
                source=source,
                severity=severity,
                feature=feature,
                actor_id=actor_id,
                query=q,
            ),
            member_options,
            source,
            severity,
            feature,
            actor_id_val,
            q,
            normalized_limit,
        ),
    )


@app.get("/guards")
def guards_page(request: Request):
    config = fetch_config()
    role_options = list_guild_roles()
    member_options = list_member_picker_options()
    channel_options = list_guild_channels()
    role_picker_options = build_role_picker_options(role_options)
    member_picker_options = build_member_picker_options(member_options)
    channel_picker_options = build_channel_picker_options(channel_options)
    text_channel_picker_options = filter_channel_picker_options(
        channel_picker_options, {"text", "announcement", "forum", "media"}
    )

    return render_page(
        request,
        "guards.html",
        config=config,
        protection=build_ultra_protection_scene(config, list_server_backups()),
        role_picker_options=role_picker_options,
        member_picker_options=member_picker_options,
        channel_picker_options=text_channel_picker_options,
        selected_items=build_guard_selected_picker_groups(
            config,
            role_picker_options,
            member_picker_options,
            text_channel_picker_options,
        ),
        saved=request.query_params.get("saved"),
        backup_created=request.query_params.get("backup_created"),
    )


_GUARD_SEVERITY_VALUES = {opt["value"] for opt in GUARD_SEVERITY_OPTIONS}
_GUARD_ACTION_TIER_VALUES = {opt["value"] for opt in GUARD_ACTION_TIER_OPTIONS}
_GUARD_ROLE_PERMISSION_VALUES = {opt["value"] for opt in GUARD_ROLE_PERMISSION_OPTIONS}
_GUARD_ROLLBACK_FIELD_VALUES = {opt["value"] for opt in GUARD_ROLLBACK_FIELD_OPTIONS}
_GUARD_ANTIRAID_ACTION_VALUES = {opt["value"] for opt in GUARD_ANTIRAID_ACTION_OPTIONS}
_GUARD_INVITE_ACTION_VALUES = {opt["value"] for opt in GUARD_INVITE_ACTION_OPTIONS}


def _form_checkbox(values: Any) -> bool:
    """Return True if a form field was submitted with any truthy/checked value."""
    if values is None:
        return False
    if isinstance(values, str):
        return values.lower() in {"on", "true", "1", "yes"}
    if isinstance(values, (list, tuple)):
        return any(_form_checkbox(item) for item in values)
    return bool(values)


def _form_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(parsed, maximum))


def _form_list(values: Any) -> list[str]:
    if values is None:
        return []
    if isinstance(values, (list, tuple)):
        return [str(item).strip() for item in values if str(item).strip()]
    text = str(values).strip()
    return [text] if text else []


def _form_enum(value: Any, allowed: set[str], default: str) -> str:
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    if isinstance(value, str) and value in allowed:
        return value
    return default


def _form_domain_list(raw: Any, limit: int = 50) -> list[str]:
    """Parse a newline/comma separated domain allowlist input into a clean list."""
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        raw = "\n".join(str(item) for item in raw)
    text = str(raw)
    cleaned: list[str] = []
    for chunk in text.replace(",", "\n").splitlines():
        domain = chunk.strip().lower().lstrip("@").rstrip("/")
        if not domain:
            continue
        if domain.startswith("http://"):
            domain = domain[7:]
        elif domain.startswith("https://"):
            domain = domain[8:]
        domain = domain.split("/")[0]
        if domain and domain not in cleaned:
            cleaned.append(domain)
        if len(cleaned) >= limit:
            break
    return cleaned


def _build_guard_advanced(form: dict[str, Any], prefix: str) -> dict[str, Any]:
    return {
        "logOnly": _form_checkbox(form.get(f"{prefix}_log_only")),
        "severityOverride": _form_enum(
            form.get(f"{prefix}_severity_override"), _GUARD_SEVERITY_VALUES, "inherit"
        ),
        "auditWindowSeconds": _form_int(
            form.get(f"{prefix}_audit_window_seconds"), 180, 30, 900
        ),
        "whitelistRoleIds": _form_list(form.get(f"{prefix}_whitelist_role_ids")),
        "cooldownSeconds": _form_int(form.get(f"{prefix}_cooldown_seconds"), 0, 0, 3600),
        "actionTier": _form_enum(
            form.get(f"{prefix}_action_tier"), _GUARD_ACTION_TIER_VALUES, "quarantine"
        ),
    }


@app.post("/guards")
async def guards_save(request: Request):
    raw = await request.form()
    # Materialize as a plain dict capturing multi-value fields as lists to make
    # downstream parsing consistent regardless of Jinja-side input names.
    form: dict[str, Any] = {}
    for key in raw.keys():
        values = raw.getlist(key)
        form[key] = values if len(values) > 1 else values[0]

    ultra: dict[str, Any] = {
        "enabled": _form_checkbox(form.get("protection_enabled")),
        "quarantineRoleId": pick_single_id(_form_list(form.get("quarantine_role_id"))),
        "whitelist": {
            "userIds": _form_list(form.get("whitelist_user_ids")),
            "roleIds": _form_list(form.get("whitelist_role_ids")),
        },
        "blacklist": {
            "userIds": _form_list(form.get("blacklist_user_ids")),
            "roleIds": _form_list(form.get("blacklist_role_ids")),
        },
        "schedule": {
            "enabled": _form_checkbox(form.get("schedule_enabled")),
            "startHour": _form_int(form.get("schedule_start_hour"), 0, 0, 23),
            "endHour": _form_int(form.get("schedule_end_hour"), 8, 0, 23),
        },
        "serverBackup": {
            "enabled": _form_checkbox(form.get("server_backup_enabled")),
            "autoCreateOnBoot": _form_checkbox(form.get("server_backup_auto_boot")),
        },
    }

    # Standard guards with advanced shape
    for guard_key in ("channelGuard", "categoryGuard"):
        prefix = "channel_guard" if guard_key == "channelGuard" else "category_guard"
        ultra[guard_key] = {
            "enabled": _form_checkbox(form.get(f"{prefix}_enabled")),
            "quarantine": _form_checkbox(form.get(f"{prefix}_quarantine")),
            "restoreOnDelete": _form_checkbox(form.get(f"{prefix}_restore_on_delete")),
            **_build_guard_advanced(form, prefix),
        }

    ultra["webhookGuard"] = {
        "enabled": _form_checkbox(form.get("webhook_guard_enabled")),
        "quarantine": _form_checkbox(form.get("webhook_guard_quarantine")),
        **_build_guard_advanced(form, "webhook_guard"),
    }

    ultra["botGuard"] = {
        "enabled": _form_checkbox(form.get("bot_guard_enabled")),
        "quarantine": _form_checkbox(form.get("bot_guard_quarantine")),
        "kickUnauthorizedBots": _form_checkbox(form.get("bot_guard_kick_unauthorized")),
        "allowedBotIds": _form_list(form.get("bot_guard_allowed_bot_ids")),
        **_build_guard_advanced(form, "bot_guard"),
    }

    ultra["guildSettingsGuard"] = {
        "enabled": _form_checkbox(form.get("guild_settings_guard_enabled")),
        "quarantine": _form_checkbox(form.get("guild_settings_guard_quarantine")),
        **_build_guard_advanced(form, "guild_settings_guard"),
    }

    ultra["bulkActionGuard"] = {
        "enabled": _form_checkbox(form.get("bulk_action_guard_enabled")),
        "quarantine": _form_checkbox(form.get("bulk_action_guard_quarantine")),
        "windowSeconds": _form_int(form.get("bulk_action_window_seconds"), 120, 30, 3600),
        "maxActions": _form_int(form.get("bulk_action_max_actions"), 3, 2, 100),
        **_build_guard_advanced(form, "bulk_action_guard"),
    }

    ultra["manualActionGuard"] = {
        "enabled": _form_checkbox(form.get("manual_action_guard_enabled")),
        "quarantine": _form_checkbox(form.get("manual_action_guard_quarantine")),
        **_build_guard_advanced(form, "manual_action_guard"),
    }

    # Role Guard
    role_perms_raw = _form_list(form.get("role_guard_restricted_permissions"))
    role_perms = [p for p in role_perms_raw if p in _GUARD_ROLE_PERMISSION_VALUES]
    ultra["roleGuard"] = {
        "enabled": _form_checkbox(form.get("role_guard_enabled")),
        "quarantine": _form_checkbox(form.get("role_guard_quarantine")),
        "restrictedPermissions": role_perms,
        "autoDeleteRiskyNewRoles": _form_checkbox(
            form.get("role_guard_auto_delete_risky_new_roles")
        ),
        "protectedRoleIds": _form_list(form.get("role_guard_protected_role_ids")),
        **_build_guard_advanced(form, "role_guard"),
    }

    # Anti-Raid Guard
    ultra["antiRaidGuard"] = {
        "enabled": _form_checkbox(form.get("anti_raid_guard_enabled")),
        "quarantine": _form_checkbox(form.get("anti_raid_guard_quarantine")),
        "windowSeconds": _form_int(
            form.get("anti_raid_guard_window_seconds"), 30, 10, 600
        ),
        "joinThreshold": _form_int(
            form.get("anti_raid_guard_join_threshold"), 8, 2, 200
        ),
        "minAccountAgeDays": _form_int(
            form.get("anti_raid_guard_min_account_age_days"), 7, 0, 365
        ),
        "raidAction": _form_enum(
            form.get("anti_raid_guard_raid_action"),
            _GUARD_ANTIRAID_ACTION_VALUES,
            "kick",
        ),
        "raidModeCooldownMinutes": _form_int(
            form.get("anti_raid_guard_raid_mode_cooldown_minutes"), 15, 1, 1440
        ),
        **_build_guard_advanced(form, "anti_raid_guard"),
    }

    # Invite/Link Guard
    ultra["inviteLinkGuard"] = {
        "enabled": _form_checkbox(form.get("invite_link_guard_enabled")),
        "quarantine": _form_checkbox(form.get("invite_link_guard_quarantine")),
        "blockDiscordInvites": _form_checkbox(
            form.get("invite_link_guard_block_discord_invites")
        ),
        "allowedDomains": _form_domain_list(form.get("invite_link_guard_allowed_domains")),
        "exemptChannelIds": _form_list(form.get("invite_link_guard_exempt_channel_ids")),
        "actionOnViolation": _form_enum(
            form.get("invite_link_guard_action_on_violation"),
            _GUARD_INVITE_ACTION_VALUES,
            "delete",
        ),
        **_build_guard_advanced(form, "invite_link_guard"),
    }

    # Message Nuke Guard
    ultra["messageNukeGuard"] = {
        "enabled": _form_checkbox(form.get("message_nuke_guard_enabled")),
        "quarantine": _form_checkbox(form.get("message_nuke_guard_quarantine")),
        "windowSeconds": _form_int(
            form.get("message_nuke_guard_window_seconds"), 30, 10, 600
        ),
        "deleteThreshold": _form_int(
            form.get("message_nuke_guard_delete_threshold"), 10, 3, 500
        ),
        "bulkDeleteThreshold": _form_int(
            form.get("message_nuke_guard_bulk_delete_threshold"), 2, 1, 50
        ),
        **_build_guard_advanced(form, "message_nuke_guard"),
    }

    # Settings Rollback Guard (no advanced block)
    rollback_fields_raw = _form_list(form.get("settings_rollback_guard_rollback_fields"))
    rollback_fields = [f for f in rollback_fields_raw if f in _GUARD_ROLLBACK_FIELD_VALUES]
    ultra["settingsRollbackGuard"] = {
        "enabled": _form_checkbox(form.get("settings_rollback_guard_enabled")),
        "rollbackFields": rollback_fields,
        "cooldownSeconds": _form_int(
            form.get("settings_rollback_guard_cooldown_seconds"), 30, 0, 3600
        ),
    }

    # AutoMod Guard
    ultra["autoModGuard"] = {
        "enabled": _form_checkbox(form.get("auto_mod_guard_enabled")),
        "blockLinks": _form_checkbox(form.get("auto_mod_guard_block_links")),
        "blockInvites": _form_checkbox(form.get("auto_mod_guard_block_invites")),
        "blockProfanity": _form_checkbox(form.get("auto_mod_guard_block_profanity")),
        "blockSpam": _form_checkbox(form.get("auto_mod_guard_block_spam")),
        "blockMassMentions": _form_checkbox(form.get("auto_mod_guard_block_mass_mentions")),
        "massMentionThreshold": _form_int(form.get("auto_mod_guard_mass_mention_threshold"), 5, 1, 50),
        "blockStaffMentions": _form_checkbox(form.get("auto_mod_guard_block_staff_mentions")),
        "exemptRoleIds": _form_list(form.get("auto_mod_guard_exempt_role_ids")),
        "exemptChannelIds": _form_list(form.get("auto_mod_guard_exempt_channel_ids")),
        "actionType": _form_enum(form.get("auto_mod_guard_action_type"), {"block", "timeout", "alert"}, "block"),
        "timeoutMinutes": _form_int(form.get("auto_mod_guard_timeout_minutes"), 10, 1, 40320),
        "alertChannelId": pick_single_id(_form_list(form.get("auto_mod_guard_alert_channel_id")))
    }

    save_config({"ultraProtection": ultra})
    return RedirectResponse("/guards?saved=1", status_code=303)


@app.post("/guards/backup")
def guards_backup():
    created_by = int(settings.owner_id) if settings.owner_id and settings.owner_id.isdigit() else None
    create_server_backup("manual", created_by)
    return RedirectResponse("/guards?backup_created=1", status_code=303)


@app.delete("/guards/backup/{backup_id}")
def guards_backup_delete(backup_id: int):
    delete_server_backup(backup_id)
    response = HTMLResponse()
    response.headers["HX-Refresh"] = "true"
    return response


@app.get("/settings")
def settings_page(request: Request):
    config = fetch_config()
    role_options = list_guild_roles()
    channel_options = list_guild_channels()
    role_picker_options = build_role_picker_options(role_options)
    channel_picker_options = build_channel_picker_options(channel_options)
    return render_page(
        request,
        "settings.html",
        config=config,
        role_picker_options=role_picker_options,
        voice_channel_picker_options=filter_channel_picker_options(
            channel_picker_options, {"voice", "stage"}
        ),
        non_category_channel_picker_options=filter_channel_picker_options(
            channel_picker_options, {"text", "announcement", "voice", "stage", "forum", "media", "other"}
        ),
        text_channel_picker_options=filter_channel_picker_options(
            channel_picker_options, {"text", "announcement"}
        ),
        category_picker_options=filter_channel_picker_options(channel_picker_options, {"category"}),
        selected_items=build_selected_picker_groups(
            config,
            role_picker_options,
            channel_picker_options,
        ),
        sync_status=get_message_history_sync_status(),
        saved=request.query_params.get("saved"),
        sync_requested=request.query_params.get("sync_requested"),
    )


@app.post("/settings")
def settings_save(
    staff_role_ids: list[str] | None = Form(None),
    upper_staff_role_ids: list[str] | None = Form(None),
    supervisor_role_ids: list[str] | None = Form(None),
    ban_role_ids: list[str] | None = Form(None),
    kick_role_ids: list[str] | None = Form(None),
    ticket_role_ids: list[str] | None = Form(None),
    afk_channel_id: list[str] | None = Form(None),
    ignored_channel_ids: list[str] | None = Form(None),
    ignored_category_ids: list[str] | None = Form(None),
    panel_channel_ids: list[str] | None = Form(None),
    active_category_mode: str = Form("auto"),
    category_parent_id: list[str] | None = Form(None),
    archive_category_mode: str = Form("auto"),
    archive_category_id: list[str] | None = Form(None),
    embed_image_url: str = Form(""),
    embed_title: str = Form(""),
    embed_description: str = Form(""),
    welcome_title: str = Form(""),
    welcome_description: str = Form(""),
    join_welcome_title: str = Form(""),
    join_welcome_description: str = Form(""),
    onboarding_question: str = Form(""),
    onboarding_yes_label: str = Form(""),
    onboarding_no_label: str = Form(""),
    call_cooldown_seconds: int = Form(600),
    stale_ticket_minutes: int = Form(120),
    unclaimed_ticket_minutes: int = Form(20),
    open_ticket_threshold: int = Form(15),
    unproven_target_role_ids: list[str] | None = Form(None),
    unproven_proof_channel_id: list[str] | None = Form(None),
):
    save_config(
        {
            "roles": {
                "staffRoleIds": normalize_picker_ids(staff_role_ids),
                "upperStaffRoleIds": normalize_picker_ids(upper_staff_role_ids),
                "supervisorRoleIds": normalize_picker_ids(supervisor_role_ids),
                "banRoleIds": normalize_picker_ids(ban_role_ids),
                "kickRoleIds": normalize_picker_ids(kick_role_ids),
                "ticketRoleIds": normalize_picker_ids(ticket_role_ids),
            },
            "voice": {
                "afkChannelId": pick_single_id(afk_channel_id),
                "ignoredChannelIds": normalize_picker_ids(ignored_channel_ids),
                "ignoredCategoryIds": normalize_picker_ids(ignored_category_ids),
            },
            "ticket": {
                "panelChannelIds": normalize_picker_ids(panel_channel_ids),
                "activeCategoryMode": active_category_mode if active_category_mode in {"auto", "manual"} else "auto",
                "categoryParentId": pick_single_id(category_parent_id),
                "archiveCategoryMode": archive_category_mode if archive_category_mode in {"auto", "manual"} else "auto",
                "archiveCategoryId": pick_single_id(archive_category_id),
                "embedImageUrl": embed_image_url.strip(),
                "embedTitle": embed_title,
                "embedDescription": embed_description,
                "welcomeTitle": welcome_title,
                "welcomeDescription": welcome_description,
                "joinWelcomeTitle": join_welcome_title,
                "joinWelcomeDescription": join_welcome_description,
                "onboardingQuestion": onboarding_question,
                "onboardingYesLabel": onboarding_yes_label,
                "onboardingNoLabel": onboarding_no_label,
                "callCooldownSeconds": call_cooldown_seconds,
            },
            "alerts": {
                "staleTicketMinutes": stale_ticket_minutes,
                "unclaimedTicketMinutes": unclaimed_ticket_minutes,
                "openTicketThreshold": open_ticket_threshold,
            },
            "unproven": {
                "targetRoleIds": normalize_picker_ids(unproven_target_role_ids),
                "proofChannelId": pick_single_id(unproven_proof_channel_id),
            },
        }
    )
    return RedirectResponse("/settings?saved=1", status_code=303)


@app.post("/settings/sync-history")
def settings_sync_history():
    requested_by = int(settings.owner_id) if settings.owner_id and settings.owner_id.isdigit() else None
    request_message_history_sync(requested_by)
    return RedirectResponse("/settings?sync_requested=1", status_code=303)


@app.get("/api/overview")
def overview_api(period: str = "day"):
    return get_overview(period)


@app.get("/api/staff")
def staff_api(period: str = "day"):
    return list_members("staff", period)


@app.get("/api/staff/{user_id}")
def staff_detail_api(user_id: int, period: str = "day"):
    return get_member_detail(user_id, "staff", period)


@app.get("/api/members")
def members_api(period: str = "day"):
    return list_members("user", period)


@app.get("/api/members/{user_id}")
def members_detail_api(user_id: int, period: str = "day"):
    return get_member_detail(user_id, "user", period)


@app.get("/api/tickets")
def tickets_api(period: str = "day"):
    return get_ticket_analytics(period)


@app.get("/api/actions")
def actions_api(period: str = "day"):
    return get_action_analytics(period)


@app.get("/api/voice")
def voice_api(period: str = "day"):
    return get_voice_analytics(period)


@app.get("/api/unproven")
def unproven_api(period: str = "day"):
    return get_unproven_actions(period)


@app.get("/api/settings")
def settings_api():
    return {
        "config": fetch_config(),
        "sync_status": get_message_history_sync_status(),
    }


@app.get("/yetki-duzenle")
def permissions_page(request: Request):
    config = fetch_config()
    role_options = list_guild_roles()
    role_picker_options = build_role_picker_options(role_options)
    moderation = config.get("moderation") or {}
    raw_policies = moderation.get("rolePolicies") or []
    policies = []
    for p in raw_policies:
        if not isinstance(p, dict):
            continue
        policies.append(
            {
                "roleId": str(p.get("roleId") or ""),
                "label": str(p.get("label") or ""),
                "capabilities": list(p.get("capabilities") or []),
                "dailyLimits": [
                    {"actionType": l.get("actionType"), "maxDaily": int(l.get("maxDaily") or 1)}
                    for l in (p.get("dailyLimits") or [])
                    if isinstance(l, dict)
                ],
                "autoPunishOnLimit": bool(p.get("autoPunishOnLimit", True)),
                "cooldownSeconds": int(p.get("cooldownSeconds") or 60),
            }
        )

    return render_page(
        request,
        "permissions.html",
        config=config,
        role_picker_options=role_picker_options,
        policies=policies,
        capability_options=POLICY_CAPABILITY_OPTIONS,
        action_type_options=POLICY_ACTION_TYPE_OPTIONS,
        strict_role_only=bool(moderation.get("strictRoleOnly", False)),
        admin_whitelist_ids=list(moderation.get("adminWhitelistUserIds") or []),
        saved=request.query_params.get("saved"),
    )


@app.post("/yetki-duzenle/save")
async def permissions_save(request: Request):
    raw = await request.form()
    form: dict[str, Any] = {}
    for key in raw.keys():
        values = raw.getlist(key)
        form[key] = values if len(values) > 1 else values[0]

    policies: list[dict[str, Any]] = []
    seen_indices: set[int] = set()
    for key in form.keys():
        if key.startswith("policy_") and "_role_id" in key:
            parts = key.split("_")
            if len(parts) >= 3:
                try:
                    idx = int(parts[1])
                    seen_indices.add(idx)
                except ValueError:
                    continue

    for idx in sorted(seen_indices):
        role_id = pick_single_id(_form_list(form.get(f"policy_{idx}_role_id")))
        if not role_id:
            continue
        caps_raw = _form_list(form.get(f"policy_{idx}_capabilities"))
        caps = [c for c in caps_raw if any(o["value"] == c for o in POLICY_CAPABILITY_OPTIONS)]
        limits: list[dict[str, Any]] = []
        for lkey in form.keys():
            if lkey.startswith(f"policy_{idx}_limit_action_"):
                try:
                    lidx = int(lkey.split("_")[-1])
                except ValueError:
                    continue
                action_type = str(form.get(lkey) or "")
                max_daily = _form_int(form.get(f"policy_{idx}_limit_max_{lidx}"), 5, 1, 999)
                if action_type and any(o["value"] == action_type for o in POLICY_ACTION_TYPE_OPTIONS):
                    limits.append({"actionType": action_type, "maxDaily": max_daily})
        policies.append(
            {
                "roleId": role_id,
                "label": str(form.get(f"policy_{idx}_label") or "").strip(),
                "capabilities": caps,
                "dailyLimits": limits,
                "autoPunishOnLimit": _form_checkbox(form.get(f"policy_{idx}_auto_punish")),
                "cooldownSeconds": _form_int(form.get(f"policy_{idx}_cooldown"), 60, 0, 3600),
            }
        )

    save_config(
        {
            "moderation": {
                "rolePolicies": policies,
                "strictRoleOnly": _form_checkbox(form.get("strict_role_only")),
                "adminWhitelistUserIds": _form_list(form.get("admin_whitelist_user_ids")),
            }
        }
    )
    return RedirectResponse("/yetki-duzenle?saved=1", status_code=303)

