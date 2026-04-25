import { type NextRequest } from 'next/server';

/**
 * Simple in-memory rate limiter for API endpoints.
 * 
 * Uses a sliding window algorithm to track request counts per IP.
 * For production, consider using Redis or a dedicated rate-limiting service.
 */
class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(windowMs: number = 60000, maxRequests: number = 100) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    
    // Clean up old entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.requests.entries()) {
      const validTimestamps = timestamps.filter(t => now - t < this.windowMs);
      if (validTimestamps.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, validTimestamps);
      }
    }
  }

  check(identifier: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(identifier) || [];
    
    // Remove timestamps outside the window
    const validTimestamps = timestamps.filter(t => now - t < this.windowMs);
    
    if (validTimestamps.length >= this.maxRequests) {
      return false;
    }
    
    validTimestamps.push(now);
    this.requests.set(identifier, validTimestamps);
    return true;
  }

  getRemainingRequests(identifier: string): number {
    const now = Date.now();
    const timestamps = this.requests.get(identifier) || [];
    const validTimestamps = timestamps.filter(t => now - t < this.windowMs);
    return Math.max(0, this.maxRequests - validTimestamps.length);
  }
}

// Singleton instances for different rate limits
export const apiRateLimiter = new RateLimiter(60000, 100); // 100 requests per minute
export const strictRateLimiter = new RateLimiter(60000, 10); // 10 requests per minute
export const webhookRateLimiter = new RateLimiter(60000, 1000); // 1000 requests per minute

export function getClientIdentifier(req: NextRequest): string {
  // Use IP address as identifier
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] 
    || req.headers.get('x-real-ip') 
    || 'unknown';
  return ip;
}

export function checkRateLimit(
  req: NextRequest,
  limiter: RateLimiter = apiRateLimiter
): { allowed: boolean; remaining: number } {
  const identifier = getClientIdentifier(req);
  const allowed = limiter.check(identifier);
  const remaining = limiter.getRemainingRequests(identifier);
  return { allowed, remaining };
}
