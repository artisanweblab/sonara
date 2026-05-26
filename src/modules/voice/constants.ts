export const WHISPER_MODELS = [
    'tiny',
    'base',
    'small',
    'medium',
    'large-v2',
    'large-v3',
] as const;

export type WhisperModel = typeof WHISPER_MODELS[number];

export type DeviceOption = 'auto' | 'cuda:0' | 'cuda:1' | 'cpu';

export const LANGUAGE_GROUPS: ReadonlyArray<{ label: string | null; codes: ReadonlyArray<string> }> = [
    { label: null, codes: ['auto'] },
    { label: 'Primary', codes: ['en'] },
    { label: 'European', codes: ['uk', 'de', 'fr', 'es', 'it', 'pl', 'pt', 'nl', 'sv', 'cs', 'sk', 'ro', 'hu', 'bg', 'el'] },
    { label: 'Asian', codes: ['zh', 'ja', 'ko', 'hi'] },
    { label: 'Other', codes: ['be', 'ru'] },
];

export const LANGUAGE_OPTIONS = LANGUAGE_GROUPS.flatMap(group => group.codes) as ReadonlyArray<string>;

export const LANGUAGE_LABELS: Record<string, string> = {
    auto: 'Auto-detect',
    uk: 'Ukrainian (Українська)',
    en: 'English',
    de: 'German (Deutsch)',
    fr: 'French (Français)',
    es: 'Spanish (Español)',
    it: 'Italian (Italiano)',
    pl: 'Polish (Polski)',
    zh: 'Chinese (中文)',
    ja: 'Japanese (日本語)',
    ko: 'Korean (한국어)',
    hi: 'Hindi (हिन्दी)',
    cs: 'Czech (Čeština)',
    sk: 'Slovak (Slovenčina)',
    nl: 'Dutch (Nederlands)',
    pt: 'Portuguese (Português)',
    ro: 'Romanian (Română)',
    hu: 'Hungarian (Magyar)',
    sv: 'Swedish (Svenska)',
    bg: 'Bulgarian (Български)',
    be: 'Belarusian (Беларуская)',
    el: 'Greek (Ελληνικά)',
    ru: 'Russian (Русский)',
};

export type SetupMode = 'gpu' | 'cpu';

export const MODEL_DESCRIPTIONS: Record<WhisperModel, { size: string; detail: string }> = {
    'tiny':     { size: '~75 MB',  detail: 'GPU: ~1 GB VRAM • CPU: ~10x realtime • Accuracy: low — good for testing.' },
    'base':     { size: '~145 MB', detail: 'GPU: ~1 GB VRAM • CPU: ~6x realtime • Accuracy: decent.' },
    'small':    { size: '~465 MB', detail: 'GPU: ~2 GB VRAM • CPU: ~2-3x realtime • Accuracy: good — balanced choice.' },
    'medium':   { size: '~1.5 GB', detail: 'GPU: ~5 GB VRAM • CPU: ~1x realtime (barely keeps up) • Accuracy: high.' },
    'large-v2': { size: '~3 GB',   detail: 'GPU: ~8-10 GB VRAM • CPU: ~0.3x realtime (slower than speech) • Accuracy: very high.' },
    'large-v3': { size: '~3 GB',   detail: 'GPU: ~8-10 GB VRAM • CPU: ~0.3x realtime (slower than speech) • Accuracy: best. Recommended for GPU.' },
};

export const VOICE_CONFIG_SECTION = 'sonara.voice';

export const VOICE_DEFAULTS = {
    model: 'large-v3' as WhisperModel,
    device: 'auto' as DeviceOption,
    computeType: 'auto',
    beamSize: 5,
    language: 'auto',
    vadFilter: true,
} as const;

export const GLOBAL_STATE_KEYS = {
    setupMode: 'sonara.voice.setupMode',
} as const;
