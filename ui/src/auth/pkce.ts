/**
 * PKCE (Proof Key for Code Exchange) utilities for OAuth 2.0 public clients.
 * Uses the Web Crypto API (browser-native, no dependencies).
 */

function base64urlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function bytesToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Generate a cryptographically random code verifier (32 bytes, base64url). */
export function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return base64urlEncode(bytes.buffer)
}

/** Generate the S256 code challenge from a code verifier. */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', encoded)
  return base64urlEncode(hash)
}

/** Generate a random state parameter for CSRF protection (16 bytes, hex). */
export function generateState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return bytesToHex(bytes.buffer)
}
