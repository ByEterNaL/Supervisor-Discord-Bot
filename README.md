<div align="center">

# 🛡️ Supervisor Discord Bot & Analytics Platform

**Kurumsal Düzeyde Discord Yetkili Denetimi, Sunucu Koruma (Guard), SLA Destekli Ticket ve Gerçek Zamanlı Analitik Platformu**  
*Enterprise-Grade Discord Staff Supervision, Guard Engine, Ticket SLA & Real-Time Analytics Suite*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14.22-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.js.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-Analytics_Panel-009688?style=for-the-badge&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16_(Partitioned)-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/BullMQ_%26_Redis-Worker_Queue-DC382D?style=for-the-badge&logo=redis&logoColor=white)](https://bullmq.io/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)

</div>

---

## 🌟 Genel Bakış (Overview)

**Supervisor Discord Bot**, büyük ölçekli Discord topluluklarında yetkili (staff) performansını ölçmek, ses/mesaj/moderasyon aktivitelerini denetlemek, SLA (Hizmet Seviyesi) tabanlı destek biletlerini (Ticket) yönetmek ve sunucu güvenliğini (Guard) sağlamak üzere **servis odaklı (multi-service) mimariyle** geliştirilmiş tam kapsamlı bir yönetim platformudur.

Sıradan tek dosyalık botların aksine; **gerçek zamanlı olay işleme (`services/bot`)**, **arka plan veri toplulaştırma ve alarm kuyrukları (`services/worker` - BullMQ)**, **bölümlendirilmiş (partitioned) ilişkisel veritabanı (`PostgreSQL`)** ve **modern web yönetim/analitik paneli (`services/panel` - FastAPI)** olmak üzere 4 ana katmandan oluşur.

---

## 🏗️ Sistem Mimarisi (Architecture)

```mermaid
flowchart LR
    subgraph Discord["Discord Gateway & API"]
        Events["Mesaj / Ses / Ticket / Moderasyon Olayları"]
        Slash["Slash Komutları & İnteraktif Paneller"]
    end

    subgraph Core["Node.js / TypeScript Katmanı"]
        Bot["🤖 Bot Servisi\n(services/bot)"]
        Worker["⚙️ BullMQ Worker\n(services/worker)"]
        Shared["📦 Shared Paket\n(packages/shared)"]
    end

    subgraph Data["Veri & Kuyruk Katmanı"]
        PG[("🐘 PostgreSQL 16\n(20 Migration + Partitioning)")]
        Redis[("⚡ Redis 7\n(BullMQ Kuyruk & Önbellek)")]
    end

    subgraph Web["Python / Web Katmanı"]
        Panel["📊 FastAPI Yönetim & Analitik Paneli\n(services/panel)"]
    end

    Events --> Bot
    Bot --> Slash
    Bot <--> Shared
    Worker <--> Shared
    Bot --> PG
    Bot <--> Redis
    Redis <--> Worker
    Worker --> PG
    Panel <--> PG
```

---

## ✨ Temel Özellikler (Key Features)

### 1. 📊 Yetkili (Staff) Denetimi ve Performans Analitiği
- **Ses ve Aktiflik Takibi (`Presence & Voice Tracking`):** Yetkililerin ses kanallarındaki aktif/kulaklık kapalı/mikrofon kapalı sürelerini, AFK kanalı ayrımını ve oturum doğrulamalarını saniyesi saniyesine kaydeder.
- **Yetkili Karşılaştırma (`Staff Compare`):** İki veya daha fazla yetkilinin mesaj, ses, çözdüğü ticket ve uyguladığı moderasyon işlemlerini grafiksel olarak kıyaslar.
- **Kanıtsız İşlem Denetimi (`Unproven Actions Audit`):** Yetkililerin uyguladığı ban/kick/timeout işlemlerini kanıt kanalıyla eşleştirir; kanıtı eksik işlemleri tespit edip raporlar.
- **Yetkili Mesaj Denetimi (`Staff Message Audit`):** Yetkili iletişim kalitesini ve kanal bazlı etkileşim yoğunluğunu analiz eder.

### 2. 🎫 SLA Destekli Akıllı Ticket (Destek) Sistemi
- **Otomatik Karşılama & Onboarding Soruları:** Kullanıcı ticket açtığında dinamik butonlarla ön bilgi toplar ve ilgili yetkili rolünü bilgilendirir.
- **SLA ve Gecikme Alarmları (`Worker Rollups`):** Sahipsiz kalan (`unclaimed`) veya yanıt süresi aşımına uğrayan (`stale`) destek talepleri için arka plan worker'ı üzerinden otomatik uyarı üretir.
- **Arşivleme ve Transkript:** Kapatılan talepleri otomatik arşiv kategorisine taşır ve geçmiş istatistiklere işler.

### 3. 🛡️ Ultra Sunucu Koruma (Guard Engine) ve Moderasyon
- **Rol, Kanal ve Yetki Koruması:** İzinsiz kanal silme, rol değiştirme veya toplu ban/kick girişimlerini gerçek zamanlı yakalar, işlemi geri alır ve denetim loglarına (`guard_logs`) kaydeder.
- **Kademeli Moderasyon Limitleri:** Rol bazlı günlük/saatlik ban, kick ve susturma (timeout) kotaları tanımlar.
- **AutoMod & Filtre Motoru:** Discord AutoMod entegrasyonu ve özelleştirilebilir kelime/bağlantı filtreleri.
- **Vaka (Case) Yönetimi:** Her moderasyon işlemini benzersiz vaka numarası, geçmişi ve kanıtlarıyla arşivler.

### 4. 🏆 Canvas Tabanlı Seviye (Rank / XP) Sistemi
- **`@napi-rs/canvas` Görsel Motoru:** Kullanıcılar için yüksek çözünürlüklü, dinamik seviye kartları (`Rank Card`) ve canlı liderlik tabloları (`Leaderboard`) çizer.
- **Otomatik Terfi ve Görevler:** Ses ve mesaj aktifliğine göre XP kazanımı, seviye rolleri ve periyodik sıfırlama/ödül döngüleri.

### 5. 🖥️ FastAPI Web Yönetim ve Analitik Paneli (`Neon Grid HQ`)
Tarayıcı üzerinden çalışan kapsamlı kontrol merkezi:
- `/overview` — Sunucu genel durumu, aktif yetkililer ve anlık metrikler
- `/staff` & `/staff/compare` — Yetkili performans karneleri ve karşılaştırma tablosu
- `/voice` & `/channel-analysis` — Ses trafiği ve kanal bazlı yoğunluk analizi
- `/tickets` & `/unproven` — Destek talebi SLA metrikleri ve kanıtsız işlem takibi
- `/guards` & `/guard-logs` — Koruma kalkanı kuralları ve ihlal kayıtları
- `/moderation-history` & `/moderation-limits` — Ceza arşivi ve kota ayarları
- `/rank-board` & `/rank-settings` — XP/Seviye liderlik tablosu ve yapılandırması

---

## 📂 Proje Dizini (Project Structure)

```text
supervisor-discord-bot/
├── db/
│   └── migrations/              # 001..020 PostgreSQL şema, partition ve varsayılan ayar migration'ları
├── packages/
│   └── shared/                  # Ortak TypeScript tipleri, Zod şemaları, DB/Redis bağlantıları, Pino logger
├── scripts/
│   ├── apply-migrations.ts      # Otomatik SQL migration çalıştırıcı
│   ├── ensure-local-postgres.ps1# Windows için yerel PostgreSQL otomatik hazırlayıcı
│   └── sync-commands.ts         # Discord Slash komutlarını senkronize etme aracı
├── services/
│   ├── bot/                     # Discord.js v14 Bot Servisi (Events, Commands, Guard, Ticket, Rank, Mod)
│   ├── worker/                  # BullMQ Arka Plan İşçisi (Günlük/Haftalık/Aylık Rollup & SLA Alarmları)
│   └── panel/                   # FastAPI + Jinja2 + Modern CSS Web Analitik ve Yönetim Paneli
├── docker-compose.yml           # PostgreSQL 16 + Redis 7 + Bot + Worker + Panel konteyner orkestrasyonu
├── Dockerfile.node              # Node.js / TypeScript servisleri için Docker imajı
├── settings.example.json        # Örnek çalışma zamanı yapılandırma şablonu
├── .env.example                 # Örnek ortam değişkenleri şablonu
├── start.bat                    # Windows için tek tıkla kurulum, migration ve başlatma betiği
└── update.bat                   # Otomatik güncelleme betiği
```

---

## 🚀 Hızlı Başlangıç (Quick Start)

### Seçenek A: Windows Üzerinde Tek Tıkla Kurulum (`start.bat`)

1. **Ön Koşullar:** Bilgisayarınızda **Node.js (v20+)** ve **Python (3.11+)** kurulu olmalıdır.
2. **Yapılandırma:**
   `settings.example.json` dosyasını `settings.json` adıyla kopyalayın ve Discord / veritabanı bilgilerinizi girin:
   ```json
   {
     "discord": {
       "token": "YOUR_DISCORD_BOT_TOKEN",
       "clientId": "YOUR_DISCORD_APPLICATION_ID",
       "guildId": "YOUR_DISCORD_GUILD_ID",
       "ownerId": "YOUR_DISCORD_OWNER_ID"
     },
     "runtime": {
       "databaseUrl": "postgres://postgres:postgres@127.0.0.1:5432/discord_supervisor",
       "redisUrl": "",
       "timezone": "Europe/Istanbul",
       "logLevel": "info"
     },
     "panel": {
       "host": "127.0.0.1",
       "port": 8000
     }
   }
   ```
3. **Başlatma:**
   `start.bat` dosyasına çift tıklayın. Betik otomatik olarak:
   - Node.js ve Python sanal ortam (`.venv`) bağımlılıklarını kurar,
   - Yerel PostgreSQL veritabanını hazırlar ve `db/migrations` altındaki 20 SQL şemasını uygular,
   - **Bot**, **Worker** ve **Web Paneli** servislerini başlatıp tarayıcınızda `http://127.0.0.1:8000/overview` adresini açar.

---

### Seçenek B: Docker Compose ile Kurulum

1. `.env.example` dosyasını `.env` olarak kopyalayıp gerekli değişkenleri doldurun:
   ```bash
   cp .env.example .env
   ```
2. Tüm servisleri (`postgres`, `redis`, `bot`, `worker`, `panel`) ayağa kaldırın:
   ```bash
   docker compose up --build -d
   ```

---

### Seçenek C: Manuel Geliştirici Kurulumu (CLI)

```bash
# 1. Node bağımlılıklarını yükleyin
npm install

# 2. Veritabanı migration'larını uygulayın
npm run migrate

# 3. Slash komutlarını Discord API'ye senkronize edin
npm run sync-commands

# 4. Bot ve Worker servislerini başlatın
npm run bot
npm run worker

# 5. FastAPI Web Panelini başlatın
python -m venv .venv
.venv\Scripts\activate
pip install -r services/panel/requirements.txt
uvicorn app.main:app --app-dir services/panel --host 127.0.0.1 --port 8000
```

---

## 🧪 Testler ve Doğrulama (Testing & Verification)

Proje, servis mantığını ve komut senkronizasyonunu doğrulayan **Vitest** birim testleri içerir:

```bash
# Birim testlerini çalıştır
npm test

# TypeScript tip kontrolü ve derleme
npm run build
```

---

## 🔒 Güvenlik Notları (Security)

- `settings.json` ve `.env` dosyaları `.gitignore` ile koruma altındadır; bot tokenlarınızı veya veritabanı parolalarınızı asla versiyon kontrolüne dahil etmeyin.
- Web paneli varsayılan olarak yerel arayüze (`127.0.0.1`) bağlanacak şekilde yapılandırılmıştır.

---

## 📄 Lisans (License)

Bu proje **MIT Lisansı** altında lisanslanmıştır.
