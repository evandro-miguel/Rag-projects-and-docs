export interface LoginInput {
  email: string;
  password: string;
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 8;

function hashPassword(password: string): string {
  return `hash:${password}`;
}

export function issueSessionToken(userId: string): string {
  const issuedAt = Date.now();
  return `session:${userId}:${issuedAt}`;
}

export function loginUser(input: LoginInput) {
  const passwordHash = hashPassword(input.password);
  const sessionToken = issueSessionToken(input.email);
  return {
    passwordHash,
    sessionToken,
    expiresInMs: SESSION_TTL_MS,
  };
}
