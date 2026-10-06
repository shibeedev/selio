export interface AuthNonceRow {
  nonce: string;
  address: string;
  expiresAt: number;
}

/** `tokenHash` is the SHA-256 of the session token in hex; the token itself is never stored. */
export interface AuthSessionRow {
  tokenHash: string;
  owner: string;
  createdAt: number;
  expiresAt: number;
}
