import { ChannelType, SlashCommandBuilder } from "discord.js";

export interface HelpCatalogSection {
  icon: string;
  title: string;
  lines: string[];
}

export const helpCommandSections: HelpCatalogSection[] = [
  {
    icon: "🎫",
    title: "Ticket ve Destek",
    lines: [
      "`/ticket create` Panel kanalına ticket arayüzü gönderir",
      "`/ticket claim` Bulunduğun ticket kanalını üstlenir"
    ]
  },
  {
    icon: "🛡️",
    title: "Üye Moderasyonu",
    lines: [
      "`/ban`, `/unban`, `/kick`, `/softban`",
      "`/timeout`, `/untimeout`, `/jail`, `/unjail`",
      "`/warn`, `/unwarn`, `/history`"
    ]
  },
  {
    icon: "🧹",
    title: "Kanal Moderasyonu",
    lines: [
      "`/purge` Filtreli mesaj temizliği yapar",
      "`/lock`, `/unlock` Kanal kilidini yönetir",
      "`/slowmode` Yavaş modu ayarlar"
    ]
  },
  {
    icon: "📈",
    title: "Seviye ve İstatistik",
    lines: [
      "`/rank` Şık seviye kartını herkes için açar",
      "`/leaderboard` Seviye sıralamasını görsel kartla gösterir",
      "`/supervisor stats` Günlük istatistik özetini verir"
    ]
  },
  {
    icon: "⚙️",
    title: "Yönetim ve Kurulum",
    lines: [
      "`/supervisor refresh-config` Config verisini yeniler",
      "`/moderson kurulum` Moderasyon rollerini ve ceza rollerini hazırlar",
      "`/moderson kaldir` Moderson kurulumunu temizler",
      "`/yardım` Bu komut rehberini gösterir"
    ]
  }
];

