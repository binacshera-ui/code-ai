export type ThemePresetId =
  | 'classic'
  | 'cream'
  | 'mist'
  | 'mint'
  | 'lemon'
  | 'peach'
  | 'blush'
  | 'lavender'
  | 'sky'
  | 'sage'
  | 'sand';

export interface ThemePreset {
  id: ThemePresetId;
  label: string;
  description: string;
  colors: {
    canvas: string;
    panel: string;
    soft: string;
    softStrong: string;
    border: string;
    text: string;
    muted: string;
    faint: string;
    accentSoft: string;
    accentStrong: string;
  };
}

export const DEFAULT_THEME_PRESET_ID: ThemePresetId = 'classic';

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'classic',
    label: 'קלאסי',
    description: 'המראה המקורי הבהיר של המערכת.',
    colors: {
      canvas: '#FAFAFA',
      panel: '#FFFFFF',
      soft: '#F8FAFC',
      softStrong: '#F1F5F9',
      border: '#E2E8F0',
      text: '#0F172A',
      muted: '#475569',
      faint: '#94A3B8',
      accentSoft: '#EEF2FF',
      accentStrong: '#4F46E5',
    },
  },
  {
    id: 'cream',
    label: 'קרם',
    description: 'רקע ונילי שקט ונעים.',
    colors: {
      canvas: '#FBF6EE',
      panel: '#FFFDF9',
      soft: '#F5EDE0',
      softStrong: '#EEDFCB',
      border: '#E8D8C2',
      text: '#2F261F',
      muted: '#6E6258',
      faint: '#9B8E80',
      accentSoft: '#F4E1C3',
      accentStrong: '#C89A5B',
    },
  },
  {
    id: 'mist',
    label: 'ענן',
    description: 'אפור־כחלחל עדין ומאוורר.',
    colors: {
      canvas: '#F4F7FB',
      panel: '#FCFEFF',
      soft: '#E8EEF5',
      softStrong: '#DAE3EE',
      border: '#D3DDE9',
      text: '#24313F',
      muted: '#5C6B7B',
      faint: '#8694A3',
      accentSoft: '#DDEAF9',
      accentStrong: '#6B8FB8',
    },
  },
  {
    id: 'mint',
    label: 'מנטה',
    description: 'ירקרק־פסטלי קריר ורענן.',
    colors: {
      canvas: '#F2FBF7',
      panel: '#FBFEFC',
      soft: '#E2F4EC',
      softStrong: '#D2EBDD',
      border: '#C6E2D4',
      text: '#1F342C',
      muted: '#57756A',
      faint: '#81A096',
      accentSoft: '#D7F0E5',
      accentStrong: '#59A985',
    },
  },
  {
    id: 'lemon',
    label: 'לימון',
    description: 'צהוב־חמאה רך ובהיר.',
    colors: {
      canvas: '#FFFBEF',
      panel: '#FFFEFA',
      soft: '#FBF2CC',
      softStrong: '#F6E7AA',
      border: '#EADFAF',
      text: '#3A3118',
      muted: '#7A6A38',
      faint: '#A49563',
      accentSoft: '#F8ECBC',
      accentStrong: '#C5A93D',
    },
  },
  {
    id: 'peach',
    label: 'אפרסק',
    description: 'כתום־אפרסקי רך וחמים.',
    colors: {
      canvas: '#FFF5EF',
      panel: '#FFFDFC',
      soft: '#F9E5D8',
      softStrong: '#F2D1BE',
      border: '#E8C7B1',
      text: '#3A251B',
      muted: '#7D5A4B',
      faint: '#A58171',
      accentSoft: '#F6D9C8',
      accentStrong: '#C87A57',
    },
  },
  {
    id: 'blush',
    label: 'סומק',
    description: 'ורוד־אבקתי רגוע ומעודן.',
    colors: {
      canvas: '#FFF4F7',
      panel: '#FFFDFE',
      soft: '#F7E2E8',
      softStrong: '#F0D0D9',
      border: '#E7C3CD',
      text: '#3A232C',
      muted: '#7C5966',
      faint: '#A2838E',
      accentSoft: '#F4D9E1',
      accentStrong: '#C67590',
    },
  },
  {
    id: 'lavender',
    label: 'לבנדר',
    description: 'סגול־פסטלי רך ונקי.',
    colors: {
      canvas: '#F7F4FF',
      panel: '#FDFCFF',
      soft: '#E9E3F8',
      softStrong: '#DDD3F0',
      border: '#D0C4E8',
      text: '#2E2440',
      muted: '#645978',
      faint: '#8C82A0',
      accentSoft: '#E4DBF8',
      accentStrong: '#8C6CC6',
    },
  },
  {
    id: 'sky',
    label: 'שמים',
    description: 'תכלת בהיר ונקי.',
    colors: {
      canvas: '#F2F8FF',
      panel: '#FCFEFF',
      soft: '#E1EDF9',
      softStrong: '#CFE1F4',
      border: '#C4D7EC',
      text: '#213242',
      muted: '#5A7288',
      faint: '#8399AE',
      accentSoft: '#D8EAFB',
      accentStrong: '#5C8FC7',
    },
  },
  {
    id: 'sage',
    label: 'מרווה',
    description: 'ירוק־אבן שקט ובוגר.',
    colors: {
      canvas: '#F4F8F1',
      panel: '#FDFFFC',
      soft: '#E3EBDD',
      softStrong: '#D2DEC9',
      border: '#C6D2BC',
      text: '#273126',
      muted: '#63705F',
      faint: '#8B9886',
      accentSoft: '#D7E6CF',
      accentStrong: '#739167',
    },
  },
  {
    id: 'sand',
    label: 'חול',
    description: 'בז׳־פודרה חמים ומינימלי.',
    colors: {
      canvas: '#FAF5EF',
      panel: '#FFFDFA',
      soft: '#EEE5DB',
      softStrong: '#E0D3C4',
      border: '#D7C8B8',
      text: '#322A22',
      muted: '#6B5F55',
      faint: '#95877A',
      accentSoft: '#EADBC8',
      accentStrong: '#AA7F57',
    },
  },
];

export const THEME_PRESET_MAP = Object.fromEntries(
  THEME_PRESETS.map((preset) => [preset.id, preset])
) as Record<ThemePresetId, ThemePreset>;
