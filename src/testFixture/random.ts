const DEFAULT_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export const random = {
  int(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  },
  float(min: number, max: number): number {
    return Math.random() * (max - min) + min;
  },
  bool(p = 0.5): boolean {
    return Math.random() < p;
  },
  choice<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("random.choice: empty array");
    return arr[Math.floor(Math.random() * arr.length)]!;
  },
  from<T>(iter: Iterable<T>): T {
    return random.choice(Array.from(iter));
  },
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
    if (items.length === 0) throw new Error("random.weighted: empty");
    let total = 0;
    for (const [, w] of items) total += w;
    let r = Math.random() * total;
    for (const [v, w] of items) {
      r -= w;
      if (r < 0) return v;
    }
    return items[items.length - 1]![0];
  },
  string(len: number, alphabet: string = DEFAULT_ALPHABET): string {
    let out = "";
    for (let i = 0; i < len; i++) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
  },
  uuid(): string {
    return crypto.randomUUID();
  },
  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  },
};
