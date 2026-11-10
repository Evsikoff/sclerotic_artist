import musicUrl from '../music/Midday_at_the_Atelier.mp3';

const MUSIC_VOLUME = 0.5;
/** Под голосом: номера ячеек в опросе должно быть хорошо слышно. */
const MUSIC_QUIET = 0.2;
const BUFFER_CACHE = 12;

export interface Voice {
  ended: Promise<void>;
  stop(): void;
}

type Sfx = 'tick' | 'go' | 'correct' | 'wrong';

/**
 * Весь звук игры. Голос и эффекты идут через Web Audio: их можно запускать без жеста игрока
 * и ставить на паузу вместе с часами раунда. Музыка — потоковый <audio>, подключённый к тому же контексту.
 */
class GameAudio {
  ctx!: AudioContext;
  private readonly music = new Audio(musicUrl);
  private musicGain!: GainNode;
  private musicWanted = false;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();

  constructor() {
    this.music.loop = true;
    this.music.preload = 'auto';
  }

  /** Вызывать только из обработчика нажатия: браузеры разрешают звук после действия игрока. */
  unlock() {
    // На iOS иначе Web Audio молчит при включённом переключателе «Без звука».
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
    this.ctx = new AudioContext();
    void this.ctx.resume();
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0;
    this.ctx.createMediaElementSource(this.music).connect(this.musicGain).connect(this.ctx.destination);
    // Запуск внутри жеста разрешает этому <audio> играть и позже, когда жеста уже не будет.
    this.music.play().then(
      () => this.musicWanted || this.music.pause(),
      () => {},
    );
  }

  musicReady(): Promise<void> {
    if (this.music.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) return Promise.resolve();
    return new Promise((resolve) => {
      this.music.addEventListener('canplaythrough', () => resolve(), { once: true });
      this.music.addEventListener('error', () => resolve(), { once: true });
      setTimeout(resolve, 8000);
    });
  }

  playMusic(level: 'normal' | 'quiet' = 'normal') {
    this.musicWanted = true;
    this.fadeMusic(level === 'quiet' ? MUSIC_QUIET : MUSIC_VOLUME, 0.4);
    if (this.music.paused) this.music.play().catch(() => {});
  }

  stopMusic() {
    this.musicWanted = false;
    this.fadeMusic(0, 0.2);
    setTimeout(() => this.musicWanted || this.music.pause(), 900);
  }

  private fadeMusic(volume: number, timeConstant: number) {
    const gain = this.musicGain.gain;
    const now = this.ctx.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.setTargetAtTime(volume, now, timeConstant);
  }

  /** Останавливает весь звук; часы контекста при этом стоят. */
  suspend() {
    if (!this.ctx) return;
    void this.ctx.suspend();
    this.music.pause();
  }

  async resume() {
    if (!this.ctx) return;
    await this.ctx.resume().catch(() => {});
    if (this.musicWanted && this.music.paused) this.music.play().catch(() => {});
  }

  load(url: string): Promise<AudioBuffer> {
    let buffer = this.buffers.get(url);
    if (!buffer) {
      buffer = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status} ${url}`);
          return r.arrayBuffer();
        })
        .then((data) => this.ctx.decodeAudioData(data));
      buffer.catch(() => this.buffers.delete(url));
      this.buffers.set(url, buffer);
      if (this.buffers.size > BUFFER_CACHE) this.buffers.delete(this.buffers.keys().next().value!);
    }
    return buffer;
  }

  play(buffer: AudioBuffer, offset = 0, duration?: number): Voice {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const ended = new Promise<void>((resolve) => (source.onended = () => resolve()));
    source.start(0, offset, duration);
    return {
      ended,
      stop: () => {
        try {
          source.stop();
        } catch {
          // Уже остановлен.
        }
      },
    };
  }

  sfx(kind: Sfx) {
    const t = this.ctx.currentTime;
    switch (kind) {
      case 'tick':
        this.tone(1250, t, 0.06, 'square', 0.05);
        break;
      case 'go':
        this.tone(660, t, 0.14, 'triangle', 0.18);
        this.tone(990, t + 0.11, 0.3, 'triangle', 0.18);
        break;
      case 'correct':
        this.tone(784, t, 0.14, 'sine', 0.22);
        this.tone(1175, t + 0.1, 0.3, 'sine', 0.22);
        break;
      case 'wrong':
        this.tone(233, t, 0.18, 'sawtooth', 0.07);
        this.tone(175, t + 0.15, 0.32, 'sawtooth', 0.07);
        break;
    }
  }

  private tone(freq: number, at: number, duration: number, type: OscillatorType, volume: number) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(at);
    osc.stop(at + duration + 0.05);
  }
}

export const audio = new GameAudio();
