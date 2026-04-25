import { type NextResponse } from 'next/server';

/**
 * Apply security headers to a NextResponse.
 * 
 * Headers include:
 * - X-Content-Type-Options: nosniff - Prevents MIME type sniffing
 * - X-Frame-Options: DENY - Prevents clickjacking
 * - X-XSS-Protection: 1; mode=block - XSS protection
 * - Referrer-Policy: strict-origin-when-cross-origin - Controls referrer information
 * - Permissions-Policy: Controls which browser features can be used
 * 
 * @param response The NextResponse to apply headers to
 * @returns The response with security headers applied
 */
export function applySecurityHeaders(response: NextResponse): NextResponse {
  // Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');
  
  // Prevent clickjacking
  response.headers.set('X-Frame-Options', 'DENY');
  
  // Enable XSS protection
  response.headers.set('X-XSS-Protection', '1; mode=block');
  
  // Control referrer information
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Permissions-Policy to restrict browser features
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()'
  );
  
  // Content Security Policy (basic for now, can be enhanced)
  if (process.env.NODE_ENV === 'production') {
    response.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:;"
    );
  }
  
  return response;
}

/**
 * Apply CORS headers for API routes.
 * 
 * @param response The NextResponse to apply headers to
 * @param origin The allowed origin (default: *)
 * @returns The response with CORS headers applied
 */
export function applyCorsHeaders(
  response: NextResponse,
  origin: string = '*'
): NextResponse {
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key, X-Request-ID');
  response.headers.set('Access-Control-Max-Age', '86400');
  
  return response;
}
