export const MODEL_ALIASES = ["gemini", "ms", "jev", "luna"] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

export const PROVIDER_NAMES = ["polza", "openrouter"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];
