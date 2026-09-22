export interface UserRecord {
  id: string;
  email: string;
}

const USERS: UserRecord[] = [{ id: 'u_1', email: 'user@example.test' }];

export function getUserByEmail(email: string): UserRecord | undefined {
  return USERS.find((user) => user.email === email);
}
