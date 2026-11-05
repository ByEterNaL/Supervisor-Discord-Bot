INSERT INTO config_entries (key, value)
VALUES (
  'supervisor.config',
  jsonb_build_object(
    'roles', jsonb_build_object(
      'staffRoleIds', jsonb_build_array(),
      'upperStaffRoleIds', jsonb_build_array(),
      'supervisorRoleIds', jsonb_build_array(),
      'banRoleIds', jsonb_build_array(),
      'kickRoleIds', jsonb_build_array()
    ),
    'voice', jsonb_build_object(
      'afkChannelId', NULL,
      'ignoredChannelIds', jsonb_build_array(),
      'ignoredCategoryIds', jsonb_build_array()
    ),
    'ticket', jsonb_build_object(
      'panelChannelIds', jsonb_build_array(),
      'activeCategoryMode', 'auto',
      'categoryParentId', NULL,
      'archiveCategoryMode', 'auto',
      'archiveCategoryId', NULL,
      'embedImageUrl', '',
      'embedTitle', 'Destek Talebi',
      'embedDescription', 'Destek almak için aşağıdaki butona basarak ticket oluşturabilirsiniz.',
      'welcomeTitle', 'Hoş geldin, {user}',
      'welcomeDescription', 'Destek ekibimiz kısa süre içinde sizinle iletişime geçecektir. Bu işlemi kapatmak için kapat düğmesine basın.',
      'onboardingQuestion', 'Katıl işlemleri için mi geldiniz?',
      'onboardingYesLabel', 'Evet',
      'onboardingNoLabel', 'Hayır',
      'callCooldownSeconds', 600
    ),
    'alerts', jsonb_build_object(
      'staleTicketMinutes', 120,
      'unclaimedTicketMinutes', 20,
      'openTicketThreshold', 15
    ),
    'unproven', jsonb_build_object(
      'targetRoleIds', jsonb_build_array(),
      'proofChannelId', NULL
    )
  )
)
ON CONFLICT (key) DO NOTHING;
