import { z } from 'zod';
import { openaiImageModelProfile } from './openai-image-provider';
import { openaiScriptModelProfile } from './openai-script-provider';

export const openaiGenerationProfileId =
  'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1';

export const openaiGenerationProfile = {
  profileId: openaiGenerationProfileId,
  provider: 'openai',
  scriptModel: openaiScriptModelProfile.modelId,
  imageModel: openaiImageModelProfile.modelId,
  colorMode: 'monochrome',
  maxImageCalls: 4,
  imageSettings: {
    size: '1024x1024',
    quality: 'low',
    outputFormat: 'png',
  },
} as const;

export const openaiGenerationSnapshotSchema = z.strictObject({
  profile_id: z.literal(openaiGenerationProfileId),
  is_mock: z.literal(false),
  max_cost_micro_usd: z.number().int().positive().safe(),
  max_image_calls: z.literal(openaiGenerationProfile.maxImageCalls),
  provider: z.literal(openaiGenerationProfile.provider),
  script_model: z.literal(openaiGenerationProfile.scriptModel),
  image_model: z.literal(openaiGenerationProfile.imageModel),
  color_mode: z.literal(openaiGenerationProfile.colorMode),
});

export type OpenAIGenerationSnapshot = z.infer<typeof openaiGenerationSnapshotSchema>;
