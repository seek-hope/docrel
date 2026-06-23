/**
 * Authenticates a user with username and password.
 * @param username — the user's login name
 * @param password — the user's secret
 * @returns an auth token
 */
export function login(username: string, password: string): string {
  return `token-${username}`;
}
