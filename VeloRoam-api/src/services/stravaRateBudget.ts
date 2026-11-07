/** Track observed application-wide limits; leave headroom for the interactive app. */
export class StravaRateBudget {
  private windows: Array<{ end: number; usage: number; ceiling: number }> = [];
  private retryUntil = 0;
  constructor(private readonly now: () => number = Date.now) {}

  observe(headers: Record<string, unknown>, status: number): void {
    const now = this.now();
    const quarterEnd = (Math.floor(now / 900000) + 1) * 900000;
    const dayEnd = (Math.floor(now / 86400000) + 1) * 86400000;
    const next: typeof this.windows = [];
    for (const prefix of ['x-readratelimit', 'x-ratelimit']) {
      const limits = String(headers[`${prefix}-limit`] ?? '').split(',').map(Number);
      const usage = String(headers[`${prefix}-usage`] ?? '').split(',').map(Number);
      if (limits.length !== 2 || usage.length !== 2
        || limits.some(v => !Number.isFinite(v) || v <= 0)
        || usage.some(v => !Number.isFinite(v) || v < 0)) continue;
      next.push({ end: quarterEnd + 3000, usage: usage[0], ceiling: Math.max(1, Math.floor(limits[0] * 0.9)) });
      next.push({ end: dayEnd + 3000, usage: usage[1], ceiling: Math.max(1, Math.floor(limits[1] * 0.98)) });
    }
    if (next.length) this.windows = next;
    if (status === 429) {
      const retry = headers['retry-after'];
      const seconds = Number(retry);
      const until = retry !== undefined && Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(String(retry));
      this.retryUntil = Number.isFinite(until) && until > now ? until + 3000 : quarterEnd + 3000;
    }
  }

  nextAllowedAt(): number {
    const now = this.now();
    return Math.max(now, this.retryUntil, ...this.windows.filter(w => w.end > now && w.usage >= w.ceiling).map(w => w.end));
  }
}