function buildModerationCommands() {
  return [
    new SlashCommandBuilder()
      .setName("ban")
      .setDescription("Kullanıcıyı sunucudan yasaklar")
      .addUserOption((option) => option.setName("uye").setDescription("Hedef üye").setRequired(true))
      .addStringOption((option) => option.setName("sebep").setDescription("İşlem sebebi"))
      .addIntegerOption((option) =>
        option
          .setName("mesaj_silme_gunu")
          .setDescription("Silinecek mesaj geçmişi gün sayısı")
          .setMinValue(0)
          .setMaxValue(7)
      )
      .addBooleanOption((option) =>
        option.setName("dm_bildir").setDescription("Üyeye DM bildirimi gönderilsin mi")
      )
      .addStringOption((option) => option.setName("kanit").setDescription("Kanıt bağlantısı"))
      .addBooleanOption((option) =>
        option.setName("global").setDescription("Tüm bot sunucularından banlansın mı?")
      ),
    new SlashCommandBuilder()
      .setName("unban")
      .setDescription("Yasaklı kullanıcının banını kaldırır")
      .addStringOption((option) =>
        option.setName("kullanici_id").setDescription("Banı kaldırılacak kullanıcı ID").setRequired(true)
      )
      .addStringOption((option) => option.setName("sebep").setDescription("İşlem sebebi"))
      .addBooleanOption((option) =>
        option.setName("dm_bildir").setDescription("Kullanıcıya DM bildirimi gönderilsin mi")
      ),
    new SlashCommandBuilder()
      .setName("kick")
      .setDescription("Kullanıcıyı sunucudan atar")
      .addUserOption((option) => option.setName("uye").setDescription("Hedef üye").setRequired(true))
      .addStringOption((option) => option.setName("sebep").setDescription("İşlem sebebi"))
      .addBooleanOption((option) =>
        option.setName("dm_bildir").setDescription("Üyeye DM bildirimi gönderilsin mi")
      )
      .addStringOption((option) => option.setName("kanit").setDescription("Kanıt bağlantısı")),
    new SlashCommandBuilder()
      .setName("timeout")
      .setDescription("Kullanıcıyı zaman aşımına alır")
      .addUserOption((option) => option.setName("uye").setDescription("Hedef üye").setRequired(true))
      .addIntegerOption((option) =>
        option
          .setName("sure_dakika")
          .setDescription("Timeout süresi dakika cinsinden")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(40320)
      )
      .addStringOption((option) => option.setName("sebep").setDescription("İşlem sebebi"))
      .addBooleanOption((option) =>
        option.setName("dm_bildir").setDescription("Üyeye DM bildirimi gönderilsin mi")
      )
      .addStringOption((option) => option.setName("kanit").setDescription("Kanıt bağlantısı")),
    new SlashCommandBuilder()
      .setName("untimeout")
      .setDescription("Aktif timeout cezasını kaldırır")
      .addUserOption((option) => option.setName("uye").setDescription("Hedef üye").setRequired(true))
      .addStringOption((option) => option.setName("sebep").setDescription("Kaldırma sebebi")),
    new SlashCommandBuilder()
      .setName("softban")
      .setDescription("Üyeyi banlayıp hemen banını kaldırır")
      .addUserOption((option) => option.setName("uye").setDescription("Hedef üye").setRequired(true))
      .addStringOption((option) => option.setName("sebep").setDescription("İşlem sebebi"))
      .addIntegerOption((option) =>
        option
          .setName("mesaj_silme_gunu")
          .setDescription("Silinecek mesaj geçmişi gün sayısı")
          .setMinValue(0)
          .setMaxValue(7)
      )
      .addBooleanOption((option) =>
        option.setName("dm_bildir").setDescription("Üyeye DM bildirimi gönderilsin mi")
      ),
    new SlashCommandBuilder()
      .setName("warn")
      .setDescription("Kullanıcıya kalıcı uyarı verir")
      .addUserOption((option) => option.setName("uye").setDescription("Hedef üye").setRequired(true))
      .addStringOption((option) => option.setName("sebep").setDescription("Uyarı sebebi"))
      .addIntegerOption((option) =>
        option.setName("puan").setDescription("Uyarı puanı").setMinValue(1).setMaxValue(100)
      )
      .addBooleanOption((option) =>
        option.setName("dm_bildir").setDescription("Üyeye DM bildirimi gönderilsin mi")
      )
      .addStringOption((option) => option.setName("kanit").setDescription("Kanıt bağlantısı")),
    new SlashCommandBuilder()
      .setName("unwarn")
      .setDescription("Bir warn vakasını kaldırır")
      .addIntegerOption((option) => option.setName("vaka_id").setDescription("Kaldırılacak vaka ID").setRequired(true))
      .addStringOption((option) => option.setName("sebep").setDescription("Kaldırma sebebi")),
    new SlashCommandBuilder()
      .setName("history")
      .setDescription("Üyeye ait moderasyon geçmişini gösterir")
      .addUserOption((option) => option.setName("uye").setDescription("Geçmişi gösterilecek üye").setRequired(true)),
    new SlashCommandBuilder()
      .setName("jail")
      .setDescription("Üyeyi jail rolüne düşürür")
      .addUserOption((option) => option.setName("uye").setDescription("Hedef üye").setRequired(true))
      .addIntegerOption((option) =>
        option
          .setName("sure_dakika")
          .setDescription("Jail süresi dakika cinsinden")
          .setMinValue(1)
          .setMaxValue(40320)
      )
      .addStringOption((option) => option.setName("sebep").setDescription("İşlem sebebi"))
      .addBooleanOption((option) =>
        option.setName("dm_bildir").setDescription("Üyeye DM bildirimi gönderilsin mi")
      ),
    new SlashCommandBuilder()
      .setName("unjail")
      .setDescription("Aktif jail cezasını kaldırır")
      .addUserOption((option) => option.setName("uye").setDescription("Hedef üye").setRequired(true))
      .addStringOption((option) => option.setName("sebep").setDescription("Kaldırma sebebi")),
    new SlashCommandBuilder()
      .setName("purge")
      .setDescription("Kanaldaki mesajları filtreli şekilde temizler")
      .addIntegerOption((option) =>
        option.setName("sayi").setDescription("Maksimum silinecek mesaj sayısı").setRequired(true).setMinValue(1).setMaxValue(1000)
      )
      .addChannelOption((option) =>
        option
          .setName("kanal")
          .setDescription("Temizlenecek kanal")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.PublicThread,
            ChannelType.PrivateThread
          )
      )
      .addUserOption((option) => option.setName("uye").setDescription("Sadece bu üyenin mesajları"))
      .addBooleanOption((option) =>
        option.setName("sadece_bot").setDescription("Sadece bot mesajlarını temizle")
      )
      .addBooleanOption((option) =>
        option.setName("link_icerikleri").setDescription("Sadece link içeren mesajları temizle")
      )
      .addBooleanOption((option) =>
        option.setName("dosya_icerikleri").setDescription("Sadece dosya içeren mesajları temizle")
      ),
    new SlashCommandBuilder()
      .setName("lock")
      .setDescription("Kanal kilidi uygular")
      .addChannelOption((option) =>
        option
          .setName("kanal")
          .setDescription("Kilidi uygulanacak kanal")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.GuildVoice,
            ChannelType.GuildStageVoice,
            ChannelType.GuildForum
          )
      )
      .addStringOption((option) => option.setName("sebep").setDescription("İşlem sebebi")),
    new SlashCommandBuilder()
      .setName("unlock")
      .setDescription("Kanal kilidini kaldırır")
      .addChannelOption((option) =>
        option
          .setName("kanal")
          .setDescription("Kilidi kaldırılacak kanal")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.GuildVoice,
            ChannelType.GuildStageVoice,
            ChannelType.GuildForum
          )
      )
      .addStringOption((option) => option.setName("sebep").setDescription("Kaldırma sebebi")),
    new SlashCommandBuilder()
      .setName("slowmode")
      .setDescription("Kanal yavaş modunu ayarlar")
      .addIntegerOption((option) =>
        option
          .setName("saniye")
          .setDescription("Yeni yavaş mod saniyesi")
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(21600)
      )
      .addChannelOption((option) =>
        option
          .setName("kanal")
          .setDescription("Yavaş modu ayarlanacak kanal")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.GuildForum
          )
      )
      .addStringOption((option) => option.setName("sebep").setDescription("İşlem sebebi"))
  ];
}

