import manifestJson from '../voiceover/manifest.json';

/** Сколько ячеек игра спрашивает после рисования. */
export const QUIZ_SIZE = 9;

interface ManifestRound {
  round: number;
  persona: string;
  dictation: string;
  dictation_ms: number;
  lines: Record<'time_30s' | 'quiz_intro', { clip: string }>;
  cells: { cell: number; word: string; number_start_ms: number; number_ms: number }[];
}

export interface CellInfo {
  word: string;
  /** Где в дорожке диктовки звучит номер ячейки. */
  numberStartMs: number;
  numberMs: number;
}

export interface RoundInfo {
  round: number;
  /** Кто диктует, для подписи «Диктует …». */
  narrator: string;
  dictationUrl: string;
  dictationMs: number;
  time30sUrl: string;
  quizIntroUrl: string;
  /** Индекс в массиве = номер ячейки − 1. */
  cells: CellInfo[];
}

// Ключ — persona из манифеста озвучки.
const NARRATORS: Record<string, string> = {
  'Art teacher': 'учительница рисования',
  'Late-night radio host': 'ночной радиоведущий',
  'Sports commentator': 'спортивный комментатор',
  "Children's party host": 'ведущая детского праздника',
  'Old sea captain': 'старый морской капитан',
  'Tired station announcer': 'диктор вокзала после двойной смены',
  'Drill sergeant': 'строгий сержант',
  'Keeper of secrets': 'хранительница секретов',
  'Scatterbrained old professor': 'рассеянный профессор',
  'Storytelling grandmother': 'бабушка-сказочница',
  'TV news anchor': 'диктор центрального телевидения',
  'Fitness coach': 'фитнес-тренер',
  'Film noir detective': 'детектив из нуара',
  'Museum guide': 'экскурсовод',
  'Fairground barker': 'ярмарочный зазывала',
  Robot: 'робот',
};

const voiceover = (path: string) => `${import.meta.env.BASE_URL}voiceover/${path}`;

const manifest = manifestJson as unknown as { rounds: Record<string, ManifestRound> };

export const ROUNDS: RoundInfo[] = Object.values(manifest.rounds)
  .sort((a, b) => a.round - b.round)
  .map((r) => ({
    round: r.round,
    narrator: NARRATORS[r.persona] ?? 'таинственный голос',
    dictationUrl: voiceover(r.dictation),
    dictationMs: r.dictation_ms,
    time30sUrl: voiceover(r.lines.time_30s.clip),
    quizIntroUrl: voiceover(r.lines.quiz_intro.clip),
    cells: [...r.cells]
      .sort((a, b) => a.cell - b.cell)
      .map((c) => ({ word: c.word, numberStartMs: c.number_start_ms, numberMs: c.number_ms })),
  }));
