import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

/** `GET|POST /certificates` (U19, WP26a). Never carries the private key — Tyk's own `/tyk/certs`
 * response structurally cannot (`hasPrivate` is a boolean flag, not the key). */
export interface Certificate {
  id: string;
  commonName: string | null;
  fingerprint: string;
  hasPrivate: boolean;
  isCa: boolean;
  notBefore: string;
  notAfter: string;
}

export function useCertificates() {
  return useQuery({
    queryKey: queryKeys.certificates.all,
    queryFn: () => api.get<Certificate[]>('/certificates').then((res) => res.data),
  });
}

export function useUploadCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pem: string) => api.post<Certificate>('/certificates', { pem }).then((res) => res.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.certificates.all }),
  });
}

export function useDeleteCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ message: string }>(`/certificates/${encodeURIComponent(id)}`).then((res) => res.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.certificates.all }),
  });
}
