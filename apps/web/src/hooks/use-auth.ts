import { useMe } from './use-me';

export function useAuth() {
  const { data: user, isLoading } = useMe();
  return { user, isLoading, isAuthenticated: !!user };
}
