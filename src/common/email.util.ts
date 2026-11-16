export const normalizeEmail = (email: string) => email.trim().toLowerCase();

// Exact domain match: `uts.edu.co.example.com` and unlisted subdomains are rejected.
export function hasEmailDomain(email: string, domain: string): boolean {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  return (
    at > 0 &&
    normalized.indexOf('@') === at &&
    normalized.slice(at + 1) === domain.trim().toLowerCase()
  );
}
