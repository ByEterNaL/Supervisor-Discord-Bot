export interface VoiceLikeState {
  channelId: string | null;
  parentId?: string | null;
  selfMute: boolean;
  serverMute: boolean;
  selfDeaf: boolean;
  serverDeaf: boolean;
  streaming: boolean;
  selfVideo: boolean;
}

export interface VoiceTrackingConfig {
  afkChannelId: string | null;
  ignoredChannelIds: string[];
  ignoredCategoryIds: string[];
}

export function isTrackedChannel(channelId: string | null, parentId: string | null | undefined, config: VoiceTrackingConfig) {
  if (!channelId) {
    return false;
  }
  if (config.afkChannelId && channelId === config.afkChannelId) {
    return false;
  }
  if (config.ignoredChannelIds.includes(channelId)) {
    return false;
  }
  if (parentId && config.ignoredCategoryIds.includes(parentId)) {
    return false;
  }
  return true;
}

export function isVoiceActive(state: VoiceLikeState, config: VoiceTrackingConfig) {
  return (
    isTrackedChannel(state.channelId, state.parentId ?? null, config) &&
    !state.selfMute &&
    !state.serverMute &&
    !state.selfDeaf &&
    !state.serverDeaf
  );
}

export function isCameraActive(state: VoiceLikeState, config: VoiceTrackingConfig) {
  return isTrackedChannel(state.channelId, state.parentId ?? null, config) && state.selfVideo;
}

export function isStreamActive(state: VoiceLikeState, config: VoiceTrackingConfig) {
  return isTrackedChannel(state.channelId, state.parentId ?? null, config) && state.streaming;
}

