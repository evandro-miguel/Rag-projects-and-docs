import { loginUser } from './service';

export function handleLoginRequest(email: string, password: string) {
  const result = loginUser({ email, password });
  return {
    status: 200,
    body: { token: result.sessionToken },
  };
}