export const moderationCommandNames = new Set([
  "ban",
  "unban",
  "kick",
  "timeout",
  "untimeout",
  "softban",
  "warn",
  "unwarn",
  "history",
  "jail",
  "unjail",
  "purge",
  "lock",
  "unlock",
  "slowmode"
]);

export const helpCommandName = "yardım";

export function buildCommandDefinitions() {
  return [
    new SlashCommandBuilder()
      .setName("ticket")
      .setDescription("Ticket komutları")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("create")
          .setDescription("Seçilen kanala ticket paneli gönderir")
          .addChannelOption((option) =>
            option
              .setName("kanal")
              .setDescription("Ticket panelinin gönderileceği kanal")
              .addChannelTypes(ChannelType.GuildText)
              .setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("claim").setDescription("Bulunduğun ticket kanalını claim alır")
      ),
    ...buildModerationCommands(),
    new SlashCommandBuilder()
      .setName("mod")
      .setDescription("Eski moderasyon uyumluluk komutu")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("ban")
          .setDescription("Kullanıcıyı yasaklar")
          .addUserOption((option) =>
            option.setName("uye").setDescription("Yasaklanacak üye").setRequired(true)
          )
          .addStringOption((option) =>
            option.setName("sebep").setDescription("Yasaklama sebebi").setRequired(false)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("kick")
          .setDescription("Kullanıcıyı sunucudan atar")
          .addUserOption((option) =>
            option.setName("uye").setDescription("Atılacak üye").setRequired(true)
          )
          .addStringOption((option) =>
            option.setName("sebep").setDescription("Atma sebebi").setRequired(false)
          )
      ),
    new SlashCommandBuilder()
      .setName("rank")
      .setDescription("Kullanıcının ses ve metin seviyesini görsel kartla gösterir")
      .setDefaultMemberPermissions(null)
      .addUserOption((option) =>
        option.setName("uye").setDescription("Seviyesi gösterilecek üye").setRequired(false)
      )
      .addStringOption((option) =>
        option
          .setName("tur")
          .setDescription("Gösterilecek seviye türü")
          .setRequired(false)
          .addChoices(
            { name: "İkisi", value: "ikisi" },
            { name: "Ses", value: "ses" },
            { name: "Metin", value: "metin" }
          )
      ),
    new SlashCommandBuilder()
      .setName("leaderboard")
      .setDescription("Ses veya metin seviye sıralamasını görsel kartla açar")
      .setDefaultMemberPermissions(null)
      .addStringOption((option) =>
        option
          .setName("kapsam")
          .setDescription("Üye veya yetkili sıralaması")
          .setRequired(false)
          .addChoices(
            { name: "Üye", value: "uye" },
            { name: "Yetkili", value: "yetkili" }
          )
      )
      .addStringOption((option) =>
        option
          .setName("tur")
          .setDescription("Sıralama türü")
          .setRequired(false)
          .addChoices(
            { name: "Ses", value: "ses" },
            { name: "Metin", value: "metin" }
          )
      ),
    new SlashCommandBuilder()
      .setName("supervisor")
      .setDescription("Supervisor komutları")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("stats")
          .setDescription("Günlük özet istatistiği gösterir")
          .addUserOption((option) =>
            option.setName("uye").setDescription("Özetini göreceğin üye").setRequired(false)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("refresh-config").setDescription("Veritabanından config yeniler")
      ),
    new SlashCommandBuilder()
      .setName("moderson")
      .setDescription("Moderasyon sistem kurulum komutları")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("kurulum")
          .setDescription("Varsayılan moderasyon rollerini ve kanal kısıtlarını kurar")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("kaldir")
          .setDescription("Moderson kurulumunun açtığı rolleri ve varsayılan bağları kaldırır")
      ),
    new SlashCommandBuilder()
      .setName(helpCommandName)
      .setDescription("Sistemdeki komutları kategorili olarak gösterir")
      .setDefaultMemberPermissions(null)
  ].map((builder) => builder.toJSON());
}
