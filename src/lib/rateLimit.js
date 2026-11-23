'use strict';

/**
 * Small fixed-window rate limiter kept in memory (fine for a single server process).
 * `key(req)` decides what is counted, e.g. the client IP or the signed-in staff user.
 */
function rateLimit({ windowMs, max, key = (req) => req.ip, onLimit }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  timer.unref();

  return function rateLimitMiddleware(req, res, next) {
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return onLimit(req, res, retryAfter);
    }
    return next();
  };
}

module.exports = { rateLimit };
